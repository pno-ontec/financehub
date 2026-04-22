'use strict';
const { query, queryOne } = require('../db/database');

/**
 * Motor de análise financeira completo:
 * - Análise de cartão de crédito (recorrências, risco)
 * - Score de saúde financeira
 * - Alertas inteligentes
 * - Tendências de gastos
 */

// ── Análise de Cartão de Crédito ──────────────────────────────────────────────
async function analyzeCreditCards(tenantId, months = 3) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Busca todas as transações de cartão
  const txs = await query(`
    SELECT tx.*, a.name as account_name, a.credit_limit, a.type as account_type,
      cat.name as category_name, cat.icon as category_icon
    FROM transactions tx
    LEFT JOIN accounts a ON a.id=tx.account_id
    LEFT JOIN categories cat ON cat.id=tx.category_id
    WHERE tx.tenant_id=? AND tx.flow='out' AND tx.date>=?
      AND (a.type='credit' OR tx.account_id IS NULL)
    ORDER BY tx.date DESC
  `, [tenantId, cutoffStr]);

  // Todas as contas de crédito
  const cards = await query(
    `SELECT * FROM accounts WHERE tenant_id=? AND type='credit' AND is_active=1`,
    [tenantId]
  );

  const results = {};

  cards.forEach(card => {
    const cardTxs = txs.filter(t => t.account_id === card.id);
    results[card.id] = analyzeCard(card, cardTxs, months);
  });

  // Análise consolidada de todos os cartões
  const consolidated = consolidatedCardAnalysis(txs, cards, tenantId, months);

  return { cards: results, consolidated };
}

async function analyzeCard(card, txs, months) {
  if (!txs.length) return { card, empty: true };

  // Agrupa por mês
  const byMonth = {};
  txs.forEach(t => {
    const m = t.date.slice(0, 7);
    byMonth[m] = (byMonth[m] || []);
    byMonth[m].push(t);
  });

  // Total mensal médio
  const monthlyTotals = Object.values(byMonth).map(m => m.reduce((s, t) => s + t.amount, 0));
  const avgMonthly    = monthlyTotals.reduce((a, b) => a + b, 0) / Math.max(monthlyTotals.length, 1);

  // Uso do limite
  const limitUsage = card.credit_limit ? (avgMonthly / card.credit_limit) * 100 : null;
  const limitRisk  = limitUsage > 80 ? 'critico' : limitUsage > 60 ? 'alto' : limitUsage > 40 ? 'medio' : 'baixo';

  // Detecção de recorrências (mesma descrição, valor similar, meses consecutivos)
  const recurring = detectRecurring(txs, months);

  // Gastos por categoria
  const byCategory = {};
  txs.forEach(t => {
    const k = t.category_name || 'Sem categoria';
    if (!byCategory[k]) byCategory[k] = { total: 0, count: 0, icon: t.category_icon || '📦' };
    byCategory[k].total += t.amount;
    byCategory[k].count++;
  });
  const topCategories = Object.entries(byCategory)
    .map(([name, v]) => ({ name, ...v, avg: v.total / months }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Risco de endividamento
  const debtRisk = calcDebtRisk(card, avgMonthly, recurring);

  // Tendência (último mês vs média)
  const lastMonth    = monthlyTotals[monthlyTotals.length - 1] || 0;
  const trend        = lastMonth > avgMonthly * 1.1 ? 'crescente' : lastMonth < avgMonthly * 0.9 ? 'decrescente' : 'estavel';
  const trendPct     = avgMonthly > 0 ? ((lastMonth - avgMonthly) / avgMonthly * 100).toFixed(1) : 0;

  return {
    card,
    months_analyzed: months,
    avg_monthly: parseFloat(avgMonthly.toFixed(2)),
    last_month: parseFloat(lastMonth.toFixed(2)),
    total: txs.reduce((s, t) => s + t.amount, 0),
    tx_count: txs.length,
    limit_usage_pct: limitUsage ? parseFloat(limitUsage.toFixed(1)) : null,
    limit_risk: limitRisk,
    trend,
    trend_pct: parseFloat(trendPct),
    recurring,
    top_categories: topCategories,
    debt_risk: debtRisk,
    monthly_breakdown: Object.entries(byMonth).map(([month, txs]) => ({
      month, total: parseFloat(txs.reduce((s, t) => s + t.amount, 0).toFixed(2)), count: txs.length
    })).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

function detectRecurring(txs, months) {
  // Agrupa por descrição normalizada
  const groups = {};
  txs.forEach(t => {
    const key = normalizeDesc(t.description);
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  const recurring = [];
  Object.entries(groups).forEach(([key, items]) => {
    if (items.length < 2) return;

    const months_seen = new Set(items.map(t => t.date.slice(0, 7))).size;
    if (months_seen < 2) return;

    const amounts    = items.map(t => t.amount);
    const avgAmount  = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance   = amounts.reduce((s, a) => s + Math.pow(a - avgAmount, 2), 0) / amounts.length;
    const stdDev     = Math.sqrt(variance);
    const isFixed    = stdDev < avgAmount * 0.05; // variação < 5% = valor fixo

    recurring.push({
      description: items[0].description,
      normalized:  key,
      count:       items.length,
      months_seen,
      avg_amount:  parseFloat(avgAmount.toFixed(2)),
      is_fixed:    isFixed,
      category:    items[0].category_name || 'Sem categoria',
      type:        months_seen >= months * 0.8 ? 'fixa' : 'frequente',
      last_date:   items.sort((a, b) => b.date.localeCompare(a.date))[0].date,
      annual_cost: parseFloat((avgAmount * 12).toFixed(2)),
    });
  });

  return recurring.sort((a, b) => b.avg_amount - a.avg_amount);
}

function normalizeDesc(desc) {
  return (desc || '').toLowerCase()
    .replace(/\d{2}\/\d{2}/g, '')     // remove datas
    .replace(/parc?\s*\d+/gi, '')      // remove "parc 01"
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
}

function calcDebtRisk(card, avgMonthly, recurring) {
  let score = 0;
  const alerts = [];

  if (card.credit_limit) {
    const usage = (avgMonthly / card.credit_limit) * 100;
    if (usage > 90) { score += 40; alerts.push({ level: 'critico', msg: `Uso do limite: ${usage.toFixed(0)}% — risco muito alto` }); }
    else if (usage > 70) { score += 25; alerts.push({ level: 'alto', msg: `Uso do limite: ${usage.toFixed(0)}% — acima do recomendado (70%)` }); }
    else if (usage > 50) { score += 10; alerts.push({ level: 'medio', msg: `Uso do limite: ${usage.toFixed(0)}%` }); }
  }

  const fixedRecurring = recurring.filter(r => r.type === 'fixa');
  const fixedTotal     = fixedRecurring.reduce((s, r) => s + r.avg_amount, 0);
  const fixedPct       = avgMonthly > 0 ? (fixedTotal / avgMonthly) * 100 : 0;
  if (fixedPct > 70) { score += 20; alerts.push({ level: 'alto', msg: `${fixedPct.toFixed(0)}% do gasto é recorrente fixo — pouca flexibilidade` }); }
  else if (fixedPct > 50) { score += 10; alerts.push({ level: 'medio', msg: `${fixedPct.toFixed(0)}% recorrente — monitore` }); }

  const subscriptions = recurring.filter(r => r.avg_amount < 100 && r.type === 'fixa');
  if (subscriptions.length > 5) {
    score += 10;
    alerts.push({ level: 'medio', msg: `${subscriptions.length} assinaturas detectadas — custo anual: R$${subscriptions.reduce((s, r) => s + r.annual_cost, 0).toFixed(0)}` });
  }

  const level = score >= 50 ? 'critico' : score >= 30 ? 'alto' : score >= 15 ? 'medio' : 'baixo';
  return { score, level, alerts, fixed_recurring_pct: parseFloat(fixedPct.toFixed(1)), subscriptions_count: subscriptions.length };
}

async function consolidatedCardAnalysis(txs, cards, tenantId, months) {
  const totalSpend   = txs.reduce((s, t) => s + t.amount, 0);
  const avgMonthly   = totalSpend / months;
  const totalLimit   = cards.reduce((s, c) => s + (c.credit_limit || 0), 0);

  // Renda líquida do tenant
  const incomeSources = await query(
    `SELECT COALESCE(SUM(net_salary), 0) + COALESCE(SUM(CASE WHEN net_salary=0 THEN amount ELSE 0 END), 0) as total_net FROM income_sources WHERE tenant_id=? AND is_active=1`,
    [tenantId]
  );
  const monthlyIncome = incomeSources[0]?.total_net || 0;

  const cardToIncomePct = monthlyIncome > 0 ? (avgMonthly / monthlyIncome) * 100 : null;

  const alerts = [];
  if (cardToIncomePct > 50) alerts.push({ level: 'critico', msg: `Gastos no cartão representam ${cardToIncomePct.toFixed(0)}% da renda — risco de endividamento` });
  else if (cardToIncomePct > 30) alerts.push({ level: 'alto', msg: `Gastos no cartão: ${cardToIncomePct.toFixed(0)}% da renda — acima do ideal (30%)` });

  if (totalLimit > 0 && avgMonthly / totalLimit > 0.5) {
    alerts.push({ level: 'alto', msg: `Uso consolidado do limite: ${((avgMonthly/totalLimit)*100).toFixed(0)}%` });
  }

  return {
    total_spend: parseFloat(totalSpend.toFixed(2)),
    avg_monthly: parseFloat(avgMonthly.toFixed(2)),
    total_limit: totalLimit,
    monthly_income: parseFloat(monthlyIncome.toFixed(2)),
    card_to_income_pct: cardToIncomePct ? parseFloat(cardToIncomePct.toFixed(1)) : null,
    cards_count: cards.length,
    alerts,
  };
}

// ── Score de Saúde Financeira ──────────────────────────────────────────────────
async function financialHealthScore(tenantId) {
  const now     = new Date();
  const m3ago   = new Date(); m3ago.setMonth(m3ago.getMonth() - 3);
  const cutoff  = m3ago.toISOString().slice(0, 10);

  // Receitas e despesas dos últimos 3 meses
  const summary = await queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN flow='in' AND status='paid' THEN amount ELSE 0 END),0) as receitas,
      COALESCE(SUM(CASE WHEN flow='out' AND status='paid' THEN amount ELSE 0 END),0) as despesas,
      COALESCE(SUM(CASE WHEN flow='out' AND status IN('pending','overdue') THEN amount ELSE 0 END),0) as a_pagar,
      COALESCE(SUM(CASE WHEN status='overdue' THEN amount ELSE 0 END),0) as atrasados
    FROM transactions WHERE tenant_id=? AND date>=?
  `, [tenantId, cutoff]);

  const avgRec = (summary.receitas || 0) / 3;
  const avgDes = (summary.despesas || 0) / 3;
  const savingsRate = avgRec > 0 ? ((avgRec - avgDes) / avgRec) * 100 : 0;

  // Parcelamentos ativos
  const installments = await queryOne(`
    SELECT COUNT(*) as active, COALESCE(SUM(installment_amount),0) as monthly_commit
    FROM installment_contracts WHERE tenant_id=? AND status='active'
  `, [tenantId]);

  const installCommitPct = avgRec > 0 ? ((installments.monthly_commit || 0) / avgRec) * 100 : 0;

  // Contas em atraso
  const overdueCount = await queryOne(
    `SELECT COUNT(*) as n FROM transactions WHERE tenant_id=? AND status='overdue'`, [tenantId]
  ).n;

  // Score componentes (0-100 cada)
  const scores = {
    savings:     Math.min(100, Math.max(0, savingsRate * 2)),          // ideal: 20%+ de poupança
    overdue:     Math.max(0, 100 - overdueCount * 20),                  // penaliza contas atrasadas
    commitments: Math.min(100, Math.max(0, 100 - installCommitPct)),   // ideal: parcelamentos < 30% renda
    balance:     savingsRate >= 0 ? 80 : 20,                           // negativo = ruim
  };

  const totalScore = Math.round(
    scores.savings * 0.35 + scores.overdue * 0.25 + scores.commitments * 0.25 + scores.balance * 0.15
  );

  const level = totalScore >= 80 ? 'excelente' : totalScore >= 60 ? 'bom' : totalScore >= 40 ? 'regular' : 'critico';
  const color = totalScore >= 80 ? '#00e5a0' : totalScore >= 60 ? '#0077ff' : totalScore >= 40 ? '#f7c948' : '#ff4d6d';

  const insights = [];
  if (savingsRate < 10) insights.push({ type: 'warning', msg: `Taxa de poupança: ${savingsRate.toFixed(1)}% — recomendado mínimo 10%` });
  else if (savingsRate >= 20) insights.push({ type: 'success', msg: `Ótima taxa de poupança: ${savingsRate.toFixed(1)}%` });

  if (overdueCount > 0) insights.push({ type: 'danger', msg: `${overdueCount} conta(s) em atraso — regularize para melhorar o score` });
  if (installCommitPct > 30) insights.push({ type: 'warning', msg: `Parcelamentos comprometem ${installCommitPct.toFixed(0)}% da renda mensal` });
  if (totalScore >= 80) insights.push({ type: 'success', msg: 'Finanças saudáveis! Continue assim.' });

  return {
    score: totalScore,
    level,
    color,
    components: scores,
    insights,
    metrics: {
      avg_monthly_income:  parseFloat(avgRec.toFixed(2)),
      avg_monthly_expense: parseFloat(avgDes.toFixed(2)),
      savings_rate:        parseFloat(savingsRate.toFixed(1)),
      overdue_count:       overdueCount,
      install_commit_pct:  parseFloat(installCommitPct.toFixed(1)),
      monthly_commitments: parseFloat((installments.monthly_commit || 0).toFixed(2)),
    },
  };
}

// ── Tendências de Gastos ───────────────────────────────────────────────────────
async function spendingTrends(tenantId, months = 6) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  const txs = await query(`
    SELECT tx.date, tx.amount, tx.flow, tx.status,
      cat.name as category, cat.type as cat_type, a.type as account_type
    FROM transactions tx
    LEFT JOIN categories cat ON cat.id=tx.category_id
    LEFT JOIN accounts a ON a.id=tx.account_id
    WHERE tx.tenant_id=? AND tx.date>=? AND tx.status='paid'
    ORDER BY tx.date
  `, [tenantId, cutoff.toISOString().slice(0,10)]);

  // Por mês
  const byMonth = {};
  txs.forEach(t => {
    const m = t.date.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { income: 0, expense: 0, card: 0, categories: {} };
    if (t.flow === 'in') byMonth[m].income += t.amount;
    else {
      byMonth[m].expense += t.amount;
      if (t.account_type === 'credit') byMonth[m].card += t.amount;
    }
    if (t.flow === 'out' && t.category) {
      byMonth[m].categories[t.category] = (byMonth[m].categories[t.category] || 0) + t.amount;
    }
  });

  const monthlyData = Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, data]) => ({
      month,
      income:  parseFloat(data.income.toFixed(2)),
      expense: parseFloat(data.expense.toFixed(2)),
      balance: parseFloat((data.income - data.expense).toFixed(2)),
      card:    parseFloat(data.card.toFixed(2)),
      card_pct: data.expense > 0 ? parseFloat((data.card / data.expense * 100).toFixed(1)) : 0,
    }));

  // Top categorias crescentes
  const catTotals = {};
  txs.filter(t => t.flow === 'out').forEach(t => {
    if (t.category) catTotals[t.category] = (catTotals[t.category] || 0) + t.amount;
  });
  const topCategories = Object.entries(catTotals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([name, total]) => ({ name, total: parseFloat(total.toFixed(2)), monthly_avg: parseFloat((total/months).toFixed(2)) }));

  return { monthly: monthlyData, top_categories: topCategories, months_analyzed: months };
}

// ── Budget Alerts ─────────────────────────────────────────────────────────────
async function budgetAlerts(tenantId) {
  const alerts = [];
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);

  // Contas próximas do vencimento (próximos 7 dias)
  const upcoming = await query(`
    SELECT tx.description, tx.amount, tx.date, tx.status, a.name as account_name
    FROM transactions tx
    LEFT JOIN accounts a ON a.id=tx.account_id
    WHERE tx.tenant_id=? AND tx.flow='out' AND tx.status='pending'
      AND tx.date BETWEEN CURRENT_DATE AND CURRENT_DATE + '+7 days')
    ORDER BY tx.date
  `, [tenantId]);

  upcoming.forEach(t => {
    const days = Math.ceil((new Date(t.date) - now) / 86400000);
    alerts.push({
      type: days <= 2 ? 'danger' : 'warning',
      category: 'vencimento',
      msg: `${t.description}: R$${t.amount.toFixed(2)} vence em ${days} dia(s)`,
      amount: t.amount, date: t.date,
    });
  });

  // Contas atrasadas
  const overdue = await query(`
    SELECT description, amount, date FROM transactions
    WHERE tenant_id=? AND status='overdue' ORDER BY date
  `, [tenantId]);

  overdue.forEach(t => {
    const days = Math.ceil((now - new Date(t.date)) / 86400000);
    alerts.push({
      type: 'danger', category: 'atraso',
      msg: `${t.description}: R$${t.amount.toFixed(2)} — ${days} dia(s) em atraso`,
      amount: t.amount, date: t.date,
    });
  });

  // Parcelas vencendo
  const instOverdue = await query(`
    SELECT i.amount, i.due_date, c.description
    FROM installments i
    JOIN installment_contracts c ON c.id=i.contract_id
    WHERE i.tenant_id=? AND i.status IN('pending','overdue')
      AND i.due_date BETWEEN CURRENT_DATE +'-5 days') AND CURRENT_DATE +'+7 days')
    ORDER BY i.due_date
  `, [tenantId]);

  instOverdue.forEach(i => {
    const days = Math.ceil((new Date(i.due_date) - now) / 86400000);
    const past = days < 0;
    alerts.push({
      type: past ? 'danger' : 'warning',
      category: 'parcela',
      msg: `${i.description}: parcela R$${i.amount.toFixed(2)} ${past ? `atrasada ${Math.abs(days)}d` : `vence em ${days}d`}`,
      amount: i.amount, date: i.due_date,
    });
  });

  return alerts.sort((a, b) => a.type === 'danger' ? -1 : 1);
}

module.exports = { analyzeCreditCards, financialHealthScore, spendingTrends, budgetAlerts };
