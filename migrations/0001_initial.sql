CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'টি',
  purchase_price_paisa INTEGER NOT NULL DEFAULT 0 CHECK(purchase_price_paisa >= 0),
  sale_price_paisa INTEGER NOT NULL DEFAULT 0 CHECK(sale_price_paisa >= 0),
  avg_cost_paisa INTEGER NOT NULL DEFAULT 0 CHECK(avg_cost_paisa >= 0),
  current_stock_milli INTEGER NOT NULL DEFAULT 0 CHECK(current_stock_milli >= 0),
  minimum_stock_milli INTEGER NOT NULL DEFAULT 0 CHECK(minimum_stock_milli >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  opening_due_paisa INTEGER NOT NULL DEFAULT 0 CHECK(opening_due_paisa >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  opening_due_paisa INTEGER NOT NULL DEFAULT 0 CHECK(opening_due_paisa >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('cash','bank')),
  opening_balance_paisa INTEGER NOT NULL DEFAULT 0,
  current_balance_paisa INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_no TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('purchase','sale','total_sale','customer_collection','supplier_payment','expense','other_income','cash_in','cash_out','stock_adjustment')),
  transaction_date TEXT NOT NULL,
  party_type TEXT,
  party_id INTEGER,
  account_id INTEGER,
  total_paisa INTEGER NOT NULL DEFAULT 0,
  paid_paisa INTEGER NOT NULL DEFAULT 0,
  due_paisa INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
  unit_cost_paisa INTEGER NOT NULL CHECK(unit_cost_paisa >= 0),
  line_total_paisa INTEGER NOT NULL CHECK(line_total_paisa >= 0)
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
  unit_sale_price_paisa INTEGER NOT NULL CHECK(unit_sale_price_paisa >= 0),
  unit_cost_paisa INTEGER NOT NULL CHECK(unit_cost_paisa >= 0),
  line_total_paisa INTEGER NOT NULL CHECK(line_total_paisa >= 0),
  cost_total_paisa INTEGER NOT NULL CHECK(cost_total_paisa >= 0)
);

CREATE TABLE IF NOT EXISTS cash_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount_paisa INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS party_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  party_type TEXT NOT NULL CHECK(party_type IN ('customer','supplier')),
  party_id INTEGER NOT NULL,
  amount_paisa INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('due','payment')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
  category TEXT NOT NULL,
  amount_paisa INTEGER NOT NULL CHECK(amount_paisa > 0)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_items(product_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_party_ledger_party ON party_ledger(party_type, party_id, id);
CREATE INDEX IF NOT EXISTS idx_cash_ledger_account ON cash_ledger(account_id, id);

INSERT OR IGNORE INTO accounts (id, code, name, type, opening_balance_paisa, current_balance_paisa) VALUES
(1, 'CASH', 'নগদ', 'cash', 0, 0),
(2, 'BANK', 'ব্যাংক/মোবাইল ব্যাংকিং', 'bank', 0, 0);
INSERT OR IGNORE INTO settings (key, value) VALUES ('business_name', 'CHAMAK STORE');
