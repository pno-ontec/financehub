'use strict';
const router             = require('express').Router();
const { v4: uuidv4 }     = require('uuid');
const { hashPassword, verifyPassword } = require('../utils/crypto');
const { signAccess, signRefresh, verifyJWT, verifyToken } = require('../middleware/auth');
const { queryOne, run, transaction } = require('../db/database');
const { seedCategories }  = require('../db/seeds');
const { createTrial, createAdminSubscription } = require('../services/subscription');

const ADMIN_EMAIL = () => (process.env.ADMIN_EMAIL || 'admin@financehub.com.br').toLowerCase();

const COOKIE = { httpOnly:true, secure:process.env.NODE_ENV==='production', sameSite:'strict', path:'/' };

async function makeTokens(user) {
  const access  = signAccess ({ sub:user.id, email:user.email, name:user.name, tenantId:user.tenant_id, role:user.role });
  const refresh = signRefresh({ sub:user.id, type:'refresh' });
  return { access, refresh };
}

function genReferralCode(name) {
  const base = (name||'USER').replace(/[^a-zA-Z]/g,'').toUpperCase().slice(0,4).padEnd(4,'X');
  return base + Math.random().toString(36).slice(2,6).toUpperCase();
}

// ── Promoção automática a admin se email bater com ADMIN_EMAIL ────────────────
async function autoPromoteIfAdmin(userId, email, tenantId) {
  if (email.toLowerCase() === ADMIN_EMAIL()) {
    const user = await queryOne('SELECT role FROM users WHERE id=?', [userId]);
    if (user && user.role !== 'admin') {
      await run(`UPDATE users SET role='admin' WHERE id=?`, [userId]);
      await createAdminSubscription(tenantId);
      console.log(`[auth] Auto-promoted ${email} to admin`);
    }
  }
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, cpf, login_name } = req.body;
    if (!name||!email||!password) return res.status(400).json({ error: 'name, email e password são obrigatórios' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido' });

    const existing = await queryOne('SELECT id FROM users WHERE email=? OR (cpf IS NOT NULL AND cpf=?) OR (login_name IS NOT NULL AND login_name=?)',
      [email.toLowerCase(), cpf||'__none__', login_name||'__none__']);
    if (existing) return res.status(409).json({ error: 'E-mail, CPF ou login já cadastrado' });

    const isAdmin = email.toLowerCase() === ADMIN_EMAIL();
    const userId  = uuidv4(), tenantId = uuidv4();
    const hash    = await hashPassword(password);
    const role    = isAdmin ? 'admin' : 'owner';
    const refCode = genReferralCode(name);

    await transaction(async (client) => {
      await run('INSERT INTO tenants (id,owner_id,name) VALUES (?,?,?)', [tenantId, userId, `Conta de ${name}`]);
      await run(`INSERT INTO users (id,tenant_id,email,password_hash,name,role,referral_code,cpf,login_name,cpf_verified)
           VALUES (?,?,?,?,?,?,?,?,?,0)`,
        [userId, tenantId, email.toLowerCase(), hash, name, role, refCode,
         cpf||null, login_name||null]);
      await run(`INSERT INTO entities (id,tenant_id,label,type,color) VALUES (?,?,'CPF — Pessoal','cpf','#00e5a0')`,
        [uuidv4(), tenantId]);
      if (isAdmin) await createAdminSubscription(tenantId);
      else          await createTrial(tenantId);
      await seedCategories(tenantId);
    });

    const user = await queryOne('SELECT * FROM users WHERE id=?', [userId]);
    const { access, refresh } = await makeTokens(user);
    res.cookie('fh_access', access, { ...COOKIE, maxAge:15*60*1000 })
       .cookie('fh_refresh', refresh, { ...COOKIE, maxAge:7*24*60*60*1000 })
       .status(201).json({ user: safe(user), token: access });
  } catch (err) {
    console.error('[register]', err);
    res.status(500).json({ error: 'Erro ao criar conta: '+err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Aceita: email, CPF ou login_name no campo "identifier"
router.post('/login', async (req, res) => {
  try {
    const { email, password, identifier } = req.body;
    const id = (identifier || email || '').trim();
    if (!id||!password) return res.status(400).json({ error: 'Identificador e senha obrigatórios' });

    // Busca por email, cpf ou login_name
    const user = await queryOne(
      `SELECT * FROM users WHERE email=? OR cpf=? OR login_name=?`,
      [id.toLowerCase(), id, id.toLowerCase()]
    );
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });

    if (user.locked_until && new Date(user.locked_until) > new Date())
      return res.status(429).json({ error: `Conta bloqueada até ${new Date(user.locked_until).toLocaleTimeString('pt-BR')}` });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      const attempts = (user.login_attempts||0) + 1;
      if (attempts >= 5) {
        const lockUntil = new Date(); lockUntil.setMinutes(lockUntil.getMinutes()+30);
        await run('UPDATE users SET login_attempts=?,locked_until=? WHERE id=?', [attempts,lockUntil.toISOString(),user.id]);
        return res.status(429).json({ error: 'Muitas tentativas. Conta bloqueada por 30 minutos.' });
      }
      await run('UPDATE users SET login_attempts=? WHERE id=?', [attempts, user.id]);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    await run(`UPDATE users SET login_attempts=0,locked_until=NULL,last_login=NOW() WHERE id=?`, [user.id]);

    // Auto-promove se for o email admin
    await autoPromoteIfAdmin(user.id, user.email, user.tenant_id);

    // Relê o usuário após possível promoção
    const freshUser = await queryOne('SELECT * FROM users WHERE id=?', [user.id]);
    const { access, refresh } = await makeTokens(freshUser);
    res.cookie('fh_access', access, { ...COOKIE, maxAge:15*60*1000 })
       .cookie('fh_refresh', refresh, { ...COOKIE, maxAge:7*24*60*60*1000 })
       .json({ user: safe(freshUser), token: access });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const token = req.cookies?.fh_refresh;
    if (!token) return res.status(401).json({ error: 'Sem refresh token' });
    const decoded = verifyJWT(token);
    if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Token inválido' });
    const user = await queryOne('SELECT * FROM users WHERE id=?', [decoded.sub]);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
    await autoPromoteIfAdmin(user.id, user.email, user.tenant_id);
    const fresh = await queryOne('SELECT * FROM users WHERE id=?', [user.id]);
    const { access, refresh } = await makeTokens(fresh);
    res.cookie('fh_access', access, { ...COOKIE, maxAge:15*60*1000 })
       .cookie('fh_refresh', refresh, { ...COOKIE, maxAge:7*24*60*60*1000 })
       .json({ token: access });
  } catch { res.status(401).json({ error: 'Token expirado ou inválido' }); }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', verifyToken, async (req, res) => {
  const user = await queryOne('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  await autoPromoteIfAdmin(user.id, user.email, user.tenant_id);
  res.json(safe(await queryOne('SELECT * FROM users WHERE id=?', [req.user.id])));
});

// ── PUT /api/auth/profile ─────────────────────────────────────────────────────
router.put('/profile', verifyToken, async (req, res) => {
  try {
    const { name, login_name, cpf, current_password, new_password } = req.body;
    const user = await queryOne('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Não encontrado' });

    // Se CPF for alterado, verificar que não está em uso
    if (cpf && cpf !== user.cpf) {
      const cpfExists = await queryOne('SELECT id FROM users WHERE cpf=? AND id!=?', [cpf, user.id]);
      if (cpfExists) return res.status(409).json({ error: 'CPF já cadastrado por outro usuário' });
    }

    // login_name único
    if (login_name && login_name !== user.login_name) {
      const lnExists = await queryOne('SELECT id FROM users WHERE login_name=? AND id!=?', [login_name.toLowerCase(), user.id]);
      if (lnExists) return res.status(409).json({ error: 'Login já em uso' });
    }

    const sets = [], params = [];
    if (name)       { sets.push('name=?');       params.push(name); }
    if (login_name) { sets.push('login_name=?');  params.push(login_name.toLowerCase()); }
    if (cpf)        { sets.push('cpf=?');         params.push(cpf); }

    if (new_password) {
      if (!current_password) return res.status(400).json({ error: 'Informe a senha atual' });
      const ok = await verifyPassword(current_password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });
      if (new_password.length < 6) return res.status(400).json({ error: 'Nova senha mínimo 6 caracteres' });
      sets.push('password_hash=?');
      params.push(await hashPassword(new_password));
    }

    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
    params.push(user.id);
    await run(`UPDATE users SET ${sets.join(',')} WHERE id=?`, params);
    res.json(safe(await queryOne('SELECT * FROM users WHERE id=?', [user.id])));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', (_req, res) => {
  res.clearCookie('fh_access').clearCookie('fh_refresh').json({ ok: true });
});

// ── POST /api/auth/promote-admin ──────────────────────────────────────────────
// Promove a conta do ADMIN_EMAIL configurado (útil quando conta já existia)
router.post('/promote-admin', verifyToken, async (req, res) => {
  const adminEmail = ADMIN_EMAIL();
  const user = await queryOne('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (user.email.toLowerCase() !== adminEmail) {
    return res.status(403).json({ error: 'Este endpoint só funciona para a conta admin configurada no .env' });
  }
  await autoPromoteIfAdmin(user.id, user.email, user.tenant_id);
  const fresh = await queryOne('SELECT * FROM users WHERE id=?', [user.id]);
  // Gera novos tokens com role=admin
  const { access, refresh } = await makeTokens(fresh);
  const COOKIE = { httpOnly:true, secure:process.env.NODE_ENV==='production', sameSite:'strict', path:'/' };
  res.cookie('fh_access', access, { ...COOKIE, maxAge:15*60*1000 })
     .cookie('fh_refresh', refresh, { ...COOKIE, maxAge:7*24*60*60*1000 })
     .json({ ok: true, user: safe(fresh), token: access, message: 'Conta promovida a administrador master!' });
});

const safe = u => ({
  id:u.id, name:u.name, email:u.email, role:u.role,
  tenant_id:u.tenant_id, last_login:u.last_login, created_at:u.created_at,
  referral_code:u.referral_code, cpf:u.cpf, login_name:u.login_name,
});

module.exports = router;
