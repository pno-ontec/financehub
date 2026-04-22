/**
 * FinanceHub — Banco de usuários (arquivo cifrado único)
 * Em produção escalonável: substituir por PostgreSQL + pgcrypto
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./crypto');

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.enc');

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    return decrypt(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, encrypt(users), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

function findByEmail(email) {
  const users = loadUsers();
  return Object.values(users).find(u => u.email === email.toLowerCase()) || null;
}

function findById(id) {
  const users = loadUsers();
  return users[id] || null;
}

function createUser({ id, email, passwordHash, name }) {
  const users = loadUsers();
  if (Object.values(users).some(u => u.email === email.toLowerCase())) {
    throw new Error('E-mail já cadastrado');
  }
  users[id] = {
    id,
    email:        email.toLowerCase(),
    passwordHash,
    name,
    createdAt:    new Date().toISOString(),
    lastLogin:    null,
    loginAttempts: 0,
    lockedUntil:  null,
  };
  saveUsers(users);
  return users[id];
}

function updateUser(id, patch) {
  const users = loadUsers();
  if (!users[id]) throw new Error('Usuário não encontrado');
  users[id] = { ...users[id], ...patch };
  saveUsers(users);
  return users[id];
}

function recordLogin(id, success) {
  const users = loadUsers();
  if (!users[id]) return;
  if (success) {
    users[id].lastLogin    = new Date().toISOString();
    users[id].loginAttempts = 0;
    users[id].lockedUntil  = null;
  } else {
    users[id].loginAttempts = (users[id].loginAttempts || 0) + 1;
    if (users[id].loginAttempts >= 5) {
      // Bloqueia por 30 minutos após 5 tentativas
      users[id].lockedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    }
  }
  saveUsers(users);
}

module.exports = { findByEmail, findById, createUser, updateUser, recordLogin };
