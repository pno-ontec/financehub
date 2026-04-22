'use strict';
const router = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { getStatus, createPixCharge, confirmPixPayment, PLANS } = require('../services/subscription');
const { queryOne, query, run } = require('../db/database');

router.get('/status', verifyToken, async (req, res) => res.json(await getStatus(req.user.tenantId)));
router.get('/plans',  (_req, res) => res.json(PLANS));

router.post('/charge', verifyToken, async (req, res) => {
  try {
    const { plan, referral_code } = req.body;
    const VALID_PLANS = ['individual','family_s','family_m','family_l',
      'individual_a','family_s_a','family_m_a','family_l_a',
      'monthly','annual']; // monthly/annual for backward compat
    if (!VALID_PLANS.includes(plan)) return res.status(400).json({ error: 'Plano inválido: ' + plan });
    const charge = await createPixCharge(req.user.tenantId, plan, referral_code);
    res.status(201).json(charge);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.get('/charges', verifyToken, async (req, res) => {
  res.json(await query('SELECT * FROM pix_payments WHERE tenant_id=? ORDER BY created_at DESC LIMIT 20', [req.user.tenantId]));
});

router.post('/confirm/:paymentId', verifyToken, async (req, res) => {
  try {
    if (!['owner','admin'].includes(req.user.role)) return res.status(403).json({ error: 'Sem permissão' });
    const result = await confirmPixPayment(req.params.paymentId);
    res.json(result);
  } catch(err) { res.status(400).json({ error: err.message }); }
});

// Referral info do usuário atual
router.get('/referral', verifyToken, async (req, res) => {
  const user = await queryOne('SELECT referral_code, referred_by FROM users WHERE id=?', [req.user.id]);
  const sub  = await queryOne('SELECT referral_pct_credit, referral_months_credit FROM subscriptions WHERE tenant_id=?', [req.user.tenantId]);
  const referrals = await query(`
    SELECT r.status, r.created_at, r.confirmed_at, ud.name as referred_name
    FROM referrals r JOIN users ud ON ud.id=r.referred_id
    WHERE r.referrer_id=? ORDER BY r.created_at DESC
  `, [req.user.id]);
  res.json({ referral_code: user?.referral_code, ...sub, referrals });
});

module.exports = router;
