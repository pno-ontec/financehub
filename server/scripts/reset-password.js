#!/usr/bin/env node
/**
 * FinanceHub — Reset de Senha via Terminal
 * Execute na VPS: node scripts/reset-password.js
 */
'use strict';

require('../utils/env-loader');
const readline = require('readline');
const { findByEmail, updateUser } = require('../utils/users');
const { hashPassword }            = require('../utils/crypto');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const q  = (p) => new Promise(r => rl.question(p, r));

async function main() {
  console.log('\n🔐 FinanceHub — Reset de Senha\n');
  const email    = await q('E-mail do usuário: ');
  const user     = findByEmail(email.trim());
  if (!user) { console.error('❌ Usuário não encontrado.'); process.exit(1); }
  console.log(`✓ Usuário encontrado: ${user.name}`);

  const pwd1 = await q('Nova senha (mín 10 chars, maiúscula, número, especial): ');
  const pwd2 = await q('Confirmar nova senha: ');
  if (pwd1 !== pwd2) { console.error('❌ Senhas não coincidem.'); process.exit(1); }
  if (pwd1.length < 10) { console.error('❌ Senha muito curta.'); process.exit(1); }

  const hash = await hashPassword(pwd1);
  updateUser(user.id, { passwordHash: hash, loginAttempts: 0, lockedUntil: null });
  console.log('\n✅ Senha redefinida com sucesso!\n');
  rl.close();
}

main().catch(e => { console.error(e); process.exit(1); });
