/**
 * FinanceHub — Persistência em arquivo com criptografia AES-256-GCM
 * Cada usuário tem seu próprio arquivo cifrado em /data/<userId>.enc
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');

function userFile(userId) {
  // Sanitiza o userId para evitar path traversal
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DATA_DIR, `${safe}.enc`);
}

/**
 * Carrega e descriptografa os dados do usuário
 * Retorna estrutura padrão se o arquivo não existir ainda
 */
function loadUser(userId) {
  const file = userFile(userId);
  if (!fs.existsSync(file)) {
    return {
      transactions: [],
      accounts:     [],
      entities:     [{ id: 'CPF', label: 'CPF — Pessoal', color: '#00e5a0' }],
      createdAt:    new Date().toISOString(),
    };
  }
  const payload = fs.readFileSync(file, 'utf8');
  return decrypt(payload);
}

/**
 * Criptografa e persiste os dados do usuário no disco
 */
function saveUser(userId, data) {
  const file    = userFile(userId);
  const payload = encrypt(data);
  // Escrita atômica: grava em .tmp e renomeia
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, payload, { mode: 0o600 }); // apenas dono lê/escreve
  fs.renameSync(tmp, file);
}

/**
 * Apaga todos os dados de um usuário (GDPR / exclusão de conta)
 */
function deleteUser(userId) {
  const file = userFile(userId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { loadUser, saveUser, deleteUser };
