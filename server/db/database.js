'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_DIR  = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'financehub.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
  locked_until   TEXT,
  last_login     TEXT,
  referral_code  TEXT UNIQUE,
  referred_by    TEXT,
  cpf            TEXT UNIQUE,        -- CPF é a chave imutável (após verificação)
  login_name     TEXT UNIQUE,        -- apelido de login configurável
  cpf_verified   INTEGER DEFAULT 0,  -- CPF foi verificado/confirmado
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ── Planos: individual | family_s | family_m | family_l | admin
-- ── extra_cpf_count: quantos CPFs extras pagos foram ativados
CREATE TABLE IF NOT EXISTS subscriptions (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL UNIQUE,
  plan                   TEXT NOT NULL DEFAULT 'trial',
  status                 TEXT NOT NULL DEFAULT 'active',
  trial_ends_at          TEXT NOT NULL,
  current_period_start   TEXT,
  current_period_end     TEXT,
  price_cents            INTEGER,
  extra_cpf_count        INTEGER NOT NULL DEFAULT 0,   -- CPFs extras pagos ativos
  extra_cpf_trial_count  INTEGER NOT NULL DEFAULT 0,   -- CPFs em trial de 30 dias
  referral_months_credit INTEGER NOT NULL DEFAULT 0,
  referral_pct_credit    REAL NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
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
  paid_at        TEXT,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS referrals (
  id            TEXT PRIMARY KEY,
  referrer_id   TEXT NOT NULL,
  referred_id   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  reward_type   TEXT,
  reward_value  REAL,
  confirmed_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (referrer_id) REFERENCES users(id),
  FOREIGN KEY (referred_id) REFERENCES users(id)
);

-- ── Membros da conta (CPFs convidados)
-- permissions é JSON com array de strings:
--   "view_transactions" | "add_transactions" | "view_accounts" | "manage_accounts"
--   "view_cards" | "view_income" | "add_income" | "view_reports" | "full_access"
-- entity_scope: NULL=acessa tudo, ou JSON array de entity_ids que pode ver
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
  is_extra_cpf    INTEGER NOT NULL DEFAULT 0,   -- conta como CPF extra pago?
  trial_ends_at   TEXT,                          -- trial de 30d para CPF extra
  monthly_cost    INTEGER NOT NULL DEFAULT 0,    -- custo em centavos
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
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
  clt_salary      REAL,
  clt_inss_pct    REAL,
  clt_irrf_pct    REAL,
  benefit_health  REAL DEFAULT 0,
  benefit_food    REAL DEFAULT 0,
  benefit_transport REAL DEFAULT 0,
  benefit_other   REAL DEFAULT 0,
  das_amount      REAL DEFAULT 0,
  simples_rate    REAL DEFAULT 0,
  pro_labore      REAL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
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
  balance      REAL NOT NULL DEFAULT 0,
  credit_limit REAL,
  closing_day  INTEGER,
  due_day      INTEGER,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
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
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS income_sources (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  entity_id        TEXT,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,
  amount           REAL NOT NULL DEFAULT 0,
  gross_salary     REAL DEFAULT 0,
  inss_deduction   REAL DEFAULT 0,
  irrf_deduction   REAL DEFAULT 0,
  other_deductions REAL DEFAULT 0,
  net_salary       REAL DEFAULT 0,
  gross_revenue    REAL DEFAULT 0,
  tax_regime       TEXT,
  das_amount       REAL DEFAULT 0,
  simples_rate     REAL DEFAULT 0,
  pro_labore       REAL DEFAULT 0,
  income_tax_pj    REAL DEFAULT 0,
  benefit_health   REAL DEFAULT 0,
  benefit_food     REAL DEFAULT 0,
  benefit_transport REAL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  account_id       TEXT,
  entity_id        TEXT,
  category_id      TEXT,
  income_source_id TEXT,
  description      TEXT NOT NULL,
  amount           REAL NOT NULL,
  flow             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'paid',
  date             TEXT NOT NULL,
  notes            TEXT,
  is_recurring     INTEGER NOT NULL DEFAULT 0,
  recurring_id     TEXT,
  installment_id   TEXT,
  source           TEXT DEFAULT 'manual',
  import_hash          TEXT,    -- hash para deduplicação de importações
  installment_group    TEXT,    -- ID do grupo de parcelas (ex: "AMAZON-2024-01")
  installment_number   INTEGER, -- nº desta parcela no grupo
  installment_total    INTEGER, -- total de parcelas do grupo
  installment_amount   REAL,    -- valor de cada parcela
  merged_from          TEXT,    -- JSON array de tx_ids que foram mesclados neste
  is_merged            INTEGER NOT NULL DEFAULT 0,
  created_by           TEXT,    -- user_id de quem lançou
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
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
  amount        REAL NOT NULL,
  flow          TEXT NOT NULL,
  frequency     TEXT NOT NULL,
  custom_days   INTEGER,
  start_date    TEXT NOT NULL,
  end_date      TEXT,
  next_due_date TEXT NOT NULL,
  day_of_month  INTEGER,
  status        TEXT NOT NULL DEFAULT 'active',
  auto_launch   INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
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
  total_amount       REAL NOT NULL,
  financed_amount    REAL NOT NULL,
  down_payment       REAL NOT NULL DEFAULT 0,
  interest_rate      REAL NOT NULL DEFAULT 0,
  total_installments INTEGER NOT NULL,
  paid_installments  INTEGER NOT NULL DEFAULT 0,
  installment_amount REAL NOT NULL,
  start_date         TEXT NOT NULL,
  end_date           TEXT NOT NULL,
  first_due_date     TEXT NOT NULL,
  day_of_month       INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
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
  amount         REAL NOT NULL,
  principal      REAL,
  interest       REAL,
  due_date       TEXT NOT NULL,
  paid_date      TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  transaction_id TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (contract_id) REFERENCES installment_contracts(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id)   REFERENCES tenants(id) ON DELETE CASCADE
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
  read_at    TEXT,
  sent_email INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ── Dívidas ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS debts (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  transaction_id  TEXT,          -- transação original que virou dívida
  entity_id       TEXT,
  description     TEXT NOT NULL,
  original_amount REAL NOT NULL,
  remaining_amount REAL NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active', -- active | negotiating | paid | written_off
  creditor        TEXT,          -- nome do credor
  notes           TEXT,
  -- Programação de pagamento
  payment_start_date TEXT,
  payment_type    TEXT,          -- installment | percentage | lump_sum
  payment_amount  REAL,          -- valor fixo por período
  payment_pct     REAL,          -- % da renda para quitar
  installment_count INTEGER,
  linked_contract_id TEXT,       -- FK para installment_contracts
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id)   REFERENCES tenants(id)       ON DELETE CASCADE,
  FOREIGN KEY (entity_id)   REFERENCES entities(id)      ON DELETE SET NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);

-- ── Conciliação ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reconciliation (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE,
  responsible_id TEXT,
  responsible_type TEXT,
  responsible_name TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  notes          TEXT,
  reconciled_at  TEXT,
  installment_qty   INTEGER,     -- nº de parcelas informadas na conciliação
  installment_value REAL,        -- valor de cada parcela
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id)      REFERENCES tenants(id)      ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

-- ── Score de utilização por membro ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS member_activity (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  action         TEXT NOT NULL,  -- login | tx_add | tx_import | report_view | etc
  count          INTEGER NOT NULL DEFAULT 1,
  last_at        TEXT NOT NULL DEFAULT (datetime('now')),
  month          TEXT NOT NULL,  -- YYYY-MM
  UNIQUE(tenant_id, user_id, action, month),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_tx_tenant     ON transactions(tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_tx_account    ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_entity     ON transactions(entity_id);
CREATE INDEX IF NOT EXISTS idx_tx_status     ON transactions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tx_created_by ON transactions(created_by);
CREATE INDEX IF NOT EXISTS idx_tx_import_hash ON transactions(tenant_id, import_hash);
CREATE INDEX IF NOT EXISTS idx_inst_contract ON installments(contract_id);
CREATE INDEX IF NOT EXISTS idx_inst_due      ON installments(tenant_id, due_date);
CREATE INDEX IF NOT EXISTS idx_rec_next      ON recurring_contracts(tenant_id, next_due_date);
CREATE INDEX IF NOT EXISTS idx_members       ON tenant_members(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_referrals     ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_income_tenant ON income_sources(tenant_id);
CREATE INDEX IF NOT EXISTS idx_debts_tenant ON debts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_reconciliation ON reconciliation(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_member_activity ON member_activity(tenant_id, user_id, month);
`);

// ── Migrações automáticas (adiciona colunas que podem não existir) ──────────────
function safeAddColumn(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[migration] Added column ${table}.${column}`);
  } catch(e) {
    // Coluna já existe — ignora silenciosamente
    if (!e.message.includes('duplicate column')) {
      // Se for outro erro, loga mas não quebra
      console.warn(`[migration] ${e.message}`);
    }
  }
}

// Garante colunas adicionadas em versões recentes
safeAddColumn('transactions', 'import_hash',     'TEXT');
safeAddColumn('transactions', 'created_by',      'TEXT');
safeAddColumn('users',        'referral_code',    'TEXT');
safeAddColumn('users',        'cpf',              'TEXT');
safeAddColumn('users',        'login_name',       'TEXT');
safeAddColumn('users',        'cpf_verified',     'INTEGER DEFAULT 0');
safeAddColumn('users',        'referred_by',      'TEXT');
safeAddColumn('subscriptions','extra_cpf_count',  'INTEGER NOT NULL DEFAULT 0');
safeAddColumn('subscriptions','extra_cpf_trial_count', 'INTEGER NOT NULL DEFAULT 0');
safeAddColumn('subscriptions','referral_months_credit', 'INTEGER NOT NULL DEFAULT 0');
safeAddColumn('subscriptions','referral_pct_credit', 'REAL NOT NULL DEFAULT 0');
safeAddColumn('tenant_members','is_extra_cpf',   'INTEGER NOT NULL DEFAULT 0');
safeAddColumn('tenant_members','trial_ends_at',  'TEXT');
safeAddColumn('tenant_members','monthly_cost',   'INTEGER NOT NULL DEFAULT 0');
safeAddColumn('tenant_members','invite_token',   'TEXT');
safeAddColumn('tenant_members','name',           'TEXT');
safeAddColumn('entities',     'tax_regime',      'TEXT');
safeAddColumn('entities',     'das_amount',      'REAL DEFAULT 0');
safeAddColumn('entities',     'simples_rate',    'REAL DEFAULT 0');
safeAddColumn('entities',     'pro_labore',      'REAL DEFAULT 0');
safeAddColumn('entities',     'benefit_health',  'REAL DEFAULT 0');
safeAddColumn('entities',     'benefit_food',    'REAL DEFAULT 0');
safeAddColumn('entities',     'benefit_transport','REAL DEFAULT 0');
safeAddColumn('entities',     'benefit_other',   'REAL DEFAULT 0');
safeAddColumn('categories',   'income_type',     'TEXT');
safeAddColumn('transactions', 'installment_group',  'TEXT');
safeAddColumn('transactions', 'installment_number', 'INTEGER');
safeAddColumn('transactions', 'installment_total',  'INTEGER');
safeAddColumn('transactions', 'installment_amount', 'REAL');
safeAddColumn('transactions', 'merged_from',        'TEXT');
safeAddColumn('transactions', 'is_merged',          'INTEGER NOT NULL DEFAULT 0');
safeAddColumn('reconciliation', 'installment_qty',   'INTEGER');
safeAddColumn('reconciliation', 'installment_value', 'REAL');

// Cria tabelas novas que podem não existir no banco antigo
try { db.exec(`
  CREATE TABLE IF NOT EXISTS income_sources (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_id TEXT, name TEXT NOT NULL,
    type TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, gross_salary REAL DEFAULT 0,
    inss_deduction REAL DEFAULT 0, irrf_deduction REAL DEFAULT 0,
    other_deductions REAL DEFAULT 0, net_salary REAL DEFAULT 0,
    gross_revenue REAL DEFAULT 0, tax_regime TEXT, das_amount REAL DEFAULT 0,
    simples_rate REAL DEFAULT 0, pro_labore REAL DEFAULT 0, income_tax_pj REAL DEFAULT 0,
    benefit_health REAL DEFAULT 0, benefit_food REAL DEFAULT 0,
    benefit_transport REAL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS debts (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, transaction_id TEXT, entity_id TEXT,
    description TEXT NOT NULL, original_amount REAL NOT NULL, remaining_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', creditor TEXT, notes TEXT,
    payment_start_date TEXT, payment_type TEXT, payment_amount REAL, payment_pct REAL,
    installment_count INTEGER, linked_contract_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reconciliation (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, transaction_id TEXT NOT NULL UNIQUE,
    responsible_id TEXT, responsible_type TEXT, responsible_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending', notes TEXT, reconciled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS member_activity (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
    action TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
    last_at TEXT NOT NULL DEFAULT (datetime('now')), month TEXT NOT NULL,
    UNIQUE(tenant_id, user_id, action, month)
  );
  CREATE TABLE IF NOT EXISTS bills (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, account_id TEXT, entity_id TEXT, category_id TEXT,
    description TEXT NOT NULL, amount REAL NOT NULL, due_date TEXT NOT NULL, paid_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending', recurrence TEXT, installments INTEGER DEFAULT 1,
    current_installment INTEGER DEFAULT 1, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS referrals (
    id TEXT PRIMARY KEY, referrer_id TEXT NOT NULL, referred_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', reward_type TEXT, reward_value REAL,
    confirmed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`); } catch(e) { console.warn('[migration] table creation:', e.message); }

// Índices novos (ignora se já existem)
const newIndexes = [
  'CREATE INDEX IF NOT EXISTS idx_tx_import_hash ON transactions(tenant_id, import_hash)',
  'CREATE INDEX IF NOT EXISTS idx_bills_tenant ON bills(tenant_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_bills_due ON bills(tenant_id, due_date)',
  'CREATE INDEX IF NOT EXISTS idx_tx_inst_group ON transactions(tenant_id, installment_group)',
  'CREATE INDEX IF NOT EXISTS idx_debts_tenant ON debts(tenant_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_reconciliation ON reconciliation(tenant_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_member_activity ON member_activity(tenant_id, user_id, month)',
  'CREATE INDEX IF NOT EXISTS idx_referrals ON referrals(referrer_id)',
  'CREATE INDEX IF NOT EXISTS idx_income_tenant ON income_sources(tenant_id)',
];
newIndexes.forEach(sql => { try { db.exec(sql); } catch {} });

const query      = (sql, params=[]) => db.prepare(sql).all(params);
const queryOne   = (sql, params=[]) => db.prepare(sql).get(params);
const run        = (sql, params=[]) => db.prepare(sql).run(params);
const transaction= (fn) => db.transaction(fn)();

module.exports = { db, query, queryOne, run, transaction };
