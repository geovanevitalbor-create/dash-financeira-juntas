// sync.js — Sincroniza dados da API do sistema legado (Firebird/Delphi)
// para o Supabase. Roda via GitHub Actions (.github/workflows/sync-vendas.yml).
//
// Modo "incremental" (a cada 15 min): revisita só as últimas páginas de
// T_VENDAS e T_ITENSVENDA, com margem de segurança (REWIND_PAGES), pra
// pegar tanto vendas novas quanto edições recentes (status, separação,
// romaneio) sem varrer a tabela inteira a cada execução.
//
// Modo "full" (1x por dia, de madrugada): pagina a tabela inteira do
// zero para as três tabelas, garantindo que nenhuma edição antiga
// escapou da janela do modo incremental. É também o único modo que
// sincroniza T_PRODUTO, já que cadastro de produto muda raramente.
//
// Rodar manualmente pela primeira vez com MODE=full (via workflow_dispatch)
// é OBRIGATÓRIO antes de deixar o agendamento normal assumir — senão o
// espelho começa vazio e o modo incremental sozinho nunca busca o
// histórico desde 2009.

const axios = require('axios');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const API_BASE = 'https://170.231.150.66/api/ven';
const API_KEY = process.env.FIREBIRD_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MODE = process.env.SYNC_MODE || 'incremental';

const PAGE_SIZE = 500;      // confirmado como o máximo aceito pela API
const REWIND_PAGES = 4;     // margem de segurança no modo incremental (~2000 vendas)

if (!API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltam variáveis de ambiente obrigatórias (FIREBIRD_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}

// O certificado desse servidor não passa em validação padrão (confirmado
// manualmente via curl -k). Sem isso, toda chamada falha com erro de TLS.
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchPage(table, offset) {
  const url = `${API_BASE}/${table}?limit=${PAGE_SIZE}&offset=${offset}`;
  const res = await axios.get(url, {
    headers: { 'x-api-key': API_KEY },
    httpsAgent,
    timeout: 30000,
  });
  return res.data.data || [];
}

// Busca a tabela a partir de um offset até vir uma página menor que o limite
// (fim dos dados). Com startOffset=0 isso é um full scan da tabela inteira.
async function fetchAllFrom(table, startOffset = 0) {
  let offset = startOffset;
  let all = [];
  while (true) {
    const page = await fetchPage(table, offset);
    all = all.concat(page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return { rows: all, finalOffset: offset };
}

// O caractere de substituição (U+FFFD, "�") que aparece em campos como
// OBS e NOMPRO indica perda de dado ORIGINADA NO SERVIDOR da API
// (charset mal configurado do lado deles) — não tem como recuperar a
// letra acentuada original a partir daqui. Só removemos o símbolo pra
// não poluir a tela; o dado original já foi perdido antes de chegar
// até nós, e isso não é corrigível neste script.
function limparTexto(v) {
  if (typeof v !== 'string') return v;
  const limpo = v.replace(/\uFFFD/g, '').trim();
  return limpo || null;
}

function limparCodpro(v) {
  return typeof v === 'string' ? v.trim() : v;
}

// UNIDADE às vezes vem corrompida (ex.: "]U" em vez de "UN"). Não existe
// lista oficial de unidades válidas nesse sistema, então descartamos só
// o que claramente não parece uma sigla de unidade.
function limparUnidade(v) {
  if (typeof v !== 'string') return v;
  const limpo = v.trim();
  if (!/^[A-Z0-9]{1,5}$/i.test(limpo)) {
    console.warn(`UNIDADE suspeita descartada: "${v}"`);
    return null;
  }
  return limpo;
}

// RETIRADO/ENTREGUE às vezes vêm "" em vez de "N".
function limparFlag(v) {
  if (v === '' || v === null || v === undefined) return 'N';
  return v;
}

function mapVenda(v) {
  return {
    codvenda: v.CODVENDA,
    codigo_cliente: v.CODIGO_CLIENTE,
    codrep: v.CODREP,
    codigo_veiculo: v.CODIGO_VEICULO,
    data: v.DATA,
    totalproduto: v.TOTALPRODUTO,
    tipovenda: v.TIPOVENDA,
    desc_perc_01: v.DESC_PERC_01,
    desc_perc_02: v.DESC_PERC_02,
    desc_perc_03: v.DESC_PERC_03,
    descontos: v.DESCONTOS,
    frete: v.FRETE,
    seguro: v.SEGURO,
    outras: v.OUTRAS,
    tipofrete: v.TIPOFRETE,
    adcional: v.ADCIONAL,
    totalvenda: v.TOTALVENDA,
    obs: limparTexto(v.OBS),
    totaldinheiro: v.TOTALDINHEIRO,
    totalcheque: v.TOTALCHEQUE,
    totaldeposito: v.TOTALDEPOSITO,
    totalprazo: v.TOTALPRAZO,
    comissao: v.COMISSAO,
    dataentrega: v.DATAENTREGA,
    separado: limparFlag(v.SEPARADO),
    datafechamento: v.DATAFECHAMENTO,
    dataromaneio: v.DATAROMANEIO,
    status_pedido: v.STATUS_PEDIDO,
    empresa: v.EMPRESA,
    tpedido: v.TPEDIDO,
    synced_at: new Date().toISOString(),
  };
}

function mapItem(i) {
  return {
    codvenda: i.CODVENDA,
    codpro: limparCodpro(i.CODPRO),
    qtde: i.QTDE,
    descontos: i.DESCONTOS,
    valorunitario: i.VALORUNITARIO,
    total: i.TOTAL,
    retirado: limparFlag(i.RETIRADO),
    entregue: limparFlag(i.ENTREGUE),
    qtde_entregue: i.QTDE_ENTREGUE,
    unidade: limparUnidade(i.UNIDADE),
    synced_at: new Date().toISOString(),
  };
}

function mapProduto(p) {
  return {
    codpro: limparCodpro(p.CODPRO),
    nompro: limparTexto(p.NOMPRO),
    status: p.STATUS,
    unidade: limparUnidade(p.UNIDADE),
    tipo: p.TIPO,
    vlr_venda: p.VLR_VENDA,
    custo: p.CUSTO,
    synced_at: new Date().toISOString(),
  };
}

async function upsert(tableName, rows, conflictCols) {
  if (rows.length === 0) return 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from(tableName).upsert(chunk, { onConflict: conflictCols });
    if (error) {
      console.error(`Erro no lote de ${tableName} (linhas ${i} a ${i + chunk.length}): ${error.message}`);
      if (error.details) console.error(`Detalhes: ${error.details}`);
      if (error.hint) console.error(`Dica do Postgres: ${error.hint}`);
      // Refaz esse lote linha por linha só pra identificar exatamente qual registro é o problema.
      for (const row of chunk) {
        const { error: rowError } = await supabase.from(tableName).upsert([row], { onConflict: conflictCols });
        if (rowError) {
          console.error(`>>> LINHA PROBLEMÁTICA em ${tableName}:`, JSON.stringify(row));
          console.error(`>>> Erro específico: ${rowError.message}${rowError.details ? ' | ' + rowError.details : ''}`);
        }
      }
      throw new Error(`Erro gravando em ${tableName}: ${error.message}`);
    }
  }
  return rows.length;
}

async function getLastOffset(table) {
  const { data } = await supabase
    .from('sync_control')
    .select('last_offset')
    .eq('table_name', table)
    .maybeSingle();
  return data?.last_offset || 0;
}

async function setSyncControl(table, mode, offset, rowsSynced) {
  await supabase.from('sync_control').upsert({
    table_name: table,
    last_synced_at: new Date().toISOString(),
    last_sync_mode: mode,
    last_offset: offset,
    rows_synced: rowsSynced,
  });
}

async function syncIncremental() {
  console.log('Modo incremental — revisitando as últimas páginas de vendas e itens.');

  const lastOffset = await getLastOffset('ven_vendas');
  const startOffset = Math.max(0, lastOffset - REWIND_PAGES * PAGE_SIZE);

  const { rows: vendas, finalOffset } = await fetchAllFrom('T_VENDAS', startOffset);
  await upsert('ven_vendas', vendas.map(mapVenda), 'codvenda');
  await setSyncControl('ven_vendas', 'incremental', finalOffset, vendas.length);
  console.log(`ven_vendas: ${vendas.length} linhas revisadas/atualizadas (offset ${startOffset} -> ${finalOffset}).`);

  const { rows: itens, finalOffset: finalOffsetItens } = await fetchAllFrom('T_ITENSVENDA', startOffset);
  await upsert('ven_itensvenda', itens.map(mapItem), 'codvenda,codpro');
  await setSyncControl('ven_itensvenda', 'incremental', finalOffsetItens, itens.length);
  console.log(`ven_itensvenda: ${itens.length} linhas revisadas/atualizadas.`);
}

async function syncFull() {
  console.log('Modo full — resync completo de vendas, itens e produto.');

  const { rows: vendas, finalOffset } = await fetchAllFrom('T_VENDAS', 0);
  await upsert('ven_vendas', vendas.map(mapVenda), 'codvenda');
  await setSyncControl('ven_vendas', 'full', finalOffset, vendas.length);
  console.log(`ven_vendas: ${vendas.length} linhas no total.`);

  const { rows: itens, finalOffset: finalOffsetItens } = await fetchAllFrom('T_ITENSVENDA', 0);
  await upsert('ven_itensvenda', itens.map(mapItem), 'codvenda,codpro');
  await setSyncControl('ven_itensvenda', 'full', finalOffsetItens, itens.length);
  console.log(`ven_itensvenda: ${itens.length} linhas no total.`);

  const { rows: produtos, finalOffset: finalOffsetProd } = await fetchAllFrom('T_PRODUTO', 0);
  await upsert('ven_produto', produtos.map(mapProduto), 'codpro');
  await setSyncControl('ven_produto', 'full', finalOffsetProd, produtos.length);
  console.log(`ven_produto: ${produtos.length} linhas no total.`);
}

(async () => {
  try {
    if (MODE === 'full') {
      await syncFull();
    } else {
      await syncIncremental();
    }
    console.log('Sincronização concluída com sucesso.');
  } catch (err) {
    console.error('Falha na sincronização:', err.message);
    process.exit(1);
  }
})();
