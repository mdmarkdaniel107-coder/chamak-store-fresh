
const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders
    }
  });

const bad = (message, status = 400) =>
  json({ ok: false, error: message }, status);

const nowDate = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
};

const money = n => Number.isSafeInteger(n) && n >= 0;
const qtyMilli = n => Number.isSafeInteger(n) && n > 0;
const roundMoney = (quantityMilli, unitPricePaisa) =>
  Math.round(quantityMilli * unitPricePaisa / 1000);

const newNo = prefix =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const d = new Date(`${value}T00:00:00Z`);

  return Number.isFinite(d.getTime()) &&
    d.toISOString().slice(0, 10) === value;
}

function transactionDate(value) {
  const date = value || nowDate();

  if (!validDate(date)) {
    throw new Error('লেনদেনের তারিখ সঠিক নয়।');
  }

  return date;
}

function cookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';

  const item = raw
    .split(';')
    .map(x => x.trim())
    .find(x => x.startsWith(`${name}=`));

  if (!item) return '';

  try {
    return decodeURIComponent(item.slice(name.length + 1));
  } catch {
    return '';
  }
}

async function signSession(expiry, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(String(expiry))
  );

  return [...new Uint8Array(signature)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function isAuthenticated(request, env) {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) return false;

  const token = cookieValue(request, 'chamak_session');
  const [expiryText, signature] = token.split('.');
  const expiry = Number(expiryText);

  if (
    !Number.isSafeInteger(expiry) ||
    expiry <= Math.floor(Date.now() / 1000) ||
    !signature
  ) {
    return false;
  }

  const expected = await signSession(expiry, env.SESSION_SECRET);

  if (signature.length !== expected.length) return false;

  let mismatch = 0;

  for (let i = 0; i < expected.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return mismatch === 0;
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error('সঠিক JSON তথ্য পাওয়া যায়নি।');
  }
}

async function run(db, sql, ...binds) {
  return db.prepare(sql).bind(...binds).run();
}

async function first(db, sql, ...binds) {
  return db.prepare(sql).bind(...binds).first();
}

async function all(db, sql, ...binds) {
  const result = await db.prepare(sql).bind(...binds).all();
  return result.results || [];
}

async function audit(db, action, type, id, details = '') {
  await run(
    db,
    'INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES(?,?,?,?)',
    action,
    type,
    id ?? null,
    details
  );
}

async function txExists(db, key) {
  if (!key) return null;

  return first(
    db,
    'SELECT id,transaction_no FROM transactions WHERE idempotency_key=?',
    key
  );
}

async function getAccount(db, id) {
  const account = await first(
    db,
    'SELECT * FROM accounts WHERE id=? AND active=1',
    id
  );

  if (!account) {
    throw new Error('নির্বাচিত নগদ/ব্যাংক হিসাব পাওয়া যায়নি।');
  }

  return account;
}

async function addCashStmt(db, txId, accountId, amount, direction, note) {
  if (!amount) return [];

  return [
    db.prepare(
      'INSERT INTO cash_ledger(transaction_id,account_id,amount_paisa,direction,note) VALUES(?,?,?,?,?)'
    ).bind(txId, accountId, amount, direction, note || null),

    db.prepare(
      'UPDATE accounts SET current_balance_paisa=current_balance_paisa + ? WHERE id=?'
    ).bind(direction === 'in' ? amount : -amount, accountId)
  ];
}

async function addPartyStmt(db, txId, partyType, partyId, amount, direction, note) {
  if (!partyId || !amount) return [];

  return [
    db.prepare(
      'INSERT INTO party_ledger(transaction_id,party_type,party_id,amount_paisa,direction,note) VALUES(?,?,?,?,?,?)'
    ).bind(txId, partyType, partyId, amount, direction, note || null)
  ];
}

function parseItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) {
    throw new Error('কমপক্ষে ১টি এবং সর্বোচ্চ ১০০টি পণ্য যোগ করুন।');
  }

  const parsed = items.map(item => {
    const productId = Number(item.product_id);
    const quantityMilli = Math.round(Number(item.quantity) * 1000);
    const unitPrice = Math.round(Number(item.unit_cost ?? item.unit_price) * 100);

    if (
      !Number.isSafeInteger(productId) ||
      productId < 1 ||
      !qtyMilli(quantityMilli) ||
      !money(unitPrice)
    ) {
      throw new Error('পণ্যের আইডি, পরিমাণ বা মূল্য সঠিক নয়।');
    }

    return { productId, quantityMilli, unitPrice };
  });

  if (new Set(parsed.map(x => x.productId)).size !== parsed.length) {
    throw new Error('একই পণ্য এক লেনদেনে একাধিক লাইনে দেবেন না। একই লাইনে পরিমাণ যোগ করুন।');
  }

  return parsed;
}

function newTransactionId() {
  return Date.now() * 4096 +
    (crypto.getRandomValues(new Uint16Array(1))[0] % 4096);
}

async function createPurchase(db, data) {
  const key = String(data.idempotency_key || '');
  const old = await txExists(db, key);

  if (old) {
    return {
      id: old.id,
      transaction_no: old.transaction_no,
      duplicate: true
    };
  }

  const items = parseItems(data.items || []);
  const supplierId = data.supplier_id ? Number(data.supplier_id) : null;
  const accountId = Number(data.account_id || 1);
  const paid = Math.round(Number(data.paid_amount || 0) * 100);
  const date = transactionDate(data.transaction_date);

  if (!money(paid)) {
    throw new Error('পরিশোধের পরিমাণ সঠিক নয়।');
  }

  const account = await getAccount(db, accountId);

  if (paid > Number(account.current_balance_paisa)) {
    throw new Error('হিসাবে পর্যাপ্ত টাকা নেই। আগে প্রারম্ভিক ব্যালেন্স ও নগদ হিসাব যাচাই করুন।');
  }

  if (
    supplierId &&
    !(await first(db, 'SELECT id FROM suppliers WHERE id=? AND active=1', supplierId))
  ) {
    throw new Error('সরবরাহকারী পাওয়া যায়নি।');
  }

  const products = [];

  for (const item of items) {
    const product = await first(
      db,
      'SELECT * FROM products WHERE id=? AND active=1',
      item.productId
    );

    if (!product) {
      throw new Error(`পণ্য ID ${item.productId} পাওয়া যায়নি।`);
    }

    products.push({
      ...item,
      product,
      line: roundMoney(item.quantityMilli, item.unitPrice)
    });
  }

  const total = products.reduce((sum, item) => sum + item.line, 0);

  if (!Number.isSafeInteger(total)) {
    throw new Error('ক্রয়ের মোট মূল্য গ্রহণযোগ্য সীমার বাইরে।');
  }

  if (paid > total) {
    throw new Error('পরিশোধের পরিমাণ ক্রয়ের মোট টাকার চেয়ে বেশি হতে পারবে না।');
  }

  const due = total - paid;

  if (due > 0 && !supplierId) {
    throw new Error('ক্রয়ে বাকি থাকলে সরবরাহকারী নির্বাচন করতে হবে।');
  }

  const no = newNo('PUR');
  const tid = newTransactionId();

  const statements = [
    db.prepare(
      'INSERT INTO transactions(id,transaction_no,type,transaction_date,party_type,party_id,account_id,total_paisa,paid_paisa,due_paisa,note,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      tid, no, 'purchase', date,
      supplierId ? 'supplier' : null,
      supplierId, accountId, total, paid, due,
      String(data.note || ''), key || null
    )
  ];

  for (const item of products) {
    const oldStock = Number(item.product.current_stock_milli);
    const newStock = oldStock + item.quantityMilli;

    if (!Number.isSafeInteger(newStock) || newStock < 0) {
      throw new Error('স্টকের পরিমাণ গ্রহণযোগ্য সীমার বাইরে।');
    }

    const avgCost = newStock === 0
      ? item.unitPrice
      : Math.round(
          (
            oldStock * Number(item.product.avg_cost_paisa) +
            item.quantityMilli * item.unitPrice
          ) / newStock
        );

    statements.push(
      db.prepare(
        'INSERT INTO purchase_items(transaction_id,product_id,quantity_milli,unit_cost_paisa,line_total_paisa) VALUES(?,?,?,?,?)'
      ).bind(tid, item.productId, item.quantityMilli, item.unitPrice, item.line)
    );

    statements.push(
      db.prepare(
        "UPDATE products SET current_stock_milli=?,avg_cost_paisa=?,purchase_price_paisa=?,updated_at=datetime('now') WHERE id=?"
      ).bind(newStock, avgCost, item.unitPrice, item.productId)
    );
  }

  statements.push(
    ...await addCashStmt(db, tid, accountId, paid, 'out', `ক্রয় ${no}`)
  );

  statements.push(
    ...await addPartyStmt(db, tid, 'supplier', supplierId, due, 'due', `ক্রয় ${no}`)
  );

  statements.push(
    db.prepare(
      'INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES(?,?,?,?)'
    ).bind(
      'create', 'purchase', tid,
      JSON.stringify({ no, total, paid, due })
    )
  );

  await db.batch(statements);

  return {
    id: tid,
    transaction_no: no,
    total_paisa: total,
    paid_paisa: paid,
    due_paisa: due
  };
}

async function createSale(db, data, totalOnly = false) {
  const key = String(data.idempotency_key || '');
  const old = await txExists(db, key);

  if (old) {
    return {
      id: old.id,
      transaction_no: old.transaction_no,
      duplicate: true
    };
  }

  const customerId = data.customer_id ? Number(data.customer_id) : null;
  const accountId = Number(data.account_id || 1);
  const paid = Math.round(Number(data.paid_amount || 0) * 100);
  const date = transactionDate(data.transaction_date);

  if (!money(paid)) {
    throw new Error('আদায়ের পরিমাণ সঠিক নয়।');
  }

  await getAccount(db, accountId);

  if (
    customerId &&
    !(await first(db, 'SELECT id FROM customers WHERE id=? AND active=1', customerId))
  ) {
    throw new Error('ক্রেতা পাওয়া যায়নি।');
  }

  const no = newNo(totalOnly ? 'TSL' : 'SAL');
  const tid = newTransactionId();

  let products = [];
  let total = 0;
  let cogs = 0;

  if (totalOnly) {
    total = Math.round(Number(data.total_amount || 0) * 100);

    if (!Number.isSafeInteger(total) || total < 1) {
      throw new Error('মোট বিক্রয়ের টাকা লিখুন।');
    }
  } else {
    const items = parseItems(data.items || []);

    for (const item of items) {
      const product = await first(
        db,
        'SELECT * FROM products WHERE id=? AND active=1',
        item.productId
      );

      if (!product) {
        throw new Error(`পণ্য ID ${item.productId} পাওয়া যায়নি।`);
      }

      if (Number(product.current_stock_milli) < item.quantityMilli) {
        throw new Error(
          `“${product.name}” পণ্যের স্টক যথেষ্ট নেই। বর্তমান স্টক: ${(Number(product.current_stock_milli) / 1000).toFixed(3)} ${product.unit}`
        );
      }

      const line = roundMoney(item.quantityMilli, item.unitPrice);
      const cost = roundMoney(
        item.quantityMilli,
        Number(product.avg_cost_paisa)
      );

      products.push({ ...item, product, line, cost });
      total += line;
      cogs += cost;
    }
  }

  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(cogs)
  ) {
    throw new Error('বিক্রয়ের হিসাব গ্রহণযোগ্য সীমার বাইরে।');
  }

  if (paid > total) {
    throw new Error('আদায়ের পরিমাণ বিক্রয়ের মোট টাকার চেয়ে বেশি হতে পারবে না।');
  }

  const due = total - paid;

  if (due > 0 && !customerId) {
    throw new Error('বিক্রয়ে বাকি থাকলে ক্রেতা নির্বাচন করতে হবে।');
  }

  const statements = [
    db.prepare(
      'INSERT INTO transactions(id,transaction_no,type,transaction_date,party_type,party_id,account_id,total_paisa,paid_paisa,due_paisa,note,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      tid, no, totalOnly ? 'total_sale' : 'sale', date,
      customerId ? 'customer' : null,
      customerId, accountId, total, paid, due,
      String(data.note || ''), key || null
    )
  ];

  for (const item of products) {
    statements.push(
      db.prepare(
        'INSERT INTO sale_items(transaction_id,product_id,quantity_milli,unit_sale_price_paisa,unit_cost_paisa,line_total_paisa,cost_total_paisa) VALUES(?,?,?,?,?,?,?)'
      ).bind(
        tid, item.productId, item.quantityMilli,
        item.unitPrice, Number(item.product.avg_cost_paisa),
        item.line, item.cost
      )
    );

    statements.push(
      db.prepare(
        "UPDATE products SET current_stock_milli=current_stock_milli-?,updated_at=datetime('now') WHERE id=? AND current_stock_milli>=?"
      ).bind(item.quantityMilli, item.productId, item.quantityMilli)
    );
  }

  statements.push(
    ...await addCashStmt(db, tid, accountId, paid, 'in', `বিক্রয় ${no}`)
  );

  statements.push(
    ...await addPartyStmt(db, tid, 'customer', customerId, due, 'due', `বিক্রয় ${no}`)
  );

  statements.push(
    db.prepare(
      'INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES(?,?,?,?)'
    ).bind(
      'create', totalOnly ? 'total_sale' : 'sale', tid,
      JSON.stringify({
        no, total, paid, due,
        cogs,
        gross_profit_paisa: totalOnly ? null : total - cogs
      })
    )
  );

  await db.batch(statements);

  return {
    id: tid,
    transaction_no: no,
    total_paisa: total,
    paid_paisa: paid,
    due_paisa: due,
    cogs_paisa: totalOnly ? null : cogs,
    gross_profit_paisa: totalOnly ? null : total - cogs,
    stock_changed: !totalOnly
  };
}

async function simpleMoneyTransaction(db, data, type) {
  const key = String(data.idempotency_key || '');
  const old = await txExists(db, key);

  if (old) {
    return {
      id: old.id,
      transaction_no: old.transaction_no,
      duplicate: true
    };
  }

  const amount = Math.round(Number(data.amount || 0) * 100);
  const accountId = Number(data.account_id || 1);
  const date = transactionDate(data.transaction_date);

  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('টাকার পরিমাণ সঠিকভাবে লিখুন।');
  }

  const account = await getAccount(db, accountId);

  if (
    ['supplier_payment', 'expense', 'cash_out'].includes(type) &&
    amount > Number(account.current_balance_paisa)
  ) {
    throw new Error('এই হিসাবে পর্যাপ্ত টাকা নেই। নগদ ও প্রারম্ভিক ব্যালেন্স যাচাই করুন।');
  }

  const no = newNo(type.toUpperCase().slice(0, 3));
  let partyType = null;
  let partyId = null;

  if (type === 'customer_collection') {
    partyType = 'customer';
    partyId = Number(data.customer_id);

    if (
      !partyId ||
      !(await first(db, 'SELECT id FROM customers WHERE id=? AND active=1', partyId))
    ) {
      throw new Error('ক্রেতা নির্বাচন করুন।');
    }

    const outstanding = await first(
      db,
      "SELECT COALESCE((SELECT opening_due_paisa FROM customers WHERE id=?),0)+COALESCE(SUM(CASE WHEN direction='due' THEN amount_paisa ELSE -amount_paisa END),0) AS due FROM party_ledger WHERE party_type='customer' AND party_id=?",
      partyId, partyId
    );

    if (amount > Math.max(0, Number(outstanding?.due || 0))) {
      throw new Error('আদায়ের টাকা ক্রেতার বর্তমান বকেয়ার চেয়ে বেশি।');
    }
  }

  if (type === 'supplier_payment') {
    partyType = 'supplier';
    partyId = Number(data.supplier_id);

    if (
      !partyId ||
      !(await first(db, 'SELECT id FROM suppliers WHERE id=? AND active=1', partyId))
    ) {
      throw new Error('সরবরাহকারী নির্বাচন করুন।');
    }

    const outstanding = await first(
      db,
      "SELECT COALESCE((SELECT opening_due_paisa FROM suppliers WHERE id=?),0)+COALESCE(SUM(CASE WHEN direction='due' THEN amount_paisa ELSE -amount_paisa END),0) AS due FROM party_ledger WHERE party_type='supplier' AND party_id=?",
      partyId, partyId
    );

    if (amount > Math.max(0, Number(outstanding?.due || 0))) {
      throw new Error('পরিশোধের টাকা সরবরাহকারীর বর্তমান দেনার চেয়ে বেশি।');
    }
  }

  const tid = newTransactionId();

  const statements = [
    db.prepare(
      'INSERT INTO transactions(id,transaction_no,type,transaction_date,party_type,party_id,account_id,total_paisa,paid_paisa,due_paisa,note,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      tid, no, type, date, partyType, partyId, accountId,
      amount, amount, 0,
      String(data.note || data.category || ''),
      key || null
    )
  ];

  const direction =
    ['other_income', 'customer_collection', 'cash_in'].includes(type)
      ? 'in'
      : 'out';

  statements.push(
    ...await addCashStmt(db, tid, accountId, amount, direction, `${type} ${no}`)
  );

  if (type === 'customer_collection') {
    statements.push(
      ...await addPartyStmt(db, tid, 'customer', partyId, amount, 'payment', `আদায় ${no}`)
    );
  }

  if (type === 'supplier_payment') {
    statements.push(
      ...await addPartyStmt(db, tid, 'supplier', partyId, amount, 'payment', `পরিশোধ ${no}`)
    );
  }

  if (type === 'expense') {
    statements.push(
      db.prepare(
        'INSERT INTO expenses(transaction_id,category,amount_paisa) VALUES(?,?,?)'
      ).bind(tid, String(data.category || 'অন্যান্য'), amount)
    );
  }

  statements.push(
    db.prepare(
      'INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES(?,?,?,?)'
    ).bind(
      'create', type, tid,
      JSON.stringify({ no, amount, partyId })
    )
  );

  await db.batch(statements);

  return {
    id: tid,
    transaction_no: no,
    amount_paisa: amount
  };
}

async function route(request, env) {
  const { DB } = env;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/session' && method === 'GET') {
    return json({
      ok: true,
      authenticated: await isAuthenticated(request, env),
      configured: !!(env.APP_PASSWORD && env.SESSION_SECRET)
    });
  }

  if (path === '/api/login' && method === 'POST') {
    if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
      return bad('লগইন চালু করতে Cloudflare-এ APP_PASSWORD ও SESSION_SECRET সেট করতে হবে।', 503);
    }

    const data = await bodyJson(request);

    if (
      typeof data.password !== 'string' ||
      data.password !== env.APP_PASSWORD
    ) {
      return bad('পাসওয়ার্ড সঠিক নয়।', 401);
    }

    const expiry = Math.floor(Date.now() / 1000) + 28800;
    const signature = await signSession(expiry, env.SESSION_SECRET);

    return json(
      { ok: true },
      200,
      {
        'set-cookie':
          `chamak_session=${expiry}.${signature}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`
      }
    );
  }

  if (path === '/api/logout' && method === 'POST') {
    return json(
      { ok: true },
      200,
      {
        'set-cookie':
          'chamak_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
      }
    );
  }

  if (path === '/api/health' && method === 'GET') {
    return json({ ok: true, app: 'CHAMAK STORE' });
  }

  if (!await isAuthenticated(request, env)) {
    return bad('লগইন করুন।', 401);
  }

  if (!DB) {
    return bad('D1 binding DB পাওয়া যায়নি। wrangler.toml পরীক্ষা করুন।', 500);
  }

  if (path === '/api/dashboard' && method === 'GET') {
    const [cash, products, customers, suppliers, sales, purchases,
      expenses, dues, low, stockValue] = await Promise.all([
      first(DB,
        'SELECT COALESCE(SUM(current_balance_paisa),0) AS value FROM accounts WHERE active=1'),

      first(DB,
        'SELECT COUNT(*) AS value FROM products WHERE active=1'),

      first(DB,
        'SELECT COUNT(*) AS value FROM customers WHERE active=1'),

      first(DB,
        'SELECT COUNT(*) AS value FROM suppliers WHERE active=1'),

      first(DB,
        "SELECT COALESCE(SUM(total_paisa),0) AS value FROM transactions WHERE type IN ('sale','total_sale') AND transaction_date=date('now','+6 hours')"),

      first(DB,
        "SELECT COALESCE(SUM(total_paisa),0) AS value FROM transactions WHERE type='purchase' AND transaction_date=date('now','+6 hours')"),

      first(DB,
        "SELECT COALESCE(SUM(e.amount_paisa),0) AS value FROM expenses e JOIN transactions t ON t.id=e.transaction_id WHERE t.transaction_date=date('now','+6 hours')"),

      first(DB,
        "SELECT COALESCE((SELECT SUM(opening_due_paisa) FROM customers WHERE active=1),0)+COALESCE(SUM(CASE WHEN direction='due' THEN amount_paisa ELSE -amount_paisa END),0) AS value FROM party_ledger WHERE party_type='customer'"),

      all(DB,
        'SELECT id,name,current_stock_milli,minimum_stock_milli,unit FROM products WHERE active=1 AND current_stock_milli<=minimum_stock_milli ORDER BY name LIMIT 8'),

      first(DB,
        'SELECT COALESCE(SUM(current_stock_milli*avg_cost_paisa/1000),0) AS value FROM products WHERE active=1')
    ]);

    return json({
      ok: true,
      summary: {
        cash_paisa: cash.value,
        product_count: products.value,
        customer_count: customers.value,
        supplier_count: suppliers.value,
        today_sales_paisa: sales.value,
        today_purchases_paisa: purchases.value,
        today_expenses_paisa: expenses.value,
        customer_due_paisa: dues.value,
        stock_value_paisa: stockValue.value
      },
      low_stock: low
    });
  }

  if (path === '/api/products' && method === 'GET') {
    return json({
      ok: true,
      items: await all(DB, 'SELECT * FROM products WHERE active=1 ORDER BY name')
    });
  }

  if (path === '/api/products' && method === 'POST') {
    const data = await bodyJson(request);
    const name = String(data.name || '').trim();

    if (!name) return bad('পণ্যের নাম আবশ্যক।');

    const sku = String(
      data.sku || `SKU-${Date.now().toString(36).toUpperCase()}`
    ).trim();

    const purchasePrice = Math.round(Number(data.purchase_price || 0) * 100);
    const salePrice = Math.round(Number(data.sale_price || 0) * 100);
    const minimum = Math.round(Number(data.minimum_stock || 0) * 1000);
    const opening = Math.round(Number(data.opening_stock || 0) * 1000);

    if (
      !money(purchasePrice) ||
      !money(salePrice) ||
      !Number.isSafeInteger(minimum) || minimum < 0 ||
      !Number.isSafeInteger(opening) || opening < 0
    ) {
      return bad('মূল্য বা স্টক সঠিক নয়।');
    }

    try {
      const result = await run(
        DB,
        'INSERT INTO products(sku,name,unit,purchase_price_paisa,sale_price_paisa,avg_cost_paisa,current_stock_milli,minimum_stock_milli) VALUES(?,?,?,?,?,?,?,?)',
        sku, name, String(data.unit || 'টি'),
        purchasePrice, salePrice, purchasePrice, opening, minimum
      );

      await audit(DB, 'create', 'product', result.meta.last_row_id, name);

      return json({ ok: true, id: result.meta.last_row_id }, 201);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        return bad('এই SKU আগে থেকে আছে।');
      }
      throw error;
    }
  }

  if (path === '/api/products' && method === 'PATCH') {
    const data = await bodyJson(request);
    const id = Number(data.id);
    const name = String(data.name || '').trim();

    const purchasePrice = Math.round(Number(data.purchase_price || 0) * 100);
    const salePrice = Math.round(Number(data.sale_price || 0) * 100);
    const minimum = Math.round(Number(data.minimum_stock || 0) * 1000);

    if (
      !Number.isSafeInteger(id) || id < 1 || !name ||
      !money(purchasePrice) || !money(salePrice) ||
      !Number.isSafeInteger(minimum) || minimum < 0
    ) {
      return bad('পণ্যের তথ্য সঠিক নয়।');
    }

    const result = await run(
      DB,
      "UPDATE products SET name=?,unit=?,purchase_price_paisa=?,sale_price_paisa=?,minimum_stock_milli=?,updated_at=datetime('now') WHERE id=? AND active=1",
      name, String(data.unit || 'টি'),
      purchasePrice, salePrice, minimum, id
    );

    if (!result.meta.changes) return bad('পণ্য পাওয়া যায়নি।', 404);

    await audit(DB, 'update', 'product', id, name);

    return json({ ok: true });
  }

  if (path === '/api/products' && method === 'DELETE') {
    const id = Number(url.searchParams.get('id'));

    if (!Number.isSafeInteger(id) || id < 1) {
      return bad('পণ্য ID প্রয়োজন।');
    }

    const used = await first(
      DB,
      'SELECT id FROM purchase_items WHERE product_id=? UNION SELECT id FROM sale_items WHERE product_id=? LIMIT 1',
      id, id
    );

    if (used) {
      return bad('লেনদেনে ব্যবহৃত পণ্য মুছে ফেলা যাবে না; নিষ্ক্রিয় করতে হবে।');
    }

    await run(DB, 'UPDATE products SET active=0 WHERE id=?', id);
    await audit(DB, 'deactivate', 'product', id);

    return json({ ok: true });
  }

  if (path === '/api/customers' && method === 'GET') {
    return json({
      ok: true,
      items: await all(
        DB,
        "SELECT c.*,COALESCE((SELECT SUM(CASE WHEN direction='due' THEN amount_paisa ELSE -amount_paisa END) FROM party_ledger p WHERE p.party_type='customer' AND p.party_id=c.id),0)+c.opening_due_paisa AS current_due_paisa FROM customers c WHERE active=1 ORDER BY name"
      )
    });
  }

  if (path === '/api/customers' && method === 'POST') {
    const data = await bodyJson(request);
    const name = String(data.name || '').trim();
    const opening = Math.round(Number(data.opening_due || 0) * 100);

    if (!name || !money(opening)) {
      return bad('ক্রেতার নাম/প্রারম্ভিক বাকি সঠিক নয়।');
    }

    const result = await run(
      DB,
      'INSERT INTO customers(name,phone,opening_due_paisa) VALUES(?,?,?)',
      name, String(data.phone || ''), opening
    );

    await audit(DB, 'create', 'customer', result.meta.last_row_id, name);

    return json({ ok: true, id: result.meta.last_row_id }, 201);
  }

  if (path === '/api/suppliers' && method === 'GET') {
    return json({
      ok: true,
      items: await all(
        DB,
        "SELECT s.*,COALESCE((SELECT SUM(CASE WHEN direction='due' THEN amount_paisa ELSE -amount_paisa END) FROM party_ledger p WHERE p.party_type='supplier' AND p.party_id=s.id),0)+s.opening_due_paisa AS current_due_paisa FROM suppliers s WHERE active=1 ORDER BY name"
      )
    });
  }

  if (path === '/api/suppliers' && method === 'POST') {
    const data = await bodyJson(request);
    const name = String(data.name || '').trim();
    const opening = Math.round(Number(data.opening_due || 0) * 100);

    if (!name || !money(opening)) {
      return bad('সরবরাহকারীর নাম/প্রারম্ভিক দেনা সঠিক নয়।');
    }

    const result = await run(
      DB,
      'INSERT INTO suppliers(name,phone,opening_due_paisa) VALUES(?,?,?)',
      name, String(data.phone || ''), opening
    );

    await audit(DB, 'create', 'supplier', result.meta.last_row_id, name);

    return json({ ok: true, id: result.meta.last_row_id }, 201);
  }

  if (path === '/api/accounts' && method === 'GET') {
    return json({
      ok: true,
      items: await all(
        DB,
        'SELECT id,code,name,type,opening_balance_paisa,current_balance_paisa FROM accounts WHERE active=1 ORDER BY id'
      )
    });
  }

  if (path === '/api/accounts' && method === 'PATCH') {
    const data = await bodyJson(request);
    const id = Number(data.id);
    const opening = Math.round(Number(data.opening_balance || 0) * 100);

    if (
      !Number.isSafeInteger(id) || id < 1 ||
      !Number.isSafeInteger(opening) || opening < 0
    ) {
      return bad('হিসাব ও প্রারম্ভিক ব্যালেন্স সঠিক নয়।');
    }

    const account = await first(
      DB,
      'SELECT * FROM accounts WHERE id=? AND active=1',
      id
    );

    if (!account) return bad('হিসাব পাওয়া যায়নি।', 404);

    const delta = opening - Number(account.opening_balance_paisa);

    await run(
      DB,
      'UPDATE accounts SET opening_balance_paisa=?,current_balance_paisa=current_balance_paisa+? WHERE id=?',
      opening, delta, id
    );

    await audit(
      DB, 'set_opening_balance', 'account', id,
      JSON.stringify({
        old: Number(account.opening_balance_paisa),
        new: opening
      })
    );

    return json({ ok: true });
  }

  if (path === '/api/transactions/purchase' && method === 'POST') {
    return json({
      ok: true,
      ...await createPurchase(DB, await bodyJson(request))
    }, 201);
  }

  if (path === '/api/transactions/sale' && method === 'POST') {
    return json({
      ok: true,
      ...await createSale(DB, await bodyJson(request), false)
    }, 201);
  }

  if (path === '/api/transactions/total-sale' && method === 'POST') {
    return json({
      ok: true,
      ...await createSale(DB, await bodyJson(request), true)
    }, 201);
  }

  if (path === '/api/transactions/customer-collection' && method === 'POST') {
    return json({
      ok: true,
      ...await simpleMoneyTransaction(DB, await bodyJson(request), 'customer_collection')
    }, 201);
  }

  if (path === '/api/transactions/supplier-payment' && method === 'POST') {
    return json({
      ok: true,
      ...await simpleMoneyTransaction(DB, await bodyJson(request), 'supplier_payment')
    }, 201);
  }

  if (path === '/api/transactions/expense' && method === 'POST') {
    return json({
      ok: true,
      ...await simpleMoneyTransaction(DB, await bodyJson(request), 'expense')
    }, 201);
  }

  if (path === '/api/transactions/other-income' && method === 'POST') {
    return json({
      ok: true,
      ...await simpleMoneyTransaction(DB, await bodyJson(request), 'other_income')
    }, 201);
  }

  if (path === '/api/transactions/cash-in' && method === 'POST') {
    return json({
      ok: true,
      ...await simpleMoneyTransaction(DB, await bodyJson(request), 'cash_in')
    }, 201);
  }

  if (path === '/api/transactions/cash-out' && method === 'POST') {
    return json({
      ok: true,
      ...await simpleMoneyTransaction(DB, await bodyJson(request), 'cash_out')
    }, 201);
  }

  if (path === '/api/transactions' && method === 'GET') {
    const requested = Number(url.searchParams.get('limit') || 50);
    const limit = Math.min(200, Math.max(1, Number.isFinite(requested) ? requested : 50));

    return json({
      ok: true,
      items: await all(
        DB,
        'SELECT id,transaction_no,type,transaction_date,total_paisa,paid_paisa,due_paisa,note,created_at FROM transactions ORDER BY id DESC LIMIT ?',
        limit
      )
    });
  }

  if (path === '/api/stock-verification' && method === 'GET') {
    return json({
      ok: true,
      items: await all(
        DB,
        'SELECT id,sku,name,unit,current_stock_milli,avg_cost_paisa,CAST(current_stock_milli*avg_cost_paisa/1000 AS INTEGER) AS expected_value_paisa,minimum_stock_milli FROM products WHERE active=1 ORDER BY name'
      )
    });
  }

  if (path === '/api/stock-verification' && method === 'POST') {
    const data = await bodyJson(request);
    const id = Number(data.product_id);
    const physical = Math.round(Number(data.physical_quantity) * 1000);

    if (
      !Number.isSafeInteger(id) || id < 1 ||
      !Number.isSafeInteger(physical) || physical < 0
    ) {
      return bad('পণ্য ও প্রকৃত পরিমাণ সঠিকভাবে দিন।');
    }

    const product = await first(
      DB,
      'SELECT * FROM products WHERE id=? AND active=1',
      id
    );

    if (!product) return bad('পণ্য পাওয়া যায়নি।', 404);

    const difference = physical - Number(product.current_stock_milli);

    if (difference !== 0) {
      return json({
        ok: false,
        error: 'সিস্টেম স্টক ও প্রকৃত স্টকে পার্থক্য আছে। স্বয়ংক্রিয়ভাবে স্টক বদলানো হয়নি।',
        system_quantity_milli: Number(product.current_stock_milli),
        physical_quantity_milli: physical,
        difference_milli: difference
      }, 409);
    }

    return json({
      ok: true,
      message: 'প্রকৃত স্টক ও সিস্টেম স্টক মিলে গেছে।'
    });
  }

  if (path === '/api/settings' && method === 'GET') {
    return json({
      ok: true,
      items: await all(DB, 'SELECT key,value FROM settings ORDER BY key')
    });
  }

  if (path === '/api/settings' && method === 'POST') {
    const data = await bodyJson(request);

    for (const [key, value] of Object.entries(data)) {
      if (!/^[a-z_]{1,50}$/.test(key)) continue;

      await run(
        DB,
        "INSERT INTO settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        key, String(value)
      );
    }

    return json({ ok: true });
  }

  if (path === '/api/backup' && method === 'GET') {
    const tables = [
      'settings', 'products', 'customers', 'suppliers', 'accounts',
      'transactions', 'purchase_items', 'sale_items', 'cash_ledger',
      'party_ledger', 'expenses', 'audit_log'
    ];

    const data = {
      app: 'CHAMAK STORE',
      version: 1,
      exported_at: new Date().toISOString(),
      tables: {}
    };

    for (const table of tables) {
      data.tables[table] = await all(DB, `SELECT * FROM ${table}`);
    }

    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition':
          `attachment; filename="chamak-store-backup-${nowDate()}.json"`,
        'cache-control': 'no-store'
      }
    });
  }

  if (path === '/api/audit-log' && method === 'GET') {
    return json({
      ok: true,
      items: await all(DB, 'SELECT * FROM audit_log ORDER BY id DESC LIMIT 100')
    });
  }

  return bad('এই API রুটটি পাওয়া যায়নি।', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await route(request, env);
    } catch (error) {
      console.error('CHAMAK STORE API error', error);

      return bad(
        error?.message || 'অজানা সার্ভার ত্রুটি।',
        400
      );
    }
  }
};
