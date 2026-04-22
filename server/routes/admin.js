'use strict';
const router  = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { verifyToken }  = require('../middleware/auth');
const { query, queryOne, run, transaction } = require('../db/database');
const { confirmPixPayment, addTrialDays, createAdminSubscription, getStatus, createTrial } = require('../services/subscription');
const { hashPassword } = require('../utils/crypto');
const { seedCategories } = require('../db/seeds');

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores' });
  next();
}

// ── Estatísticas ───────────────────────────────────────────────────────────────
router.get('/stats', verifyToken, adminOnly, async (_req, res) => {
  const totalTenants   = await queryOne('SELECT COUNT(*) as n FROM tenants', []).n;
  const activeSubs     = await queryOne(`SELECT COUNT(*) as n FROM subscriptions WHERE status='active' AND plan NOT IN ('trial','admin')`, []).n;
  const trialActive    = await queryOne(`SELECT COUNT(*) as n FROM subscriptions WHERE plan='trial' AND status='active' AND trial_ends_at > NOW()`, []).n;
  const trialExpired   = await queryOne(`SELECT COUNT(*) as n FROM subscriptions WHERE plan='trial' AND (status='expired' OR trial_ends_at <= NOW())`, []).n;
  const totalRevenue   = await queryOne(`SELECT COALESCE(SUM(amount_cents),0) as n FROM pix_payments WHERE status='paid'`, []).n;
  const pendingPayments= await queryOne(`SELECT COUNT(*) as n FROM pix_payments WHERE status='pending'`, []).n;
  const referrals      = await queryOne(`SELECT COUNT(*) as n FROM referrals WHERE status='rewarded'`, []).n;
  const adminAccounts  = await queryOne(`SELECT COUNT(*) as n FROM subscriptions WHERE plan='admin'`, []).n;
  const lifetimeAccounts = await queryOne(`SELECT COUNT(*) as n FROM subscriptions WHERE current_period_end >= '2090-01-01'`, []).n;
  res.json({ totalTenants, activeSubs, trialActive, trialExpired, totalRevenue, pendingPayments, referrals, adminAccounts, lifetimeAccounts });
});

// ── Lista todos os tenants ─────────────────────────────────────────────────────
router.get('/tenants', verifyToken, adminOnly, async (_req, res) => {
  const tenants = await query(`
    SELECT t.id as tenant_id, t.name as tenant_name, t.created_at as tenant_created,
      u.id as owner_id, u.email as owner_email, u.name as owner_name,
      u.referral_code, u.status as user_status,
      s.plan, s.status as sub_status, s.trial_ends_at,
      s.current_period_start, s.current_period_end,
      s.referral_pct_credit, s.extra_cpf_count,
      (SELECT COUNT(*) FROM referrals r WHERE r.referrer_id=u.id AND r.status='rewarded') as referrals_confirmed,
      (SELECT COUNT(*) FROM pix_payments p WHERE p.tenant_id=t.id AND p.status='paid') as total_payments,
      (SELECT COUNT(*) FROM tenant_members tm WHERE tm.tenant_id=t.id AND tm.status='active') as member_count
    FROM tenants t
    JOIN users u ON u.id=t.owner_id
    LEFT JOIN subscriptions s ON s.tenant_id=t.id
    ORDER BY t.created_at DESC
  `, []);
  res.json(tenants);
});

// ── Lista pagamentos ──────────────────────────────────────────────────────────
router.get('/payments', verifyToken, adminOnly, async (_req, res) => {
  const payments = await query(`
    SELECT p.*, t.name as tenant_name, u.email as owner_email, u.name as owner_name
    FROM pix_payments p
    JOIN tenants t ON t.id=p.tenant_id
    JOIN users u ON u.id=t.owner_id
    ORDER BY p.created_at DESC LIMIT 100
  `, []);
  res.json(payments);
});

// ── Lista indicações ───────────────────────────────────────────────────────────
router.get('/referrals', verifyToken, adminOnly, async (_req, res) => {
  const refs = await query(`
    SELECT r.*,
      ur.name as referrer_name, ur.email as referrer_email, ur.referral_code,
      ud.name as referred_name, ud.email as referred_email
    FROM referrals r
    JOIN users ur ON ur.id=r.referrer_id
    JOIN users ud ON ud.id=r.referred_id
    ORDER BY r.created_at DESC
  `, []);
  res.json(refs);
});

// ── Confirmar pagamento ────────────────────────────────────────────────────────
router.post('/confirm/:paymentId', verifyToken, adminOnly, async (req, res) => {
  try {
    const result = await confirmPixPayment(req.params.paymentId);
    res.json(result);
  } catch(err) { res.status(400).json({ error: err.message }); }
});

// ── Adicionar dias ─────────────────────────────────────────────────────────────
router.post('/add-days', verifyToken, adminOnly, async (req, res) => {
  const { tenantId, days } = req.body;
  if (!tenantId || !days) return res.status(400).json({ error: 'tenantId e days são obrigatórios' });
  await addTrialDays(tenantId, Number(days));
  res.json({ ok: true, message: `${days} dia(s) adicionados com sucesso` });
});

// ── Definir validade específica ───────────────────────────────────────────────
router.post('/set-expiry', verifyToken, adminOnly, async (req, res) => {
  const { tenantId, expiry_date, plan } = req.body;
  if (!tenantId || !expiry_date) return res.status(400).json({ error: 'tenantId e expiry_date obrigatórios' });

  const sub = await queryOne('SELECT * FROM subscriptions WHERE tenant_id=?', [tenantId]);
  if (!sub) return res.status(404).json({ error: 'Assinatura não encontrada' });

  const newPlan = plan || (sub.plan === 'trial' ? 'individual' : sub.plan);
  const isoDate = new Date(expiry_date).toISOString();

  await run(`UPDATE subscriptions SET 
    plan=?, status='active',
    current_period_start=COALESCE(current_period_start, NOW()),
    current_period_end=?,
    updated_at=NOW()
    WHERE tenant_id=?`,
    [newPlan, isoDate, tenantId]);

  res.json({ ok: true, plan: newPlan, valid_until: isoDate });
});

// ── Licença vitalícia ─────────────────────────────────────────────────────────
router.post('/set-lifetime/:tenantId', verifyToken, adminOnly, async (req, res) => {
  const { plan } = req.body;
  const lifetimeDate = '2099-12-31T23:59:59.000Z';
  const newPlan = plan || 'individual';

  const sub = await queryOne('SELECT id FROM subscriptions WHERE tenant_id=?', [req.params.tenantId]);
  if (!sub) return res.status(404).json({ error: 'Tenant não encontrado' });

  await run(`UPDATE subscriptions SET 
    plan=?, status='active',
    current_period_start=NOW(),
    current_period_end=?,
    updated_at=NOW()
    WHERE tenant_id=?`,
    [newPlan, lifetimeDate, req.params.tenantId]);

  res.json({ ok: true, plan: newPlan, valid_until: lifetimeDate, message: 'Licença vitalícia ativada' });
});

// ── Marcar como admin master ───────────────────────────────────────────────────
router.post('/set-admin/:tenantId', verifyToken, adminOnly, async (req, res) => {
  await createAdminSubscription(req.params.tenantId);
  // Também promove o user a role admin
  const owner = await queryOne('SELECT id FROM users WHERE tenant_id=?', [req.params.tenantId]);
  if (owner) await run(`UPDATE users SET role='admin' WHERE id=?`, [owner.id]);
  res.json({ ok: true, message: 'Conta promovida a administrador master' });
});

// ── Criar conta diretamente (admin cria para cliente) ─────────────────────────
router.post('/create-account', verifyToken, adminOnly, async (req, res) => {
  try {
    const {
      name, email, password,
      plan = 'individual',
      expiry_date,     // data específica de validade (opcional)
      lifetime = false, // licença vitalícia
      trial_days,      // dias de trial customizado
      notes,
    } = req.body;

    if (!name || !email) return res.status(400).json({ error: 'name e email são obrigatórios' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'password mínimo de 6 caracteres' });

    const existing = await queryOne('SELECT id FROM users WHERE email=?', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'E-mail já cadastrado' });

    const userId   = uuidv4();
    const tenantId = uuidv4();
    const hash     = await hashPassword(password);

    // Gera código de indicação
    const base = (name).replace(/[^a-zA-Z]/g,'').toUpperCase().slice(0,4).padEnd(4,'X');
    const refCode = base + Math.random().toString(36).slice(2,6).toUpperCase();

    await transaction(async (client) => {
      // Cria tenant e usuário
      await run('INSERT INTO tenants (id,owner_id,name) VALUES (?,?,?)',
        [tenantId, userId, `Conta de ${name}`]);
      await run(`INSERT INTO users (id,tenant_id,email,password_hash,name,role,referral_code) VALUES (?,?,?,?,?,'owner',?)`,
        [userId, tenantId, email.toLowerCase(), hash, name, refCode]);
      await run(`INSERT INTO entities (id,tenant_id,label,type,color) VALUES (?,?,'CPF — Pessoal','cpf','#00e5a0')`,
        [uuidv4(), tenantId]);
      await seedCategories(tenantId);

      // Define a assinatura conforme os parâmetros
      const trialEnds = new Date(); trialEnds.setDate(trialEnds.getDate() + (trial_days || 15));

      if (plan === 'admin') {
        await createAdminSubscription(tenantId);
        if (plan === 'admin') await run(`UPDATE users SET role='admin' WHERE id=?`, [userId]);
      } else if (lifetime) {
        const far = '2099-12-31T23:59:59.000Z';
        await run(`INSERT INTO subscriptions (id,tenant_id,plan,status,trial_ends_at,current_period_start,current_period_end) VALUES (?,?,?,'active',?,NOW(),?)`,
          [uuidv4(), tenantId, plan, trialEnds.toISOString(), far]);
      } else if (expiry_date) {
        const isoExpiry = new Date(expiry_date).toISOString();
        await run(`INSERT INTO subscriptions (id,tenant_id,plan,status,trial_ends_at,current_period_start,current_period_end) VALUES (?,?,?,'active',?,NOW(),?)`,
          [uuidv4(), tenantId, plan, trialEnds.toISOString(), isoExpiry]);
      } else {
        // Trial padrão
        await run(`INSERT INTO subscriptions (id,tenant_id,plan,status,trial_ends_at) VALUES (?,?,'trial','active',?) ON CONFLICT (tenant_id) DO NOTHING`,
          [uuidv4(), tenantId, trialEnds.toISOString()]);
      }
    });

    res.status(201).json({
      ok: true,
      tenant_id: tenantId,
      user_id: userId,
      email: email.toLowerCase(),
      name,
      plan: lifetime ? `${plan} (vitalício)` : plan,
      referral_code: refCode,
      message: `Conta criada com sucesso para ${email}`,
    });
  } catch(err) {
    console.error('[admin/create-account]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Alterar senha de qualquer usuário ─────────────────────────────────────────
router.post('/reset-password', verifyToken, adminOnly, async (req, res) => {
  try {
    const { email, new_password } = req.body;
    if (!email || !new_password) return res.status(400).json({ error: 'email e new_password obrigatórios' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Senha mínimo 6 caracteres' });

    const user = await queryOne('SELECT id FROM users WHERE email=?', [email.toLowerCase()]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const hash = await hashPassword(new_password);
    await run('UPDATE users SET password_hash=?, login_attempts=0, locked_until=NULL WHERE id=?', [hash, user.id]);
    res.json({ ok: true, message: `Senha de ${email} alterada com sucesso` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Bloquear / desbloquear ────────────────────────────────────────────────────
router.post('/block/:tenantId', verifyToken, adminOnly, async (req, res) => {
  await run(`UPDATE subscriptions SET plan='blocked', status='expired' WHERE tenant_id=?`, [req.params.tenantId]);
  res.json({ ok: true });
});

router.post('/unblock/:tenantId', verifyToken, adminOnly, async (req, res) => {
  const newEnd = new Date(); newEnd.setDate(newEnd.getDate() + 7);
  await run(`UPDATE subscriptions SET plan='trial', status='active', trial_ends_at=? WHERE tenant_id=?`,
    [newEnd.toISOString(), req.params.tenantId]);
  res.json({ ok: true });
});

// ── Deletar conta (cuidado!) ───────────────────────────────────────────────────
router.delete('/tenant/:tenantId', verifyToken, adminOnly, async (req, res) => {
  const sub = await queryOne('SELECT plan FROM subscriptions WHERE tenant_id=?', [req.params.tenantId]);
  if (sub?.plan === 'admin') return res.status(403).json({ error: 'Não é possível deletar uma conta admin' });
  await run('DELETE FROM tenants WHERE id=?', [req.params.tenantId]);
  res.json({ ok: true, message: 'Conta deletada (cascade apaga todos os dados)' });
});

module.exports = router;
