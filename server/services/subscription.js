'use strict';
const { queryOne, query, run, transaction } = require('../db/database');
const { v4: uuidv4 } = require('uuid');

// ── Planos ────────────────────────────────────────────────────────────────────
const PLANS = {
  // Titular + 1 CPF extra incluído
  individual:  { price_cents: 2900,  label: 'Individual',      days: 30,  included_cpfs: 1, extra_cpf_cents: 500, description: '1 CPF titular · CPFs extras por R$5/mês cada' },
  // Titular + 3 CPFs extras incluídos (família pequena)
  family_s:    { price_cents: 4900,  label: 'Família S',        days: 30,  included_cpfs: 3, extra_cpf_cents: 400, description: '3 CPFs incluídos · R$49/mês · economia vs individual' },
  // Titular + 6 CPFs extras incluídos
  family_m:    { price_cents: 7900,  label: 'Família M',        days: 30,  included_cpfs: 6, extra_cpf_cents: 350, description: '6 CPFs incluídos · R$79/mês · melhor custo-benefício' },
  // Titular + 12 CPFs — para casais com dependentes e empresa
  family_l:    { price_cents: 12900, label: 'Família L',        days: 30,  included_cpfs: 12, extra_cpf_cents: 300, description: '12 CPFs incluídos · R$129/mês · controle total' },
  // Planos anuais com desconto
  individual_a:{ price_cents: 27900, label: 'Individual Anual', days: 365, included_cpfs: 1,  extra_cpf_cents: 500, description: '12x por R$23,25/mês · 2 meses grátis' },
  family_s_a:  { price_cents: 46900, label: 'Família S Anual',  days: 365, included_cpfs: 3,  extra_cpf_cents: 400, description: '12x por R$39,08/mês · 2 meses grátis' },
  family_m_a:  { price_cents: 75900, label: 'Família M Anual',  days: 365, included_cpfs: 6,  extra_cpf_cents: 350, description: '12x por R$63,25/mês · 2 meses grátis' },
  family_l_a:  { price_cents: 123900,label: 'Família L Anual',  days: 365, included_cpfs: 12, extra_cpf_cents: 300, description: '12x por R$103,25/mês · 2 meses grátis' },
  admin:       { price_cents: 0,     label: 'Admin',            days: 36500, included_cpfs: 999, extra_cpf_cents: 0, description: 'Acesso total sem cobrança' },
};

const PIX_KEY  = process.env.PIX_KEY  || '00000000000';
const PIX_NAME = process.env.PIX_NAME || 'FinanceHub';
const PIX_CITY = process.env.PIX_CITY || 'SAO PAULO';

// ── Trial ─────────────────────────────────────────────────────────────────────
function createTrial(tenantId) {
  const trialEnds = new Date();
  trialEnds.setDate(trialEnds.getDate() + 15);
  run(`INSERT OR IGNORE INTO subscriptions (id,tenant_id,plan,status,trial_ends_at) VALUES (?,?,'trial','active',?)`,
    [uuidv4(), tenantId, trialEnds.toISOString()]);
}

function createAdminSubscription(tenantId) {
  const far = new Date('2099-12-31').toISOString();
  const existing = queryOne('SELECT id FROM subscriptions WHERE tenant_id=?', [tenantId]);
  if (existing) {
    run(`UPDATE subscriptions SET plan='admin',status='active',current_period_start=datetime('now'),current_period_end=?,updated_at=datetime('now') WHERE tenant_id=?`,
      [far, tenantId]);
  } else {
    run(`INSERT INTO subscriptions (id,tenant_id,plan,status,trial_ends_at,current_period_start,current_period_end) VALUES (?,?,'admin','active',?,datetime('now'),?)`,
      [uuidv4(), tenantId, far, far]);
  }
}

// ── Status + custo de CPFs extras ─────────────────────────────────────────────
function getStatus(tenantId) {
  const sub = queryOne('SELECT * FROM subscriptions WHERE tenant_id=?', [tenantId]);
  if (!sub) return { allowed: false, reason: 'no_subscription' };

  const plan = PLANS[sub.plan] || PLANS.individual;
  const now  = new Date();

  // Conta CPFs extras ativos e em trial
  const extraMembers = query(
    `SELECT * FROM tenant_members WHERE tenant_id=? AND is_extra_cpf=1 AND status='active'`,
    [tenantId]
  );
  const extraActive = extraMembers.filter(m => !m.trial_ends_at || new Date(m.trial_ends_at) > now).length;
  const extraTrial  = extraMembers.filter(m => m.trial_ends_at && new Date(m.trial_ends_at) > now).length;
  const extraPaid   = sub.extra_cpf_count || 0;

  // Custo total mensal com CPFs extras
  const extraCpfCost = Math.max(0, extraActive - extraTrial) * (plan.extra_cpf_cents || 500);
  const totalMonthlyCents = plan.price_cents + extraCpfCost;

  const base = { plan: sub.plan, planLabel: plan.label, sub, extraActive, extraTrial, extraPaid, totalMonthlyCents, includedCpfs: plan.included_cpfs };

  if (sub.plan === 'admin') return { allowed: true, ...base, daysLeft: 99999 };

  if (sub.plan === 'trial') {
    const trialEnd = new Date(sub.trial_ends_at);
    const daysLeft = Math.ceil((trialEnd - now) / 86400000);
    if (now > trialEnd) return { allowed: false, reason: 'trial_expired', daysLeft: 0, ...base };
    return { allowed: true, daysLeft, ...base };
  }

  if (sub.status === 'active' && sub.current_period_end) {
    const periodEnd = new Date(sub.current_period_end);
    if (now > periodEnd) {
      run(`UPDATE subscriptions SET status='expired' WHERE id=?`, [sub.id]);
      return { allowed: false, reason: 'subscription_expired', ...base };
    }
    const daysLeft = Math.ceil((periodEnd - now) / 86400000);
    return { allowed: true, daysLeft, ...base };
  }

  return { allowed: false, reason: 'subscription_expired', ...base };
}

// ── Adicionar CPF como membro extra ───────────────────────────────────────────
function addExtraCpfMember(tenantId, memberId) {
  // Marca membro como extra e inicia trial de 30 dias
  const trialEnd = new Date();
  trialEnd.setDate(trialEnd.getDate() + 30);
  run(`UPDATE tenant_members SET is_extra_cpf=1, trial_ends_at=?, monthly_cost=500 WHERE id=? AND tenant_id=?`,
    [trialEnd.toISOString(), memberId, tenantId]);
}

// ── PIX ───────────────────────────────────────────────────────────────────────
function createPixCharge(tenantId, plan, referralCode) {
  const planData = PLANS[plan];
  if (!planData) throw new Error('Plano inválido: ' + plan);

  let finalCents = planData.price_cents;
  const sub = queryOne('SELECT * FROM subscriptions WHERE tenant_id=?', [tenantId]);
  if (sub && sub.referral_pct_credit > 0 && plan.endsWith('_a')) {
    finalCents = Math.round(finalCents * (1 - sub.referral_pct_credit / 100));
  }

  run(`UPDATE pix_payments SET status='cancelled' WHERE tenant_id=? AND status='pending'`, [tenantId]);

  const id = uuidv4(), txId = id.replace(/-/g,'').slice(0,25).toUpperCase();
  const expires = new Date(); expires.setHours(expires.getHours() + 24);
  const amount  = (finalCents / 100).toFixed(2);
  const payload = buildPixPayload(txId, amount, planData.label);

  run(`INSERT INTO pix_payments (id,tenant_id,plan,amount_cents,status,pix_key,pix_qrcode,pix_copy_paste,expires_at) VALUES (?,?,?,?,'pending',?,?,?,?)`,
    [id, tenantId, plan, finalCents, PIX_KEY, payload, payload, expires.toISOString()]);

  if (referralCode) {
    const referrer = queryOne('SELECT id FROM users WHERE referral_code=?', [referralCode]);
    if (referrer) {
      const buyer = queryOne('SELECT id FROM users WHERE tenant_id=?', [tenantId]);
      if (buyer && buyer.id !== referrer.id) {
        const existing = queryOne('SELECT id FROM referrals WHERE referred_id=?', [buyer.id]);
        if (!existing) {
          run(`INSERT INTO referrals (id,referrer_id,referred_id,status) VALUES (?,?,?,'pending')`,
            [uuidv4(), referrer.id, buyer.id]);
          run(`UPDATE users SET referred_by=? WHERE tenant_id=?`, [referrer.id, tenantId]);
        }
      }
    }
  }

  return { id, txId, plan, planData: {...planData, price_cents: finalCents}, payload, expires: expires.toISOString(), discountApplied: finalCents < planData.price_cents };
}

function confirmPixPayment(paymentId) {
  return transaction(() => {
    const payment = queryOne(`SELECT * FROM pix_payments WHERE id=? AND status='pending'`, [paymentId]);
    if (!payment) throw new Error('Cobrança não encontrada ou já processada');

    const plan = PLANS[payment.plan];
    const now  = new Date();
    const periodEnd = new Date();
    periodEnd.setDate(periodEnd.getDate() + plan.days);

    run(`UPDATE pix_payments SET status='paid', paid_at=? WHERE id=?`, [now.toISOString(), paymentId]);
    run(`UPDATE subscriptions SET plan=?,status='active',current_period_start=?,current_period_end=?,price_cents=?,referral_pct_credit=0,updated_at=? WHERE tenant_id=?`,
      [payment.plan, now.toISOString(), periodEnd.toISOString(), payment.amount_cents, now.toISOString(), payment.tenant_id]);

    processReferralReward(payment.tenant_id, payment.plan);
    return { ok: true, plan: payment.plan, validUntil: periodEnd.toISOString() };
  });
}

function processReferralReward(newTenantId, plan) {
  const buyer = queryOne('SELECT id, referred_by FROM users WHERE tenant_id=?', [newTenantId]);
  if (!buyer || !buyer.referred_by) return;
  const referral = queryOne(`SELECT * FROM referrals WHERE referred_id=? AND status='pending'`, [buyer.id]);
  if (!referral) return;
  const now = new Date().toISOString();

  // Indicado ganha +30 dias
  const indicadoSub = queryOne('SELECT * FROM subscriptions WHERE tenant_id=?', [newTenantId]);
  if (indicadoSub?.current_period_end) {
    const newEnd = new Date(indicadoSub.current_period_end);
    newEnd.setDate(newEnd.getDate() + 30);
    run(`UPDATE subscriptions SET current_period_end=? WHERE tenant_id=?`, [newEnd.toISOString(), newTenantId]);
  }

  // Indicador ganha +30 dias ou 10% de crédito (anual)
  const referrerUser = queryOne('SELECT tenant_id FROM users WHERE id=?', [buyer.referred_by]);
  if (referrerUser) {
    const refSub = queryOne('SELECT * FROM subscriptions WHERE tenant_id=?', [referrerUser.tenant_id]);
    if (refSub) {
      if (refSub.plan.endsWith('_a')) {
        const newPct = Math.min((refSub.referral_pct_credit || 0) + 10, 50);
        run(`UPDATE subscriptions SET referral_pct_credit=? WHERE tenant_id=?`, [newPct, referrerUser.tenant_id]);
      } else if (refSub.current_period_end) {
        const newEnd = new Date(refSub.current_period_end);
        newEnd.setDate(newEnd.getDate() + 30);
        run(`UPDATE subscriptions SET current_period_end=? WHERE tenant_id=?`, [newEnd.toISOString(), referrerUser.tenant_id]);
      } else {
        const newEnd = new Date(); newEnd.setDate(newEnd.getDate() + 30);
        run(`UPDATE subscriptions SET current_period_end=?,status='active' WHERE tenant_id=?`, [newEnd.toISOString(), referrerUser.tenant_id]);
      }
    }
  }
  run(`UPDATE referrals SET status='rewarded', confirmed_at=? WHERE id=?`, [now, referral.id]);
}

function addTrialDays(tenantId, days) {
  const sub = queryOne('SELECT * FROM subscriptions WHERE tenant_id=?', [tenantId]);
  if (!sub) return;
  if (sub.plan === 'trial') {
    const newEnd = new Date(sub.trial_ends_at);
    newEnd.setDate(newEnd.getDate() + days);
    run(`UPDATE subscriptions SET trial_ends_at=? WHERE tenant_id=?`, [newEnd.toISOString(), tenantId]);
  } else {
    const base = sub.current_period_end ? new Date(sub.current_period_end) : new Date();
    base.setDate(base.getDate() + days);
    run(`UPDATE subscriptions SET current_period_end=?,status='active' WHERE tenant_id=?`, [base.toISOString(), tenantId]);
  }
}

function buildPixPayload(txId, amount, description) {
  function tlv(id, value) { return `${id}${String(value.length).padStart(2,'0')}${value}`; }
  const ma = tlv('00','BR.GOV.BCB.PIX') + tlv('01',PIX_KEY);
  const p  = tlv('00','01') + tlv('26',ma) + tlv('52','0000') + tlv('53','986') +
    tlv('54',amount) + tlv('58','BR') + tlv('59',PIX_NAME.slice(0,25).padEnd(1)) +
    tlv('60',PIX_CITY.slice(0,15).padEnd(1)) + tlv('62',tlv('05',txId));
  return p + '6304' + crc16(p + '6304');
}
function crc16(str) {
  let crc = 0xFFFF;
  for (let i=0;i<str.length;i++){crc^=str.charCodeAt(i)<<8;for(let j=0;j<8;j++)crc=crc&0x8000?(crc<<1)^0x1021:crc<<1;}
  return ((crc&0xFFFF).toString(16).toUpperCase().padStart(4,'0'));
}

module.exports = { createTrial, createAdminSubscription, getStatus, createPixCharge, confirmPixPayment, addTrialDays, addExtraCpfMember, PLANS };
