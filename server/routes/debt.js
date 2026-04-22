'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, run, transaction } = require('../db/database');
const tid = req => req.user.tenantId;

// ── GET /api/debt ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const debts = await query(`
    SELECT d.*, e.label as entity_label, tx.description as tx_description
    FROM debts d
    LEFT JOIN entities e ON e.id=d.entity_id
    LEFT JOIN transactions tx ON tx.id=d.transaction_id
    WHERE d.tenant_id=? ORDER BY d.created_at DESC
  `, [tid(req)]);
  res.json(debts);
});

// ── POST /api/debt — Marcar lançamento como dívida ────────────────────────────
router.post('/', async (req, res) => {
  const t = tid(req);
  const { transaction_id, description, original_amount, creditor, entity_id, notes } = req.body;
  if (!description || !original_amount) return res.status(400).json({ error: 'description e original_amount obrigatórios' });

  // Se veio de uma transação existente, remove do fluxo normal marcando como dívida
  if (transaction_id) {
    await run(`UPDATE transactions SET status='debt' WHERE id=? AND tenant_id=?`, [transaction_id, t]);
  }

  const id = uuidv4();
  await run(`INSERT INTO debts (id,tenant_id,transaction_id,entity_id,description,original_amount,remaining_amount,creditor,notes,status)
    VALUES (?,?,?,?,?,?,?,'active',?,?,?)`,
    [id, t, transaction_id||null, entity_id||null, description,
     parseFloat(original_amount), parseFloat(original_amount), creditor||null, notes||null, 'active']);

  res.status(201).json(await queryOne('SELECT * FROM debts WHERE id=?', [id]));
});

// ── PUT /api/debt/:id ─────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const t = tid(req);
  const allowed = ['status','notes','creditor','payment_start_date','payment_type',
    'payment_amount','payment_pct','installment_count','remaining_amount'];
  const sets = [], params = [];
  for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k}=?`); params.push(req.body[k]); }
  if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
  sets.push('updated_at=datetime(\'now\')');
  params.push(req.params.id, t);
  await run(`UPDATE debts SET ${sets.join(',')} WHERE id=? AND tenant_id=?`, params);
  res.json(await queryOne('SELECT * FROM debts WHERE id=?', [req.params.id]));
});

// ── DELETE /api/debt/:id ──────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const debt = await queryOne('SELECT transaction_id FROM debts WHERE id=? AND tenant_id=?', [req.params.id, tid(req)]);
  if (debt?.transaction_id) {
    await run(`UPDATE transactions SET status='pending' WHERE id=?`, [debt.transaction_id]);
  }
  await run('DELETE FROM debts WHERE id=? AND tenant_id=?', [req.params.id, tid(req)]);
  res.json({ message: 'Dívida removida' });
});

// ── POST /api/debt/:id/simulate — Simulação de quitação ──────────────────────
router.post('/:id/simulate', async (req, res) => {
  const t = tid(req);
  const debt = await queryOne('SELECT * FROM debts WHERE id=? AND tenant_id=?', [req.params.id, t]);
  if (!debt) return res.status(404).json({ error: 'Dívida não encontrada' });

  // Busca rendas para calcular capacidade de pagamento
  const incomeSources = await query(`SELECT amount, net_salary FROM income_sources WHERE tenant_id=? AND is_active=1`, [t]);
  const monthlyIncome = incomeSources.reduce((s, i) => s + (i.net_salary || i.amount || 0), 0);

  // Despesas fixas mensais
  const fixedExpenses = await queryOne(`
    SELECT COALESCE(SUM(amount),0) as total FROM recurring_contracts
    WHERE tenant_id=? AND status='active' AND flow='out'
  `, [t]).total || 0;

  const available = Math.max(0, monthlyIncome - fixedExpenses);
  const remaining = debt.remaining_amount;

  const suggestions = [];

  // Sugestão 1: Agressiva (30% do disponível)
  const pct30 = available * 0.30;
  if (pct30 > 0) {
    const months30 = Math.ceil(remaining / pct30);
    suggestions.push({
      name: '🔴 Agressiva',
      description: '30% da renda disponível — quitar rápido com sacrifício',
      monthly_payment: parseFloat(pct30.toFixed(2)),
      months_to_pay: months30,
      total_paid: parseFloat((pct30 * months30).toFixed(2)),
      end_date: addMonths(months30),
      pct_income: 30,
    });
  }

  // Sugestão 2: Moderada (15% do disponível)
  const pct15 = available * 0.15;
  if (pct15 > 0) {
    const months15 = Math.ceil(remaining / pct15);
    suggestions.push({
      name: '🟡 Moderada',
      description: '15% da renda disponível — equilíbrio entre velocidade e qualidade de vida',
      monthly_payment: parseFloat(pct15.toFixed(2)),
      months_to_pay: months15,
      total_paid: parseFloat((pct15 * months15).toFixed(2)),
      end_date: addMonths(months15),
      pct_income: 15,
    });
  }

  // Sugestão 3: Conservadora (valor fixo R$X/mês confortável = 8%)
  const pct8 = Math.max(available * 0.08, 50);
  if (pct8 > 0) {
    const months8 = Math.ceil(remaining / pct8);
    suggestions.push({
      name: '🟢 Conservadora',
      description: '8% da renda — pagamento confortável sem comprometer o orçamento',
      monthly_payment: parseFloat(pct8.toFixed(2)),
      months_to_pay: months8,
      total_paid: parseFloat((pct8 * months8).toFixed(2)),
      end_date: addMonths(months8),
      pct_income: 8,
    });
  }

  res.json({
    debt,
    monthly_income: parseFloat(monthlyIncome.toFixed(2)),
    fixed_expenses: parseFloat(fixedExpenses.toFixed(2)),
    monthly_available: parseFloat(available.toFixed(2)),
    suggestions,
  });
});

// ── POST /api/debt/:id/schedule-payment — Programar pagamento ─────────────────
router.post('/:id/schedule-payment', async (req, res) => {
  const t = tid(req);
  const { payment_type, payment_amount, payment_pct, installment_count, payment_start_date } = req.body;

  await run(`UPDATE debts SET
    status='negotiating', payment_type=?, payment_amount=?, payment_pct=?,
    installment_count=?, payment_start_date=?, updated_at=NOW()
    WHERE id=? AND tenant_id=?`,
    [payment_type, payment_amount||null, payment_pct||null,
     installment_count||null, payment_start_date||null, req.params.id, t]);

  // Se for parcelamento, cria recorrente automático
  if (payment_type === 'installment' && payment_amount && payment_start_date) {
    const debt = await queryOne('SELECT * FROM debts WHERE id=?', [req.params.id]);
    const nextDue = new Date(payment_start_date);
    await run(`INSERT INTO recurring_contracts
      (id,tenant_id,entity_id,description,amount,flow,frequency,start_date,next_due_date,day_of_month,status,notes)
      VALUES (?,?,?,?,?,'out','monthly',?,?,?,,'active',?)`,
      [uuidv4(), t, debt.entity_id,
       `Pagamento dívida: ${debt.description}`,
       parseFloat(payment_amount), payment_start_date,
       nextDue.toISOString().slice(0,10),
       nextDue.getDate(),
       `Referente à dívida ID ${debt.id}`]);
  }

  res.json({ ok: true });
});

function addMonths(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0,10);
}

module.exports = router;
