#!/usr/bin/env node
/**
 * FinanceHub — Script de configuração inicial
 * Gera chaves criptográficas seguras e cria o arquivo .env
 * Execute: node scripts/setup.js
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const readline = require('readline');

const ENV_FILE = path.join(__dirname, '..', '.env');

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   FinanceHub — Configuração Inicial       ║');
  console.log('╚══════════════════════════════════════════╝\n');

  if (fs.existsSync(ENV_FILE)) {
    const overwrite = await prompt('⚠️  Arquivo .env já existe. Sobrescrever? (s/N): ');
    if (overwrite.toLowerCase() !== 's') {
      console.log('Operação cancelada.\n');
      process.exit(0);
    }
  }

  const port    = await prompt('Porta do servidor [3000]: ') || '3000';
  const origins = await prompt('Domínio do site (ex: https://financehub.com.br): ') || 'http://localhost:3000';

  const jwtSecret  = randomHex(64);   // 512 bits
  const secretKey  = randomHex(32);   // 256 bits
  const keySalt    = randomHex(32);   // 256 bits

  const env = `# FinanceHub — Gerado automaticamente em ${new Date().toISOString()}
# NUNCA compartilhe ou comite este arquivo!

NODE_ENV=production
PORT=${port}

JWT_SECRET=${jwtSecret}
SECRET_KEY=${secretKey}
KEY_SALT=${keySalt}

ALLOWED_ORIGINS=${origins}
`;

  fs.writeFileSync(ENV_FILE, env, { mode: 0o600 });

  console.log('\n✅  Arquivo .env criado com sucesso!');
  console.log('   JWT_SECRET  : ' + jwtSecret.slice(0,16) + '...');
  console.log('   SECRET_KEY  : ' + secretKey.slice(0,16) + '...');
  console.log('   KEY_SALT    : ' + keySalt.slice(0,16)   + '...');
  console.log('\n🔒  Guarde uma cópia segura dessas chaves.');
  console.log('    Se perdê-las, NÃO será possível descriptografar os dados!\n');
  console.log('▶️   Próximo passo: npm install && npm start\n');
}

main().catch(err => { console.error(err); process.exit(1); });
