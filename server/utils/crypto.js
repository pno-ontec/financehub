/**
 * FinanceHub — Utilitário de Criptografia
 * AES-256-GCM: cifra autenticada (confidencialidade + integridade)
 * Cada cifragem gera um IV aleatório único → nunca reutiliza padrões
 */

'use strict';

const crypto = require('crypto');

const ALGO      = 'aes-256-gcm';
const IV_LEN    = 16;   // bytes
const TAG_LEN   = 16;   // GCM authentication tag
const KEY_LEN   = 32;   // 256 bits

/**
 * Deriva uma chave de 256 bits a partir da SECRET_KEY do ambiente
 * Usa PBKDF2 com salt fixo por aplicação (salt vem do .env)
 */
function deriveKey() {
  const secret = process.env.SECRET_KEY;
  const salt   = process.env.KEY_SALT;

  if (!secret || !salt) {
    throw new Error('SECRET_KEY e KEY_SALT devem estar definidos no .env');
  }

  return crypto.pbkdf2Sync(secret, salt, 100_000, KEY_LEN, 'sha256');
}

/**
 * Criptografa um objeto JavaScript
 * @param {any} data - dado a cifrar (será serializado como JSON)
 * @returns {string} payload base64 no formato: iv:tag:ciphertext
 */
function encrypt(data) {
  const key        = deriveKey();
  const iv         = crypto.randomBytes(IV_LEN);
  const cipher     = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const plaintext  = JSON.stringify(data);
  const encrypted  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag        = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Descriptografa e retorna o objeto original
 * @param {string} payload - string no formato iv:tag:ciphertext
 * @returns {any} dado original
 */
function decrypt(payload) {
  const key             = deriveKey();
  const [ivB64, tagB64, ctB64] = payload.split(':');

  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error('Payload de criptografia inválido');
  }

  const iv         = Buffer.from(ivB64,  'base64');
  const tag        = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64,  'base64');

  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Hash seguro de senha com bcrypt (via bcryptjs)
 */
const bcrypt = require('bcryptjs');
const SALT_ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/**
 * Gera token aleatório seguro (para refresh tokens, reset, etc.)
 */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { encrypt, decrypt, hashPassword, verifyPassword, randomToken };
