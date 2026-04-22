'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, run, transaction } = require('../db/database');
const tid = req => req.user.tenantId;

// GET /api/bills — lista contas a pagar com filtros
router.get('/', (req, res) => {
  const t = tid(req);
  const { status, from, to, filter } = req.query;
  const now   = new Date().toISOString().slice(0,10);
  const week  = new Date(); week.setDate(week.getDate()+7);
  const month = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).toISOString().slice(0,10);

  let sql = `
    SELECT b.*, a.name as account_name, a.bank as account_bank,
      e.label as entity_label, cat.name as category_name, cat.icon as category_icon
    FROM bills b
    LEFT JOIN accounts a ON a.id=b.account_id
    LEFT JOIN entities e ON e.id=b.entity_id
    LEFT JOIN categories cat ON cat.id=b.category_id
    WHERE b.tenant_id=?
  `;
  const params = [t];

  // Auto-mark overdue
  run(`UPDATE bills SET status='overdue' WHERE tenant_id=? AND due_date < ? AND status='pending'`, [t, now]);

  if (status)       { sql += ` AND b.status=?`;    params.push(status); }
  if (from)         { sql += ` AND b.due_date>=?`; params.push(from); }
  if (to)           { sql += ` AND b.due_date<=?`; params.push(to); }
  if (filter === 'today') { sql += ` AND (b.due_date=? OR b.status='overdue') AND b.status!='paid' AND b.status!='debt'`; params.push(now); }
  else if (filter === 'week')  { sql += ` AND b.due_date<=? AND b.status NOT IN('paid','debt')`; params.push(week.toISOString().slice(0,10)); }
  else if (filter === 'month') { sql += ` AND b.due_date<=? AND b.status NOT IN('paid','debt')`; params.push(month); }
  else if (!status) { sql += ` AND b.status NOT IN('paid')`; }

  sql += ` ORDER BY b.due_date ASC, b.created_at DESC`;

  const rows  = query(sql, params);
  const totals = queryOne(`SELECT
    COALESCE(SUM(CASE WHEN status='pending'  THEN amount ELSE 0 END),0) as pending,
    COALESCE(SUM(CASE WHEN status='overdue'  THEN amount ELSE 0 END),0) as overdue,
    COALESCE(SUM(CASE WHEN status='paid'     THEN amount ELSE 0 END),0) as paid,
    COALESCE(SUM(CASE WHEN status='debt'     THEN amount ELSE 0 END),0) as debt
    FROM bills WHERE tenant_id=?`, [t]);

  res.json({ bills: rows, totals });
});

// POST /api/bills — criar conta a pagar (e parcelas se installments > 1)
router.post('/', (req, res) => {
  const t = tid(req);
  const { description, amount, due_date, status, account_id, entity_id, category_id,
    recurrence, installments = 1, notes } = req.body;
  if (!description || !amount || !due_date)
    return res.status(400).json({ error: 'description, amount e due_date são obrigatórios' });

  const n = parseInt(installments) || 1;
  const created = [];

  transaction(() => {
    for (let i = 0; i < n; i++) {
      // Calcula data de vencimento de cada parcela
      const dueD = new Date(due_date);
      dueD.setMonth(dueD.getMonth() + i);
      const id = uuidv4();
      run(`INSERT INTO bills
        (id,tenant_id,account_id,entity_id,category_id,description,amount,due_date,
         status,recurrence,installments,current_installment,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, t, account_id||null, entity_id||null, category_id||null,
         n > 1 ? `${description} (${i+1}/${n})` : description,
         parseFloat(amount), dueD.toISOString().slice(0,10),
         status||'pending', recurrence||null, n, i+1, notes||null]);
      created.push(id);
    }
  });

  res.status(201).json({ ok: true, count: created.length, ids: created });
});

// PUT /api/bills/:id — editar
router.put('/:id', (req, res) => {
  const t = tid(req);
  const allowed = ['description','amount','due_date','paid_date','status',
    'account_id','entity_id','category_id','recurrence','notes'];
  const sets = [], params = [];
  for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k}=?`); params.push(req.body[k]); }
  if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });

  // Se marcando como dívida, chama módulo de dívidas
  if (req.body.status === 'debt') {
    const bill = queryOne('SELECT * FROM bills WHERE id=? AND tenant_id=?', [req.params.id, t]);
    if (bill) {
      run(`INSERT OR IGNORE INTO debts (id,tenant_id,entity_id,description,original_amount,remaining_amount,creditor,status)
        VALUES (?,?,?,?,?,?,'Conta a Pagar','active')`,
        [uuidv4(), t, bill.entity_id, bill.description, bill.amount, bill.amount]);
    }
  }

  sets.push("updated_at=datetime('now')");
  params.push(req.params.id, t);
  run(`UPDATE bills SET ${sets.join(',')} WHERE id=? AND tenant_id=?`, params);
  res.json(queryOne(`SELECT b.*, a.name as account_name, e.label as entity_label
    FROM bills b LEFT JOIN accounts a ON a.id=b.account_id LEFT JOIN entities e ON e.id=b.entity_id
    WHERE b.id=?`, [req.params.id]));
});

// DELETE /api/bills/:id
router.delete('/:id', (req, res) => {
  run('DELETE FROM bills WHERE id=? AND tenant_id=?', [req.params.id, tid(req)]);
  res.json({ message: 'Removida' });
});

// POST /api/bills/:id/pay — marcar como pago
router.post('/:id/pay', (req, res) => {
  const t = tid(req);
  const today = new Date().toISOString().slice(0,10);
  run(`UPDATE bills SET status='paid', paid_date=?, updated_at=datetime('now') WHERE id=? AND tenant_id=?`,
    [req.body.paid_date||today, req.params.id, t]);
  res.json({ ok: true });
});

module.exports = router;
