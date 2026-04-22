'use strict';
const { Pool } = require('pg');

// ── Conexão PostgreSQL ─────────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.PGHOST     || 'postgres',
  port:     parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'financehub',
  user:     process.env.PGUSER     || 'financehub',
  password: process.env.PGPASSWORD || 'financehub_secret',
  max:      20,
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => console.error('[pg] Unexpected pool error:', err.message));

// ── Helpers síncronos-like (usam pool internamente mas são async) ─────────────
// Toda a camada de dados usa await query()/queryOne()/run()
// O código das rotas usa top-level await via async handlers

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  const result = await pool.query(sql, params);
  return result;
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Migrações: cria tabelas se não existirem ─────────────────────────────────
async function migrate() {
  console.log('[db] Running migrations...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL,
      name        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT,
      email          TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      name           TEXT NOT NULL,
      role           TEXT NOT NULL DEFAULT 'owner',
      status         TEXT NOT NULL DEFAULT 'active',
      login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until   TIMESTAMPTZ,
      last_login     TIMESTAMPTZ,
      referral_code  TEXT UNIQUE,
      referred_by    TEXT,
      cpf            TEXT UNIQUE,
      login_name     TEXT UNIQUE,
      cpf_verified   INTEGER DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id                     TEXT PRIMARY KEY,
      tenant_id              TEXT NOT NULL UNIQUE,
      plan                   TEXT NOT NULL DEFAULT 'trial',
      status                 TEXT NOT NULL DEFAULT 'active',
      trial_ends_at          TIMESTAMPTZ NOT NULL,
      current_period_start   TIMESTAMPTZ,
      current_period_end     TIMESTAMPTZ,
      price_cents            INTEGER,
      extra_cpf_count        INTEGER NOT NULL DEFAULT 0,
      extra_cpf_trial_count  INTEGER NOT NULL DEFAULT 0,
      referral_months_credit INTEGER NOT NULL DEFAULT 0,
      referral_pct_credit    NUMERIC NOT NULL DEFAULT 0,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pix_payments (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      plan           TEXT NOT NULL,
      amount_cents   INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      pix_key        TEXT,
      pix_qrcode     TEXT,
      pix_copy_paste TEXT,
      paid_at        TIMESTAMPTZ,
      expires_at     TIMESTAMPTZ NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id            TEXT PRIMARY KEY,
      referrer_id   TEXT NOT NULL,
      referred_id   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      reward_type   TEXT,
      reward_value  NUMERIC,
      confirmed_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (referrer_id) REFERENCES users(id),
      FOREIGN KEY (referred_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS tenant_members (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      user_id         TEXT,
      invite_email    TEXT,
      invite_token    TEXT,
      name            TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      permissions     TEXT NOT NULL DEFAULT '["view_transactions"]',
      entity_scope    TEXT,
      is_extra_cpf    INTEGER NOT NULL DEFAULT 0,
      trial_ends_at   TIMESTAMPTZ,
      monthly_cost    INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id, invite_email),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS entities (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      label           TEXT NOT NULL,
      document        TEXT,
      type            TEXT NOT NULL DEFAULT 'cpf',
      color           TEXT NOT NULL DEFAULT '#00e5a0',
      tax_regime      TEXT,
      clt_salary      NUMERIC,
      clt_inss_pct    NUMERIC,
      clt_irrf_pct    NUMERIC,
      benefit_health  NUMERIC DEFAULT 0,
      benefit_food    NUMERIC DEFAULT 0,
      benefit_transport NUMERIC DEFAULT 0,
      benefit_other   NUMERIC DEFAULT 0,
      das_amount      NUMERIC DEFAULT 0,
      simples_rate    NUMERIC DEFAULT 0,
      pro_labore      NUMERIC DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      entity_id    TEXT,
      name         TEXT NOT NULL,
      bank         TEXT NOT NULL,
      type         TEXT NOT NULL DEFAULT 'checking',
      color        TEXT NOT NULL DEFAULT '#0077ff',
      balance      NUMERIC NOT NULL DEFAULT 0,
      credit_limit NUMERIC,
      closing_day  INTEGER,
      due_day      INTEGER,
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      name        TEXT NOT NULL,
      icon        TEXT DEFAULT '💰',
      color       TEXT DEFAULT '#00e5a0',
      type        TEXT NOT NULL DEFAULT 'expense',
      income_type TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS income_sources (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL,
      entity_id        TEXT,
      name             TEXT NOT NULL,
      type             TEXT NOT NULL,
      amount           NUMERIC NOT NULL DEFAULT 0,
      gross_salary     NUMERIC DEFAULT 0,
      inss_deduction   NUMERIC DEFAULT 0,
      irrf_deduction   NUMERIC DEFAULT 0,
      other_deductions NUMERIC DEFAULT 0,
      net_salary       NUMERIC DEFAULT 0,
      gross_revenue    NUMERIC DEFAULT 0,
      tax_regime       TEXT,
      das_amount       NUMERIC DEFAULT 0,
      simples_rate     NUMERIC DEFAULT 0,
      pro_labore       NUMERIC DEFAULT 0,
      income_tax_pj    NUMERIC DEFAULT 0,
      benefit_health   NUMERIC DEFAULT 0,
      benefit_food     NUMERIC DEFAULT 0,
      benefit_transport NUMERIC DEFAULT 0,
      is_active        INTEGER NOT NULL DEFAULT 1,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id                   TEXT PRIMARY KEY,
      tenant_id            TEXT NOT NULL,
      account_id           TEXT,
      entity_id            TEXT,
      category_id          TEXT,
      income_source_id     TEXT,
      description          TEXT NOT NULL,
      amount               NUMERIC NOT NULL,
      flow                 TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'paid',
      date                 DATE NOT NULL,
      notes                TEXT,
      is_recurring         INTEGER NOT NULL DEFAULT 0,
      recurring_id         TEXT,
      installment_id       TEXT,
      source               TEXT DEFAULT 'manual',
      import_hash          TEXT,
      installment_group    TEXT,
      installment_number   INTEGER,
      installment_total    INTEGER,
      installment_amount   NUMERIC,
      merged_from          TEXT,
      is_merged            INTEGER NOT NULL DEFAULT 0,
      created_by           TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id)   REFERENCES tenants(id)    ON DELETE CASCADE,
      FOREIGN KEY (account_id)  REFERENCES accounts(id)   ON DELETE SET NULL,
      FOREIGN KEY (entity_id)   REFERENCES entities(id)   ON DELETE SET NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS recurring_contracts (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      account_id    TEXT,
      entity_id     TEXT,
      category_id   TEXT,
      description   TEXT NOT NULL,
      amount        NUMERIC NOT NULL,
      flow          TEXT NOT NULL,
      frequency     TEXT NOT NULL,
      custom_days   INTEGER,
      start_date    DATE NOT NULL,
      end_date      DATE,
      next_due_date DATE NOT NULL,
      day_of_month  INTEGER,
      status        TEXT NOT NULL DEFAULT 'active',
      auto_launch   INTEGER NOT NULL DEFAULT 1,
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id)   REFERENCES tenants(id)    ON DELETE CASCADE,
      FOREIGN KEY (account_id)  REFERENCES accounts(id)   ON DELETE SET NULL,
      FOREIGN KEY (entity_id)   REFERENCES entities(id)   ON DELETE SET NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS installment_contracts (
      id                 TEXT PRIMARY KEY,
      tenant_id          TEXT NOT NULL,
      account_id         TEXT,
      entity_id          TEXT,
      category_id        TEXT,
      description        TEXT NOT NULL,
      type               TEXT NOT NULL DEFAULT 'installment',
      total_amount       NUMERIC NOT NULL,
      financed_amount    NUMERIC NOT NULL,
      down_payment       NUMERIC NOT NULL DEFAULT 0,
      interest_rate      NUMERIC NOT NULL DEFAULT 0,
      total_installments INTEGER NOT NULL,
      paid_installments  INTEGER NOT NULL DEFAULT 0,
      installment_amount NUMERIC NOT NULL,
      start_date         DATE NOT NULL,
      end_date           DATE NOT NULL,
      first_due_date     DATE NOT NULL,
      day_of_month       INTEGER NOT NULL,
      status             TEXT NOT NULL DEFAULT 'active',
      notes              TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id)   REFERENCES tenants(id)    ON DELETE CASCADE,
      FOREIGN KEY (account_id)  REFERENCES accounts(id)   ON DELETE SET NULL,
      FOREIGN KEY (entity_id)   REFERENCES entities(id)   ON DELETE SET NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS installments (
      id             TEXT PRIMARY KEY,
      contract_id    TEXT NOT NULL,
      tenant_id      TEXT NOT NULL,
      number         INTEGER NOT NULL,
      amount         NUMERIC NOT NULL,
      principal      NUMERIC,
      interest       NUMERIC,
      due_date       DATE NOT NULL,
      paid_date      DATE,
      status         TEXT NOT NULL DEFAULT 'pending',
      transaction_id TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (contract_id) REFERENCES installment_contracts(id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id)   REFERENCES tenants(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS debts (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL,
      transaction_id   TEXT,
      entity_id        TEXT,
      description      TEXT NOT NULL,
      original_amount  NUMERIC NOT NULL,
      remaining_amount NUMERIC NOT NULL,
      status           TEXT NOT NULL DEFAULT 'active',
      creditor         TEXT,
      notes            TEXT,
      payment_start_date DATE,
      payment_type     TEXT,
      payment_amount   NUMERIC,
      payment_pct      NUMERIC,
      installment_count INTEGER,
      linked_contract_id TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id)      REFERENCES tenants(id)       ON DELETE CASCADE,
      FOREIGN KEY (entity_id)      REFERENCES entities(id)      ON DELETE SET NULL,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id)  ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS reconciliation (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL,
      transaction_id   TEXT NOT NULL UNIQUE,
      responsible_id   TEXT,
      responsible_type TEXT,
      responsible_name TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      notes            TEXT,
      reconciled_at    TIMESTAMPTZ,
      installment_qty  INTEGER,
      installment_value NUMERIC,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id)      REFERENCES tenants(id)      ON DELETE CASCADE,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bills (
      id                  TEXT PRIMARY KEY,
      tenant_id           TEXT NOT NULL,
      account_id          TEXT,
      entity_id           TEXT,
      category_id         TEXT,
      description         TEXT NOT NULL,
      amount              NUMERIC NOT NULL,
      due_date            DATE NOT NULL,
      paid_date           DATE,
      status              TEXT NOT NULL DEFAULT 'pending',
      recurrence          TEXT,
      installments        INTEGER DEFAULT 1,
      current_installment INTEGER DEFAULT 1,
      notes               TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id)   REFERENCES tenants(id)    ON DELETE CASCADE,
      FOREIGN KEY (account_id)  REFERENCES accounts(id)   ON DELETE SET NULL,
      FOREIGN KEY (entity_id)   REFERENCES entities(id)   ON DELETE SET NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS member_activity (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      action     TEXT NOT NULL,
      count      INTEGER NOT NULL DEFAULT 1,
      last_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      month      TEXT NOT NULL,
      UNIQUE(tenant_id, user_id, action, month),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      user_id    TEXT,
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      message    TEXT NOT NULL,
      ref_id     TEXT,
      ref_type   TEXT,
      read_at    TIMESTAMPTZ,
      sent_email INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    -- Índices
    CREATE INDEX IF NOT EXISTS idx_tx_tenant      ON transactions(tenant_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_account     ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_tx_entity      ON transactions(entity_id);
    CREATE INDEX IF NOT EXISTS idx_tx_status      ON transactions(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_tx_import_hash ON transactions(tenant_id, import_hash);
    CREATE INDEX IF NOT EXISTS idx_tx_inst_group  ON transactions(tenant_id, installment_group);
    CREATE INDEX IF NOT EXISTS idx_tx_created_by  ON transactions(created_by);
    CREATE INDEX IF NOT EXISTS idx_inst_contract  ON installments(contract_id);
    CREATE INDEX IF NOT EXISTS idx_inst_due       ON installments(tenant_id, due_date);
    CREATE INDEX IF NOT EXISTS idx_rec_next       ON recurring_contracts(tenant_id, next_due_date);
    CREATE INDEX IF NOT EXISTS idx_members        ON tenant_members(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_referrals      ON referrals(referrer_id);
    CREATE INDEX IF NOT EXISTS idx_income_tenant  ON income_sources(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_debts_tenant   ON debts(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_reconciliation ON reconciliation(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_bills_tenant   ON bills(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_bills_due      ON bills(tenant_id, due_date);
    CREATE INDEX IF NOT EXISTS idx_member_activity ON member_activity(tenant_id, user_id, month);
  `);

  console.log('[db] Migrations complete.');
}

// ── Helper: converte ? para $1, $2... (pg usa $N em vez de ?) ─────────────────
// Todas as queries do sistema usam ? — este helper converte automaticamente
const _origQuery    = query;
const _origQueryOne = queryOne;
const _origRun      = run;

function pgify(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Re-exporta com conversão automática de placeholders
module.exports = {
  pool,
  migrate,
  query:       (sql, params=[]) => _origQuery(pgify(sql), params),
  queryOne:    (sql, params=[]) => _origQueryOne(pgify(sql), params),
  run:         (sql, params=[]) => _origRun(pgify(sql), params),
  transaction,
};
