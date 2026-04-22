'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, run } = require('../db/database');
const { addExtraCpfMember, getStatus } = require('../services/subscription');

const PERMISSION_OPTIONS = [
  { key: 'view_transactions',  label: 'Ver transações' },
  { key: 'add_transactions',   label: 'Adicionar transações' },
  { key: 'view_accounts',      label: 'Ver contas/cartões' },
  { key: 'manage_accounts',    label: 'Gerenciar contas/cartões' },
  { key: 'view_cards',         label: 'Ver detalhes de cartão' },
  { key: 'view_income',        label: 'Ver rendas' },
  { key: 'add_income',         label: 'Adicionar rendas' },
  { key: 'view_reports',       label: 'Ver relatórios e análises' },
  { key: 'full_access',        label: 'Acesso total (co-administrador)' },
];

// GET /api/members — lista membros do tenant do usuário logado
router.get('/', async (req, res) => {
  const tenantId = req.user.tenantId;
  const members = await query(`
    SELECT tm.*, u.name as user_name, u.email as user_email, u.last_login,
      e.label as entity_label
    FROM tenant_members tm
    LEFT JOIN users u ON u.id=tm.user_id
    LEFT JOIN entities e ON e.tenant_id=tm.tenant_id AND e.document=tm.invite_email
    WHERE tm.tenant_id=?
    ORDER BY tm.created_at DESC
  `, [tenantId]);
  
  const status = await getStatus(tenantId);
  res.json({ members, permission_options: PERMISSION_OPTIONS, subscription: status });
});

// POST /api/members/invite — convidar CPF para a conta
router.post('/invite', async (req, res) => {
  const tenantId = req.user.tenantId;
  if (!['owner','admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Apenas o titular pode convidar membros' });

  const { email, name, permissions = ['view_transactions'], entity_scope = null } = req.body;
  if (!email) return res.status(400).json({ error: 'email obrigatório' });

  const existing = await queryOne('SELECT id FROM tenant_members WHERE tenant_id=? AND invite_email=?', [tenantId, email.toLowerCase()]);
  if (existing) return res.status(409).json({ error: 'Este e-mail já foi convidado' });

  const memberId    = uuidv4();
  const inviteToken = uuidv4().replace(/-/g,'');
  const trialEnd    = new Date(); trialEnd.setDate(trialEnd.getDate() + 30);

  // Verifica se o usuário já existe no sistema
  const existingUser = await queryOne('SELECT id FROM users WHERE email=?', [email.toLowerCase()]);

  await run(`INSERT INTO tenant_members 
    (id,tenant_id,user_id,invite_email,invite_token,name,status,permissions,entity_scope,is_extra_cpf,trial_ends_at,monthly_cost)
    VALUES (?,?,?,?,?,?,?,?,?,1,?,500)`,
    [memberId, tenantId, existingUser?.id||null, email.toLowerCase(), inviteToken,
     name||email, existingUser ? 'active' : 'pending',
     JSON.stringify(permissions), entity_scope ? JSON.stringify(entity_scope) : null,
     trialEnd.toISOString()]);

  res.status(201).json({
    member_id: memberId,
    invite_token: inviteToken,
    invite_link: `${process.env.APP_URL||'http://localhost:3000'}/invite/${inviteToken}`,
    trial_ends_at: trialEnd.toISOString(),
    message: existingUser ? 'Membro ativado' : 'Convite pendente — compartilhe o link',
  });
});

// PUT /api/members/:id/permissions — atualizar permissões
router.put('/:id/permissions', async (req, res) => {
  const tenantId = req.user.tenantId;
  if (!['owner','admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Apenas o titular pode alterar permissões' });

  const { permissions, entity_scope } = req.body;
  const member = await queryOne('SELECT id FROM tenant_members WHERE id=? AND tenant_id=?', [req.params.id, tenantId]);
  if (!member) return res.status(404).json({ error: 'Membro não encontrado' });

  await run(`UPDATE tenant_members SET permissions=?, entity_scope=? WHERE id=?`,
    [JSON.stringify(permissions), entity_scope ? JSON.stringify(entity_scope) : null, req.params.id]);

  res.json({ ok: true, member: await queryOne('SELECT * FROM tenant_members WHERE id=?', [req.params.id]) });
});

// DELETE /api/members/:id — remover membro
router.delete('/:id', async (req, res) => {
  const tenantId = req.user.tenantId;
  if (!['owner','admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Apenas o titular pode remover membros' });
  await run('DELETE FROM tenant_members WHERE id=? AND tenant_id=?', [req.params.id, tenantId]);
  res.json({ message: 'Membro removido' });
});

// GET /api/members/accept/:token — aceitar convite
router.get('/accept/:token', async (req, res) => {
  const member = await queryOne('SELECT * FROM tenant_members WHERE invite_token=?', [req.params.token]);
  if (!member) return res.status(404).json({ error: 'Convite inválido ou expirado' });
  const tenant = await queryOne('SELECT name FROM tenants WHERE id=?', [member.tenant_id]);
  res.json({ member, tenant_name: tenant?.name, invite_email: member.invite_email });
});

// POST /api/members/accept/:token — vincular usuário ao convite
router.post('/accept/:token', async (req, res) => {
  const member = await queryOne('SELECT * FROM tenant_members WHERE invite_token=?', [req.params.token]);
  if (!member) return res.status(404).json({ error: 'Convite inválido' });

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Faça login para aceitar o convite' });

  await run(`UPDATE tenant_members SET user_id=?, status='active', invite_token=NULL WHERE id=?`, [userId, member.id]);
  res.json({ ok: true, tenant_id: member.tenant_id });
});

// GET /api/members/my-accounts — contas que o usuário é membro
router.get('/my-accounts', async (req, res) => {
  const userId = req.user.id;
  const memberships = await query(`
    SELECT tm.*, t.name as tenant_name, u.name as owner_name, u.email as owner_email
    FROM tenant_members tm
    JOIN tenants t ON t.id=tm.tenant_id
    JOIN users u ON u.id=t.owner_id
    WHERE tm.user_id=? AND tm.status='active'
  `, [userId]);
  res.json(memberships);
});

module.exports = router;
