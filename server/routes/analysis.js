'use strict';
const router = require('express').Router();
const { analyzeCreditCards, financialHealthScore, spendingTrends, budgetAlerts } = require('../services/analysis');

const tid = req => req.user.tenantId;

// GET /api/analysis/health — score de saúde financeira
router.get('/health', async (req, res) => {
  try { res.json(financialHealthScore(tid(req))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analysis/cards?months=3 — análise de cartão de crédito
router.get('/cards', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    res.json(analyzeCreditCards(tid(req), months));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analysis/trends?months=6 — tendências de gastos
router.get('/trends', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6;
    res.json(spendingTrends(tid(req), months));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analysis/alerts — alertas de budget
router.get('/alerts', async (req, res) => {
  try { res.json(budgetAlerts(tid(req))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analysis/full — tudo de uma vez (para o dashboard)
router.get('/full', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    res.json({
      health:  financialHealthScore(tid(req)),
      cards:   analyzeCreditCards(tid(req), months),
      trends:  spendingTrends(tid(req), months),
      alerts:  budgetAlerts(tid(req)),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
