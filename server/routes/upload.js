'use strict';
const router = require('express').Router();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, run, transaction } = require('../db/database');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname).toLowerCase()),
});
const upload = multer({
  storage,
  limits: { fileSize: 10*1024*1024, files: 10 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.ofx','.csv','.txt'].includes(ext)) return cb(new Error('Use .ofx ou .csv'));
    cb(null, true);
  },
});

function guessCategory(desc) {
  const d = (desc||'').toLowerCase();
  if (/netflix|spotify|amazon prime|hbo|disney|deezer|globoplay|youtube premium/.test(d)) return 'Entretenimento';
  if (/salário|salario|vencimento|honorário|pagamento efetuado/.test(d))                  return 'Salário CLT';
  if (/mercado|supermercado|restaurante|ifood|rappi|burger|padaria|açougue/.test(d))      return 'Alimentação';
  if (/aluguel|condomínio|iptu|financiamento imóv/.test(d))                               return 'Moradia';
  if (/energia|água|internet|telefone|claro|vivo|tim|oi|enel|sabesp/.test(d))             return 'Utilidades';
  if (/farmácia|hospital|médico|plano|saúde|academia|smart fit|bluefit/.test(d))          return 'Saúde';
  if (/das |fgts|inss|irrf|cofins|pis|imposto|tributo/.test(d))                           return 'Impostos';
  if (/uber|99|taxi|posto|gasolina|combustível|estacionamento|pedágio/.test(d))           return 'Transporte';
  if (/escola|faculdade|curso|livro|educação|ensino/.test(d))                             return 'Educação';
  if (/roupa|moda|sapato|vestuário/.test(d))                                              return 'Compras';
  return 'Outros';
}
function isRecurrent(desc) {
  return /netflix|spotify|amazon|hbo|disney|academia|aluguel|energia|internet|telefone|plano|das |inss|fgts|seguro|mensalidade/.test((desc||'').toLowerCase());
}
function txHash(date, amount, flow, desc) {
  return `${date}|${amount.toFixed(2)}|${flow}|${(desc||'').slice(0,40).toLowerCase().trim()}`;
}

// ── Resolve ou cria conta vinculada ao arquivo ────────────────────────────────
async function resolveOrCreateAccount(tenantId, bankName, accountType, entityId) {
  const typeMap = {'Conta Corrente':'checking','Poupança':'savings','Cartão de Crédito':'credit','Conta Empresarial':'checking'};
  const type = typeMap[accountType] || 'checking';

  // Tenta achar conta com mesmo banco + tipo
  const existing = await queryOne(
    `SELECT id FROM accounts WHERE tenant_id=? AND bank LIKE ? AND type=? LIMIT 1`,
    [tenantId, `%${bankName.slice(0,30)}%`, type]
  );
  if (existing) return existing.id;

  // Cria nova conta
  const newId = uuidv4();
  const colors = { checking:'#0077ff', credit:'#ff4d6d', savings:'#00e5a0', investment:'#f7c948' };
  await run(`INSERT INTO accounts (id,tenant_id,entity_id,name,bank,type,balance,color) VALUES (?,?,?,?,?,?,0,?)`,
    [newId, tenantId, entityId||null, bankName, bankName, type, colors[type]||'#0077ff']);
  console.log(`[upload] Created account: ${bankName} (${type})`);
  return newId;
}

async function resolveCategoryId(tenantId, name) {
  return await queryOne(`SELECT id FROM categories WHERE tenant_id=? AND name=? LIMIT 1`, [tenantId, name])?.id || null;
}

// ── Parser OFX ────────────────────────────────────────────────────────────────
function parseOFX(content, bankName) {
  const txs    = [];
  const blocks = content.match(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi) || [];
  const fiName = (content.match(/<FI>\s*<ORG>([^<]+)/) || [])[1]?.trim() || bankName || 'Banco';
  const accId  = (content.match(/<ACCTID>([^<\r\n]+)/) || [])[1]?.trim() || '';
  const accType= (content.match(/<ACCTTYPE>([^<\r\n]+)/) || [])[1]?.trim() || '';
  // OFX: CHECKING, SAVINGS, CREDITLINE, MONEYMRKT
  const typeMap = { CHECKING:'Conta Corrente', SAVINGS:'Poupança', CREDITLINE:'Cartão de Crédito', CREDIT:'Cartão de Crédito' };
  const detectedType = typeMap[accType?.toUpperCase()] || 'Conta Corrente';

  blocks.forEach(block => {
    const get = tag => { const m = block.match(new RegExp('<'+tag+'>([^<\n\r]+)')); return m ? m[1].trim() : ''; };
    const fitid  = get('FITID');
    const dtRaw  = get('DTPOSTED');
    const date   = dtRaw ? `${dtRaw.slice(0,4)}-${dtRaw.slice(4,6)}-${dtRaw.slice(6,8)}` : new Date().toISOString().slice(0,10);
    const amtRaw = parseFloat(get('TRNAMT') || '0');
    if (!amtRaw) return;
    const desc = (get('MEMO') || get('NAME') || 'Transação').slice(0, 200);
    txs.push({ fitid, date, desc, amount: Math.round(Math.abs(amtRaw)*100)/100,
      flow: amtRaw >= 0 ? 'in' : 'out', category: guessCategory(desc),
      recurrent: isRecurrent(desc), source: 'ofx' });
  });
  return { txs, bankName: fiName, detectedType, accountRef: accId };
}

// ── Parser CSV ────────────────────────────────────────────────────────────────
function parseCSV(content, bankName, accountType) {
  const txs   = [];
  const lines = content.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  if (lines.length < 2) return { txs, bankName, detectedType: accountType };
  const sep = lines[0].includes(';') ? ';' : ',';

  lines.slice(1).forEach((line, i) => {
    const cols = line.split(sep).map(c => c.replace(/^["']|["']$/g,'').trim());
    if (cols.length < 2) return;
    let date = cols[0];
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) { const [d,m,y]=date.split('/'); date=`${y}-${m}-${d}`; }
    else if (/^\d{2}\/\d{2}\/\d{2}$/.test(date)) { const [d,m,y]=date.split('/'); date=`20${y}-${m}-${d}`; }
    const desc   = (cols[1]||`Linha ${i+2}`).slice(0, 200);
    const rawAmt = (cols[2]||cols[3]||'0').replace(/\./g,'').replace(',','.').replace(/[^0-9.\-]/g,'');
    const amtRaw = parseFloat(rawAmt);
    if (isNaN(amtRaw)||amtRaw===0) return;
    txs.push({ fitid:null, date, desc, amount: Math.round(Math.abs(amtRaw)*100)/100,
      flow: amtRaw >= 0 ? 'in' : 'out', category: guessCategory(desc),
      recurrent: isRecurrent(desc), source: 'csv' });
  });
  return { txs, bankName, detectedType: accountType };
}

// ── POST /api/upload/statement ────────────────────────────────────────────────
// Campos do form:
//   files[]        — arquivos
//   bank           — nome do banco (override do detectado no OFX)
//   entity         — entity_id vinculado
//   type           — tipo da conta (override)
//   responsible_user — user_id do responsável (default: usuário logado)
router.post('/statement', upload.array('files', 10), async (req, res) => {
  if (!req.files||!req.files.length) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const tenantId       = req.user.tenantId;
  const createdBy      = req.user.id;
  const entityId       = req.body.entity || null;
  const responsibleId  = req.body.responsible_user || req.user.id;
  const forceBank      = (req.body.bank||'').trim();
  const forceType      = (req.body.type||'').trim();

  // Resolve nome do responsável para conciliação
  const responsibleUser = await queryOne('SELECT name FROM users WHERE id=?', [responsibleId]);
  const responsibleName = responsibleUser?.name || 'Usuário';

  let totalImported = 0, totalSkipped = 0;
  const errors = [];
  const accountsCreated = [];

  for (const file of req.files) {
    try {
      const raw = fs.readFileSync(file.path, 'latin1');
      const ext = path.extname(file.originalname).toLowerCase();

      let parsed;
      if (ext === '.ofx') {
        parsed = parseOFX(raw, forceBank || path.basename(file.originalname, '.ofx'));
      } else {
        parsed = parseCSV(raw, forceBank || path.basename(file.originalname, '.csv'), forceType||'Conta Corrente');
      }

      const usedBank = forceBank || parsed.bankName;
      const usedType = forceType || parsed.detectedType;

      // Resolve / cria a conta bancária PARA ESTE ARQUIVO
      const accountId = await resolveOrCreateAccount(tenantId, usedBank, usedType, entityId);
      if (!accountsCreated.find(a => a.id === accountId)) {
        const acc = await queryOne('SELECT name,bank,type FROM accounts WHERE id=?', [accountId]);
        if (acc) accountsCreated.push({ id: accountId, ...acc });
      }

      let fileImported = 0, fileSkipped = 0;

      await transaction(async (client) => {
        for (const tx of parsed.txs) {
          const hash = txHash(tx.date, tx.amount, tx.flow, tx.desc);
          if (await queryOne('SELECT id FROM transactions WHERE tenant_id=? AND import_hash=?', [tenantId, hash])) {
            fileSkipped++; return;
          }

          const catId  = await resolveCategoryId(tenantId, tx.category);
          const txId   = uuidv4();

          await run(`INSERT INTO transactions
            (id,tenant_id,account_id,entity_id,category_id,
             description,amount,flow,status,date,
             is_recurring,source,import_hash,created_by,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
            [txId, tenantId, accountId, entityId||null, catId,
             tx.desc, tx.amount, tx.flow, 'paid', tx.date,
             tx.recurrent?1:0, tx.source, hash, createdBy]);

          // Cria registro de conciliação com responsável padrão
          await run(`INSERT INTO reconciliation
            (id,tenant_id,transaction_id,responsible_id,responsible_type,responsible_name,status)
            VALUES (?,?,?,?,'user',?,'pending')`,
            [uuidv4(), tenantId, txId, responsibleId, responsibleName]);

          fileImported++;
        }
      });

      totalImported += fileImported;
      totalSkipped  += fileSkipped;

    } catch(err) {
      errors.push({ file: file.originalname, error: err.message });
    } finally {
      try { fs.unlinkSync(file.path); } catch {}
    }
  }

    res.json({
    imported: totalImported,
    skipped:  totalSkipped,
    errors,
    accounts_used: accountsCreated,
    message: `${totalImported} transação(ões) importada(s)${totalSkipped>0?`, ${totalSkipped} duplicata(s) ignorada(s)`:''}`,
  });
});

module.exports = router;

// ── POST /api/upload/interpret-photo — interpreta comprovante por foto ─────────
router.post('/interpret-photo', async (req, res) => {
  try {
    const { image, media_type } = req.body;
    if (!image) return res.status(400).json({ error: 'image obrigatório' });

    // Chama Anthropic API para interpretar a imagem
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: media_type||'image/jpeg', data: image }
            },
            {
              type: 'text',
              text: 'Analise este comprovante de pagamento/compra. Extraia APENAS em JSON: {"amount": number, "description": "string", "date": "YYYY-MM-DD", "establishment": "string"}. Se não conseguir identificar algum campo, omita-o. Responda APENAS com o JSON, sem texto adicional.'
            }
          ]
        }]
      }),
    });

    if (!anthropicRes.ok) {
      return res.json({ error: 'Serviço de interpretação indisponível' });
    }

    const aiData = await anthropicRes.json();
    const text = aiData.content?.[0]?.text || '{}';
    try {
      const clean = text.replace(/```json|```/g,'').trim();
      const parsed = JSON.parse(clean);
      return res.json(parsed);
    } catch {
      return res.json({});
    }
  } catch(err) {
    res.json({});
  }
});
