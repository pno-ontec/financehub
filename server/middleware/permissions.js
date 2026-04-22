'use strict';
const { queryOne } = require('../db/database');

/**
 * Resolve o tenantId e permissões para a requisição.
 * Um usuário pode ser:
 *   - owner/admin do seu próprio tenant → acesso total
 *   - membro convidado de outro tenant → acesso limitado pelas permissions
 */
async function resolveContext(req, res, next) {
  const userId   = req.user.id;
  const userRole = req.user.role;

  // Se o header X-Tenant-Id foi enviado, o usuário quer operar naquele tenant
  const requestedTenant = req.headers['x-tenant-id'] || req.user.tenantId;

  // Caso 1: é o próprio tenant do usuário
  if (requestedTenant === req.user.tenantId) {
    req.tenantId    = req.user.tenantId;
    req.memberRole  = userRole;
    req.permissions = ['full_access'];
    req.entityScope = null; // acessa todas as entidades
    return next();
  }

  // Caso 2: é um tenant de terceiro — verifica membership
  const member = await queryOne(
    `SELECT * FROM tenant_members WHERE tenant_id=? AND user_id=? AND status='active'`,
    [requestedTenant, userId]
  );

  if (!member) {
    return res.status(403).json({ error: 'Sem acesso a esta conta' });
  }

  // Verifica se o trial de CPF extra expirou
  if (member.trial_ends_at && new Date(member.trial_ends_at) < new Date()) {
    // Trial expirou — verifica se o titular pagou pelo CPF extra
    const sub = await queryOne('SELECT extra_cpf_count FROM subscriptions WHERE tenant_id=?', [requestedTenant]);
    const paidExtras = sub?.extra_cpf_count || 0;
    const totalPaidMembers = await queryOne(
      `SELECT COUNT(*) as n FROM tenant_members WHERE tenant_id=? AND is_extra_cpf=1 AND status='active' AND (trial_ends_at IS NULL OR trial_ends_at < NOW())`,
      [requestedTenant]
    ).n;
    if (totalPaidMembers > paidExtras) {
      return res.status(402).json({
        error: 'Período de teste do CPF expirado',
        code: 'MEMBER_TRIAL_EXPIRED',
        member_id: member.id,
      });
    }
  }

  req.tenantId    = requestedTenant;
  req.memberRole  = 'member';
  req.permissions = JSON.parse(member.permissions || '["view_transactions"]');
  req.entityScope = member.entity_scope ? JSON.parse(member.entity_scope) : null;
  next();
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (req.permissions.includes('full_access')) return next();
    if (req.permissions.includes(perm)) return next();
    return res.status(403).json({ error: `Permissão negada: ${perm}` });
  };
}

module.exports = { resolveContext, requirePermission };
