'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, run, transaction } = require('../db/database');
const tid = req => req.user.tenantId;

// GET /api/reconciliation
router.get('/', (req, res) => {
  const t = tid(req);
  const { status, from, to, limit=50, offset=0 } = req.query;

  let sql = `
    SELECT tx.id, tx.date, tx.description, tx.amount, tx.flow, tx.status,
      tx.source, tx.created_by, tx.import_hash,
      tx.installment_group, tx.installment_number, tx.installment_total, tx.installment_amount,
      tx.is_merged, tx.merged_from,
      a.name as account_name, a.bank as account_bank, a.type as account_type,
      e.label as entity_label,
      cat.name as category_name, cat.icon as category_icon,
      r.id as rec_id, r.status as rec_status,
      r.responsible_name, r.responsible_type, r.notes as rec_notes,
      r.installment_qty, r.installment_value,
      cr.name as creator_name
    FROM transactions tx
    LEFT JOIN accounts a ON a.id=tx.account_id
    LEFT JOIN entities e ON e.id=tx.entity_id
    LEFT JOIN categories cat ON cat.id=tx.category_id
    LEFT JOIN reconciliation r ON r.transaction_id=tx.id
    LEFT JOIN users cr ON cr.id=tx.created_by
    WHERE tx.tenant_id=? AND tx.status != 'debt' AND tx.is_merged=0
  `;
  const params = [t];
  if (status === 'pending')    { sql += ` AND (r.id IS NULL OR r.status='pending')`; }
  else if (status === 'reconciled') { sql += ` AND r.status='reconciled'`; }
  if (from) { sql += ` AND tx.date>=?`; params.push(from); }
  if (to)   { sql += ` AND tx.date<=?`; params.push(to); }
  sql += ` ORDER BY tx.date DESC, tx.created_at DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));

  const rows  = query(sql, params);
  const total = queryOne(`SELECT COUNT(*) as n FROM transactions tx
    LEFT JOIN reconciliation r ON r.transaction_id=tx.id
    WHERE tx.tenant_id=? AND tx.status!='debt' AND tx.is_merged=0`, [t]).n;

  // Para cada tx com installment_group, busca o grupo completo
  const groups = {};
  rows.filter(r => r.installment_group).forEach(r => {
    if (!groups[r.installment_group]) {
      groups[r.installment_group] = query(
        `SELECT id, date, amount, installment_number, status FROM transactions
         WHERE tenant_id=? AND installment_group=? ORDER BY installment_number`,
        [t, r.installment_group]
      );
    }
    r.installment_siblings = groups[r.installment_group];
  });

  res.json({ total, transactions: rows });
});

// GET /api/reconciliation/similar/:txId — busca transações similares para mesclar
router.get('/similar/:txId', (req, res) => {
  const t = tid(req);
  const tx = queryOne('SELECT * FROM transactions WHERE id=? AND tenant_id=?', [req.params.txId, t]);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });

  // Busca por descrição similar e valor próximo (±10%) dentro de 60 dias
  const norm = (tx.description||'').toLowerCase().replace(/\s+/g,' ').trim().slice(0,30);
  const minAmt = tx.amount * 0.90;
  const maxAmt = tx.amount * 1.10;
  const dateFrom = new Date(tx.date); dateFrom.setDate(dateFrom.getDate()-30);
  const dateTo   = new Date(tx.date); dateTo.setDate(dateTo.getDate()+30);

  const similar = query(`
    SELECT tx2.id, tx2.date, tx2.description, tx2.amount, tx2.flow, tx2.status,
      tx2.source, a.name as account_name
    FROM transactions tx2
    LEFT JOIN accounts a ON a.id=tx2.account_id
    WHERE tx2.tenant_id=? AND tx2.id!=? AND tx2.is_merged=0
      AND tx2.flow=? AND tx2.amount BETWEEN ? AND ?
      AND tx2.date BETWEEN ? AND ?
    ORDER BY ABS(tx2.amount - ?) ASC
    LIMIT 10
  `, [t, tx.id, tx.flow, minAmt, maxAmt,
      dateFrom.toISOString().slice(0,10), dateTo.toISOString().slice(0,10),
      tx.amount]);

  res.json({ original: tx, similar });
});

// POST /api/reconciliation/merge — mesclar transações duplicadas
router.post('/merge', (req, res) => {
  const t = tid(req);
  const { keep_id, merge_ids } = req.body; // keep_id = transação principal, merge_ids = duplicadas
  if (!keep_id || !merge_ids?.length) return res.status(400).json({ error: 'keep_id e merge_ids obrigatórios' });

  const keeper = queryOne('SELECT * FROM transactions WHERE id=? AND tenant_id=?', [keep_id, t]);
  if (!keeper) return res.status(404).json({ error: 'Transação principal não encontrada' });

  transaction(() => {
    // Marca as duplicatas como mescladas
    merge_ids.forEach(id => {
      run(`UPDATE transactions SET is_merged=1, merged_from=NULL WHERE id=? AND tenant_id=?`, [id, t]);
      // Transfere reconciliação se existir
      const r = queryOne('SELECT id FROM reconciliation WHERE transaction_id=?', [id]);
      if (r) run('DELETE FROM reconciliation WHERE transaction_id=?', [id]);
    });

    // Registra quais foram mescladas no registro principal
    const existing = queryOne('SELECT merged_from FROM transactions WHERE id=?', [keep_id]);
    const prev = existing?.merged_from ? JSON.parse(existing.merged_from) : [];
    run('UPDATE transactions SET merged_from=? WHERE id=?',
      [JSON.stringify([...prev, ...merge_ids]), keep_id]);
  });

  res.json({ ok: true, kept: keep_id, merged: merge_ids.length });
});

// POST /api/reconciliation/:txId — conciliar com parcelas
router.post('/:txId', (req, res) => {
  const t = tid(req);
  const { responsible_id, responsible_type, responsible_name, notes,
    installment_qty, installment_value, mark_group } = req.body;

  const tx = queryOne('SELECT id,created_by,installment_group FROM transactions WHERE id=? AND tenant_id=?',
    [req.params.txId, t]);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });

  const respName = responsible_name ||
    queryOne('SELECT name FROM users WHERE id=?', [responsible_id||tx.created_by])?.name || 'Titular';

  // Se informou parcelas e não tem grupo ainda, cria o grupo
  if (installment_qty && installment_qty > 1 && !tx.installment_group) {
    const groupId = `INST-${Date.now()}-${tx.id.slice(0,8)}`;
    run('UPDATE transactions SET installment_group=?, installment_number=1, installment_total=?, installment_amount=? WHERE id=?',
      [groupId, installment_qty, installment_value||tx.amount, tx.id]);

    // Aplica o mesmo grupo a transações futuras similares do mesmo valor
    if (mark_group) {
      const desc_norm = (tx.description||'').toLowerCase().slice(0,30);
      const futuras = query(`
        SELECT id FROM transactions
        WHERE tenant_id=? AND id!=? AND flow=? AND amount BETWEEN ? AND ?
          AND date > ? AND is_merged=0 AND installment_group IS NULL
        ORDER BY date ASC LIMIT ?
      `, [t, tx.id, tx.flow,
          (tx.amount||0)*0.97, (tx.amount||0)*1.03,
          tx.date, installment_qty - 1]);

      futuras.forEach((f, idx) => {
        run('UPDATE transactions SET installment_group=?, installment_number=?, installment_total=?, installment_amount=? WHERE id=?',
          [groupId, idx+2, installment_qty, installment_value||tx.amount, f.id]);
      });
    }
  }

  // Salva reconciliação
  const existing = queryOne('SELECT id FROM reconciliation WHERE transaction_id=?', [req.params.txId]);
  if (existing) {
    run(`UPDATE reconciliation SET responsible_id=?,responsible_type=?,responsible_name=?,
      notes=?,status='reconciled',reconciled_at=datetime('now'),
      installment_qty=?,installment_value=? WHERE id=?`,
      [responsible_id||null, responsible_type||'user', respName, notes||null,
       installment_qty||null, installment_value||null, existing.id]);
  } else {
    run(`INSERT INTO reconciliation
      (id,tenant_id,transaction_id,responsible_id,responsible_type,responsible_name,notes,status,reconciled_at,installment_qty,installment_value)
      VALUES (?,?,?,?,?,?,?,'reconciled',datetime('now'),?,?)`,
      [uuidv4(), t, req.params.txId, responsible_id||null, responsible_type||'user',
       respName, notes||null, installment_qty||null, installment_value||null]);
  }

  res.json({ ok: true });
});

// GET /api/reconciliation/users
router.get('/users', (req, res) => {
  const t = tid(req);
  const owner   = queryOne('SELECT u.id, u.name, u.email FROM users u JOIN tenants ten ON ten.owner_id=u.id WHERE ten.id=?', [t]);
  const members = query(`SELECT u.id, u.name, u.email FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=? AND tm.status='active'`, [t]);
  const entities= query(`SELECT id, label as name, 'entity' as type FROM entities WHERE tenant_id=?`, [t]);
  res.json({ users: [owner, ...members].filter(Boolean), entities });
});

// GET /api/reconciliation/card-forecast — previsão de gastos por cartão (parcelas futuras)
router.get('/card-forecast', (req, res) => {
  const t = tid(req);
  const months = parseInt(req.query.months) || 6;

  const today = new Date();
  const results = [];

  for (let i = 0; i < months; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const monthStr = d.toISOString().slice(0, 7); // YYYY-MM
    const monthStart = `${monthStr}-01`;
    const monthEnd   = new Date(d.getFullYear(), d.getMonth()+1, 0).toISOString().slice(0,10);

    // Transações reais do mês (cartão de crédito)
    const real = queryOne(`
      SELECT COALESCE(SUM(tx.amount),0) as total, COUNT(*) as count
      FROM transactions tx
      JOIN accounts a ON a.id=tx.account_id
      WHERE tx.tenant_id=? AND a.type='credit' AND tx.flow='out'
        AND tx.date BETWEEN ? AND ? AND tx.is_merged=0
    `, [t, monthStart, monthEnd]);

    // Parcelas conhecidas (installment_group) previstas para o mês
    const parcelas = queryOne(`
      SELECT COALESCE(SUM(installment_amount),0) as total, COUNT(*) as count
      FROM transactions
      WHERE tenant_id=? AND installment_group IS NOT NULL
        AND date BETWEEN ? AND ? AND is_merged=0
    `, [t, monthStart, monthEnd]);

    // Contas a pagar (bills) do mês
    const bills = queryOne(`
      SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count
      FROM bills
      WHERE tenant_id=? AND due_date BETWEEN ? AND ? AND status NOT IN('paid','debt')
    `, [t, monthStart, monthEnd]);

    results.push({
      month: monthStr,
      real_transactions: parseFloat((real.total||0).toFixed(2)),
      real_count: real.count,
      installment_forecast: parseFloat((parcelas.total||0).toFixed(2)),
      installment_count: parcelas.count,
      bills_forecast: parseFloat((bills.total||0).toFixed(2)),
      bills_count: bills.count,
      total_forecast: parseFloat(((real.total||0) + (parcelas.total||0) + (bills.total||0)).toFixed(2)),
    });
  }

  res.json({ months: results });
});

module.exports = router;
