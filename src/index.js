const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (message, status = 400) => json({ ok: false, error: message }, status);
const nowDate = () => new Date().toISOString().slice(0, 10);
const money = (n) => Number.isSafeInteger(n) && n >= 0;
const qtyMilli = (n) => Number.isSafeInteger(n) && n > 0;
const roundMoney = (qty, unitPaisa) => Math.round(qty * unitPaisa / 1000);
const newNo = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

function cookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const item = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}
async function signSession(expiry, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(expiry)));
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2,'0')).join('');
}
async function isAuthenticated(request, env) {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) return false;
  const token = cookieValue(request, 'chamak_session');
  const [expiryText, signature] = token.split('.');
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now()/1000) || !signature) return false;
  return signature === await signSession(expiry, env.SESSION_SECRET);
}

async function bodyJson(request) {
  try { return await request.json(); } catch { throw new Error('সঠিক JSON তথ্য পাওয়া যায়নি।'); }
}
async function run(db, sql, ...binds) { return db.prepare(sql).bind(...binds).run(); }
async function first(db, sql, ...binds) { return db.prepare(sql).bind(...binds).first(); }
async function all(db, sql, ...binds) { const r = await db.prepare(sql).bind(...binds).all(); return r.results || []; }
async function audit(db, action, type, id, details = '') { await run(db, 'INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES(?,?,?,?)', action, type, id ?? null, details); }
async function txExists(db, key) { return key ? first(db, 'SELECT id,transaction_no FROM transactions WHERE idempotency_key=?', key) : null; }
async function getAccount(db, id) { const a = await first(db, 'SELECT * FROM accounts WHERE id=? AND active=1', id); if (!a) throw new Error('নির্বাচিত নগদ/ব্যাংক হিসাব পাওয়া যায়নি।'); return a; }
async function addCashStmt(db, txId, accountId, amount, direction, note) {
  if (!amount) return [];
  return [
    db.prepare('INSERT INTO cash_ledger(transaction_id,account_id,amount_paisa,direction,note) VALUES(?,?,?,?,?)').bind(txId, accountId, amount, direction, note || null),
    db.prepare('UPDATE accounts SET current_balance_paisa=current_balance_paisa + ? WHERE id=?').bind(direction === 'in' ? amount : -amount, accountId)
  ];
}
async function addPartyStmt(db, txId, partyType, partyId, amount, direction, note) {
  if (!partyId || !amount) return [];
  return [db.prepare('INSERT INTO party_ledger(transaction_id,party_type,party_id,amount_paisa,direction,note) VALUES(?,?,?,?,?,?)').bind(txId, partyType, partyId, amount, direction, note || null)];
}
function parseItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('কমপক্ষে ১টি এবং সর্বোচ্চ ১০০টি পণ্য যোগ করুন।');
  const parsed = items.map((x) => {
    const productId = Number(x.product_id), quantityMilli = Math.round(Number(x.quantity) * 1000), unitPrice = Math.round(Number(x.unit_price) * 100);
    if (!Number.isSafeInteger(productId) || productId < 1 || !qtyMilli(quantityMilli) || !money(unitPrice)) throw new Error('পণ্যের আইডি, পরিমাণ বা মূল্য সঠিক নয়।');
    return { productId, quantityMilli, unitPrice };
  });
  if (new Set(parsed.map(x => x.productId)).size !== parsed.length) throw new Error('একই পণ্য এক লেনদেনে একাধিক লাইনে দেবেন না; একই লাইনে পরিমাণ যোগ করুন।');
  return parsed;
}

function newTransactionId() { return Date.now() * 4096 + (crypto.getRandomValues(new Uint16Array(1))[0] % 4096); }

async function createPurchase(db, d) {
  const key = String(d.idempotency_key || ''); const old = await txExists(db, key); if (old) return { id: old.id, transaction_no: old.transaction_no, duplicate: true };
  const items = parseItems((d.items || []).map(x => ({...x, unit_price: x.unit_cost ?? x.unit_price})));
  const supplierId = d.supplier_id ? Number(d.supplier_id) : null, accountId = Number(d.account_id || 1), paid = Math.round(Number(d.paid_amount || 0) * 100);
  if (!money(paid)) throw new Error('পরিশোধের পরিমাণ সঠিক নয়।');
  const purchaseAccount = await getAccount(db, accountId);
  if (paid > Number(purchaseAccount.current_balance_paisa)) throw new Error('এই নগদ/ব্যাংক হিসাবে যত টাকা আছে, তার চেয়ে বেশি পরিশোধ করা যাবে না। আগে প্রারম্ভিক ব্যালেন্স ঠিক করুন।');
  if (supplierId && !(await first(db, 'SELECT id FROM suppliers WHERE id=? AND active=1', supplierId))) throw new Error('সরবরাহকারী পাওয়া যায়নি।');
  const products = [];
  for (const it of items) { const p = await first(db, 'SELECT * FROM products WHERE id=? AND active=1', it.productId); if (!p) throw new Error(`পণ্য ID ${it.productId} পাওয়া যায়নি।`); products.push({ ...it, p, line: roundMoney(it.quantityMilli, it.unitPrice) }); }
  const total = products.reduce((s, x) => s + x.line, 0); if (paid > total) throw new Error('পরিশোধের পরিমাণ ক্রয়ের মোট টাকার চেয়ে বেশি হতে পারবে না।');
  const due = total - paid, no = newNo('PUR'), date = String(d.transaction_date || nowDate());
  if (due > 0 && !supplierId) throw new Error('ক্রয়ে বাকি থাকলে সরবরাহকারী নির্বাচন করতে হবে।');
  const tid = newTransactionId(); const stmts = [db.prepare('INSERT INTO transactions(id,transaction_no,type,transaction_date,party_type,party_id,account_id,total_paisa,paid_paisa,due_paisa,note,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(tid,no,'purchase',date,supplierId?'supplier':null,supplierId,accountId,total,paid,due,String(d.note||''),key||null)];
  for (const x of products) {
    const oldStock = Number(x.p.current_stock_milli), newStock = oldStock + x.quantityMilli;
    const avgCost = Math.round(((oldStock * Number(x.p.avg_cost_paisa)) + (x.quantityMilli * x.unitPrice)) / newStock);
    stmts.push(db.prepare('INSERT INTO purchase_items(transaction_id,product_id,quantity_milli,unit_cost_paisa,line_total_paisa) VALUES(?,?,?,?,?)').bind(tid,x.productId,x.quantityMilli,x.unitPrice,x.line));
    stmts.push(db.prepare('UPDATE products SET current_stock_milli=?,avg_cost_paisa=?,purchase_price_paisa=?,updated_at=datetime(\'now\') WHERE id=?').bind(newStock,avgCost,x.unitPrice,x.productId));
  }
  stmts.push(...await addCashStmt(db,tid,accountId,paid,'out',`ক্রয় ${no}`));
  stmts.push(...await addPartyStmt(db,tid,'supplier',supplierId,due,'due',`ক্রয় ${no}`));
  stmts.push(db.prepare('INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES(?,?,?,?)').bind('create','purchase',tid,JSON.stringify({no,total,paid,due})));
  await db.batch(stmts); return { id: tid, transaction_no: no, total_paisa: total, paid_paisa: paid, due_paisa: due };
}

async function createSale(db, d, totalOnly = false) {
  const key = String(d.idempotency_key || ''); const old = await txExists(db,key); if (old) return { id:old.id,transaction_no:old.transaction_no,duplicate:true };
  const customerId = d.customer_id ? Number(d.customer_id) : null, accountId = Number(d.account_id || 1), paid = Math.round(Number(d.paid_amount || 0)*100);
  if (!money(paid)) throw new Error('আদায়ের পরিমাণ সঠিক নয়।'); await getAccount(db,accountId);
  if (customerId && !(await first(db,'SELECT id FROM customers WHERE id=? AND active=1',customerId))) throw new Error('ক্রেতা পাওয়া যায়নি।');
  const no = newNo(totalOnly?'TSL':'SAL'), date = String(d.transaction_date||nowDate()); let products = [], total = 0, cogs = 0;
  if (totalOnly) { total = Math.round(Number(d.total_amount||0)*100); if (!money(total) || total < 1) throw new Error('মোট বিক্রয়ের টাকা লিখুন।'); }
  else {
    const parsedItems = parseItems(d.items || []);
    for (const it of parsedItems) {
      const p = await first(db,'SELECT * FROM products WHERE id=? AND active=1',it.productId); if (!p) throw new Error(`পণ্য ID ${it.productId} পাওয়া যায়নি।`);
      if (Number(p.current_stock_milli) < it.quantityMilli) throw new Error(`“${p.name}” পণ্যের স্টক যথেষ্ট নেই। বর্তমান স্টক: ${(Number(p.current_stock_milli)/1000).toFixed(3)} ${p.unit}`);
      const line = roundMoney(it.quantityMilli,it.unitPrice), cost = roundMoney(it.quantityMilli,Number(p.avg_cost_paisa));
      products.push({...it,p,line,cost}); total += line; cogs += cost;
    }
  }
  if (paid > total) throw new Error('আদায়ের পরিমাণ বিক্রয়ের মোট টাকার চেয়ে বেশি হতে পারবে না।');
  const due=total-paid; if (due > 0 && !customerId) throw new Error('বিক্রয়ে বাকি থাকলে ক্রেতা নির্বাচন করতে হবে।'); const tid=newTransactionId(); const stmts=[db.prepare('INSERT INTO transactions(id,transaction_no,type,transaction_date,party_type,party_id,account_id,total_paisa,paid_paisa,due_paisa,note,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(tid,no,totalOnly?'total_sale':'sale',date,customerId?'customer':null,customerId,accountId,total,paid,due,String(d.note||''),key||null)];
  for (const x of products) {
    stmts.push(db.prepare('INSERT INTO sale_items(transaction_id,product_id,quantity_milli,unit_sale_price_paisa,unit_cost_paisa,line_total_paisa,cost_total_paisa) VALUES(?,?,?,?,?,?,?)').bind(tid,x.productId,x.quantityMilli,x.unitPrice,Number(x.p.avg_cost_paisa),x.line,x.cost));
    stmts.push(db.prepare('UPDATE products SET current_stock_milli=current_stock_milli-?,updated_at=datetime(\'now\') WHERE id=? AND current_stock_milli>=?').bind(x.quantityMilli,x.productId,x.quantityMilli));
  }
  stmts.push(...await addCashStmt(db,tid,accountId,paid,'in',`বিক্রয় ${no}`)); stmts.push(...await addPartyStmt(db,tid,'customer',customerId,due,'due',`বিক্রয় ${no}`));
  stmts.push(db.prepare('INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES(?,?,?,?)').bind('create',totalOnly?'total_sale':'sale',tid,JSON.stringify({no,total,paid,due,cogs,gross_profit_paisa:totalOnly?null:total-cogs})));
  await db.batch(stmts); return {id:tid,transaction_no:no,total_paisa:total,paid_paisa:paid,due_paisa:due,cogs_paisa:totalOnly?null:cogs,gross_profit_paisa:totalOnly?null:total-cogs,stock_changed:!totalOnly};
}

async function simpleMoneyTransaction(db, d, type) {
  const key=String(d.idempotency_key||''); const old=await txExists(db,key); if(old)return {id:old.id,transaction_no:old.transaction_no,duplicate:true};
  const amount=Math.round(Number(d.amount||0)*100), accountId=Number(d.account_id||1); if(!Number.isSafeInteger(amount)||amount<1)throw new Error('টাকার পরিমাণ সঠিকভাবে লিখুন।'); const moneyAccount=await getAccount(db,accountId); if(['supplier_payment','expense','cash_out'].includes(type)&&amount>Number(moneyAccount.current_balance_paisa))throw new Error('এই নগদ/ব্যাংক হিসাবে যত টাকা আছে, তার চেয়ে বেশি পরিশোধ করা যাবে না। আগে প্রারম্ভিক ব্যালেন্স ঠিক করুন।');
  const no=newNo(type.toUpperCase().slice(0,3)), date=String(d.transaction_date||nowDate()); let partyType=null,partyId=null,paid=amount,due=0;
  if(type==='customer_collection'){partyType='customer';partyId=Number(d.customer_id);if(!partyId||!(await first(db,'SELECT id FROM customers WHERE id=? AND active=1',partyId)))throw new Error('ক্রেতা নির্বাচন করুন।');const outstanding=await first(db,"SELECT COALESCE((SELECT opening_due_paisa FROM customers WHERE id=?),0)+COALESCE(SUM(CASE WHEN direction='due' THEN amount_paisa ELSE -amount_paisa END),0) AS due FROM party_ledger WHERE party_type='customer' AND party_id=?",partyId,partyId);if(amount>Math.max(0,Number(outstanding?.due||0)))throw new Error('আদায়ের টাকা ক্রেতার বর্তমান বকেয়ার চেয়ে বেশি।');}
  if(type==='supplier_payment'){partyType='supplier';partyId=Number(d.supplier_id);if(!partyId||!(await first(db,'SELECT id FROM suppliers WHERE id=? AND active=1',partyId)))throw new Error('সরবরাহকারী নির্বাচন করুন।');const outstanding=await first(db,"SELECT COALESCE((SELECT opening_due_paisa FROM suppliers WHERE id=?),0)+COALESCE(SUM(CASE WHEN direction='due' THEN amount_paisa ELSE -amount_paisa END),0) AS due FROM party_ledger WHERE party_type='supplier' AND party_id=?",partyId,partyId);if(amount>Math.max(0,Number(outstanding?.due||0)))throw new Error('পরিশোধের টাকা সরবরাহকারীর বর্তমান দেনার চেয়ে বেশি।');}
  if(type==='expense' || type==='cash_out') { paid=amount; }
  const tid=newTransactionId(); const stmts=[db.prepare('INSERT INTO transactions(id,transaction_no,type,transaction_date,party_type,party_id,account_id,total_paisa,paid_paisa,due_paisa,note,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(tid,no,type,date,partyType,partyId,accountId,amount,amount,0,String(d.note||d.category||''),key||null)];
  stmts.push(...await addCashStmt(db,tid,accountId,amount,type==='other_income'||type==='customer_collection'||type==='cash_in'?'in':'out',`${type} ${no}`));
  if(type==='customer_collection')stmts.push(...await addPartyStmt(db,tid,'customer',partyId,amount,'payment',`আদায় ${no}`));
  if(type==='supplier_payment')stmts.push(...await addPartyStmt(db,tid,'supplier',partyId,amount,'payment',`পরিশোধ ${no}`));
  if(type==='expense')stmts.push(db.prepare('INSERT INTO expenses(transaction_id,category,amount_paisa) VALUES(?,?,?)').bind(tid,String(d.category||'অন্যান্য'),amount));
  stmts.push(db.prepare('INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES(?,?,?,?)').bind('create',type,tid,JSON.stringify({no,amount,partyId})));
  await db.batch(stmts);return {id:tid,transaction_no:no,amount_paisa:amount};
}

async function route(request, env) {
  const { DB }=env;
  const url=new URL(request.url), path=url.pathname, method=request.method;
  if(path==='/api/session'&&method==='GET') return json({ok:true,authenticated:await isAuthenticated(request,env),configured:!!(env.APP_PASSWORD&&env.SESSION_SECRET)});
  if(path==='/api/login'&&method==='POST') {
    if(!env.APP_PASSWORD||!env.SESSION_SECRET)return bad('লগইন চালু করতে Cloudflare-এ APP_PASSWORD ও SESSION_SECRET সেট করতে হবে।',503);
    const d=await bodyJson(request); if(typeof d.password!=='string'||d.password!==env.APP_PASSWORD)return bad('পাসওয়ার্ড সঠিক নয়।',401);
    const expiry=Math.floor(Date.now()/1000)+28800, signature=await signSession(expiry,env.SESSION_SECRET);
    return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','set-cookie':`chamak_session=${expiry}.${signature}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`}});
  }
  if(path==='/api/logout'&&method==='POST')return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json; charset=utf-8','set-cookie':'chamak_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'}});
  if(path==='/api/health'&&method==='GET')return json({ok:true,app:'CHAMAK STORE'});
  if(!await isAuthenticated(request,env)) return bad('লগইন করুন।',401);
  if(!DB) return bad('D1 binding DB পাওয়া যায়নি। wrangler.toml পরীক্ষা করুন।',500);
  if(path==='/api/dashboard'&&method==='GET'){
    const [cash,products,customers,suppliers,sales,purchases,expenses,dues,low,stockValue]=await Promise.all([
      first(DB,'SELECT COALESCE(SUM(current_balance_paisa),0) AS value FROM accounts WHERE active=1'),first(DB,'SELECT COUNT(*) AS value FROM products WHERE active=1'),first(DB,'SELECT COUNT(*) AS value FROM customers WHERE active=1'),first(DB,'SELECT COUNT(*) AS value FROM suppliers WHERE active=1'),first(DB,"SELECT COALESCE(SUM(total_paisa),0) AS value FROM transactions WHERE type IN ('sale','total_sale') AND transaction_date=date('now','localtime')"),first(DB,"SELECT COALESCE(SUM(total_paisa),0) AS value FROM transactions WHERE type='purchase' AND transaction_date=date('now','localtime')"),first(DB,"SELECT COALESCE(SUM(amount_paisa),0) AS value FROM expenses e JOIN transactions t ON t.id=e.transaction_id WHERE t.transaction_date=date('now','localtime')"),first(DB,"SELECT COALESCE((SELECT SUM(opening_due_paisa) FROM customers WHERE active=1),0)+COALESCE(SUM(CASE WHEN direction='due' THEN amount_paisa ELSE -amount_paisa END),0) AS value FROM party_ledger WHERE party_type='customer'"),all(DB,'SELECT id,name,current_stock_milli,minimum_stock_milli,unit FROM products WHERE active=1 AND current_stock_milli<=minimum_stock_milli ORDER BY name LIMIT 8'),first(DB,'SELECT COALESCE(SUM(current_stock_milli*avg_cost_paisa/1000),0) AS value FROM products WHERE active=1')
    ]);return json({ok:true,summary:{cash_paisa:cash.value,product_count:products.value,customer_count:customers.value,supplier_count:suppliers.value,today_sales_paisa:sales.value,today_purchases_paisa:purchases.value,today_expenses_paisa:expenses.value,customer_due_paisa:dues.value,stock_value_paisa:stockValue.value},low_stock:low});
  }
  if(path==='/api/products'&&method==='GET')return json({ok:true,items:await all(DB,'SELECT * FROM products WHERE active=1 ORDER BY name')});
  if(path==='/api/products'&&method==='POST') {const d=await bodyJson(request);const name=String(d.name||'').trim();if(!name)return bad('পণ্যের নাম আবশ্যক।');const sku=String(d.sku||`SKU-${Date.now().toString(36).toUpperCase()}`).trim();const pp=Math.round(Number(d.purchase_price||0)*100),sp=Math.round(Number(d.sale_price||0)*100),min=Math.round(Number(d.minimum_stock||0)*1000),opening=Math.round(Number(d.opening_stock||0)*1000);if(!money(pp)||!money(sp)||!Number.isSafeInteger(min)||min<0||!Number.isSafeInteger(opening)||opening<0)return bad('মূল্য বা স্টক সঠিক নয়।');try{const r=await run(DB,'INSERT INTO products(sku,name,unit,purchase_price_paisa,sale_price_paisa,avg_cost_paisa,current_stock_milli,minimum_stock_milli) VALUES(?,?,?,?,?,?,?,?)',sku,name,String(d.unit||'টি'),pp,sp,pp,opening,min);await audit(DB,'create','product',r.meta.last_row_id,name);return json({ok:true,id:r.meta.last_row_id},201);}catch(e){return bad(e.message.includes('UNIQUE')?'এই SKU আগে থেকে আছে।':e.message);}}
  if(path==='/api/products'&&method==='PATCH'){const d=await bodyJson(request),id=Number(d.id),name=String(d.name||'').trim();if(!id||!name)return bad('পণ্য ID ও নাম প্রয়োজন।');const pp=Math.round(Number(d.purchase_price||0)*100),sp=Math.round(Number(d.sale_price||0)*100),min=Math.round(Number(d.minimum_stock||0)*1000);await run(DB,'UPDATE products SET name=?,unit=?,purchase_price_paisa=?,sale_price_paisa=?,minimum_stock_milli=?,updated_at=datetime(\'now\') WHERE id=? AND active=1',name,String(d.unit||'টি'),pp,sp,min,id);await audit(DB,'update','product',id,name);return json({ok:true});}
  if(path==='/api/products'&&method==='DELETE'){const id=Number(url.searchParams.get('id'));if(!id)return bad('পণ্য ID প্রয়োজন।');const used=await first(DB,'SELECT id FROM purchase_items WHERE product_id=? UNION SELECT id FROM sale_items WHERE product_id=? LIMIT 1',id,id);if(used)return bad('লেনদেনে ব্যবহৃত পণ্য মুছে ফেলা যাবে না; নিষ্ক্রিয় করতে হবে।');await run(DB,'UPDATE products SET active=0 WHERE id=?',id);return json({ok:true});}
  if(path==='/api/customers'&&method==='GET')return json({ok:true,items:await all(DB,'SELECT c.*,COALESCE((SELECT SUM(CASE WHEN direction=\'due\' THEN amount_paisa ELSE -amount_paisa END) FROM party_ledger p WHERE p.party_type=\'customer\' AND p.party_id=c.id),0)+c.opening_due_paisa AS current_due_paisa FROM customers c WHERE active=1 ORDER BY name')});
  if(path==='/api/customers'&&method==='POST'){const d=await bodyJson(request),name=String(d.name||'').trim(),opening=Math.round(Number(d.opening_due||0)*100);if(!name||!money(opening))return bad('ক্রেতার নাম/প্রারম্ভিক বাকি সঠিক নয়।');const r=await run(DB,'INSERT INTO customers(name,phone,opening_due_paisa) VALUES(?,?,?)',name,String(d.phone||''),opening);return json({ok:true,id:r.meta.last_row_id},201);}
  if(path==='/api/suppliers'&&method==='GET')return json({ok:true,items:await all(DB,'SELECT s.*,COALESCE((SELECT SUM(CASE WHEN direction=\'due\' THEN amount_paisa ELSE -amount_paisa END) FROM party_ledger p WHERE p.party_type=\'supplier\' AND p.party_id=s.id),0)+s.opening_due_paisa AS current_due_paisa FROM suppliers s WHERE active=1 ORDER BY name')});
  if(path==='/api/suppliers'&&method==='POST'){const d=await bodyJson(request),name=String(d.name||'').trim(),opening=Math.round(Number(d.opening_due||0)*100);if(!name||!money(opening))return bad('সরবরাহকারীর নাম/প্রারম্ভিক দেনা সঠিক নয়।');const r=await run(DB,'INSERT INTO suppliers(name,phone,opening_due_paisa) VALUES(?,?,?)',name,String(d.phone||''),opening);return json({ok:true,id:r.meta.last_row_id},201);}
  if(path==='/api/accounts'&&method==='GET')return json({ok:true,items:await all(DB,'SELECT id,code,name,type,opening_balance_paisa,current_balance_paisa FROM accounts WHERE active=1 ORDER BY id')});
  if(path==='/api/accounts'&&method==='PATCH'){const d=await bodyJson(request),id=Number(d.id),opening=Math.round(Number(d.opening_balance||0)*100);if(!id||!Number.isSafeInteger(opening)||opening<0)return bad('হিসাব ও প্রারম্ভিক ব্যালেন্স সঠিক নয়।');const a=await first(DB,'SELECT * FROM accounts WHERE id=? AND active=1',id);if(!a)return bad('হিসাব পাওয়া যায়নি।');const delta=opening-Number(a.opening_balance_paisa);await run(DB,'UPDATE accounts SET opening_balance_paisa=?,current_balance_paisa=current_balance_paisa+? WHERE id=?',opening,delta,id);await audit(DB,'set_opening_balance','account',id,JSON.stringify({old:Number(a.opening_balance_paisa),new:opening}));return json({ok:true});}
  if(path==='/api/transactions/purchase'&&method==='POST')return json({ok:true,...await createPurchase(DB,await bodyJson(request))},201);
  if(path==='/api/transactions/sale'&&method==='POST')return json({ok:true,...await createSale(DB,await bodyJson(request),false)},201);
  if(path==='/api/transactions/total-sale'&&method==='POST')return json({ok:true,...await createSale(DB,await bodyJson(request),true)},201);
  if(path==='/api/transactions/customer-collection'&&method==='POST')return json({ok:true,...await simpleMoneyTransaction(DB,await bodyJson(request),'customer_collection')},201);
  if(path==='/api/transactions/supplier-payment'&&method==='POST')return json({ok:true,...await simpleMoneyTransaction(DB,await bodyJson(request),'supplier_payment')},201);
  if(path==='/api/transactions/expense'&&method==='POST')return json({ok:true,...await simpleMoneyTransaction(DB,await bodyJson(request),'expense')},201);
  if(path==='/api/transactions/other-income'&&method==='POST')return json({ok:true,...await simpleMoneyTransaction(DB,await bodyJson(request),'other_income')},201);
  if(path==='/api/transactions/cash-in'&&method==='POST')return json({ok:true,...await simpleMoneyTransaction(DB,await bodyJson(request),'cash_in')},201);
  if(path==='/api/transactions/cash-out'&&method==='POST')return json({ok:true,...await simpleMoneyTransaction(DB,await bodyJson(request),'cash_out')},201);
  if(path==='/api/transactions'&&method==='GET'){const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit')||50)));return json({ok:true,items:await all(DB,'SELECT id,transaction_no,type,transaction_date,total_paisa,paid_paisa,due_paisa,note,created_at FROM transactions ORDER BY id DESC LIMIT ?',limit)});}
  if(path==='/api/stock-verification'&&method==='GET')return json({ok:true,items:await all(DB,'SELECT id,sku,name,unit,current_stock_milli,avg_cost_paisa,CAST(current_stock_milli*avg_cost_paisa/1000 AS INTEGER) AS expected_value_paisa,minimum_stock_milli FROM products WHERE active=1 ORDER BY name')});
  if(path==='/api/stock-verification'&&method==='POST'){const d=await bodyJson(request),id=Number(d.product_id),physical=Math.round(Number(d.physical_quantity)*1000);if(!id||!Number.isSafeInteger(physical)||physical<0)return bad('পণ্য ও প্রকৃত পরিমাণ সঠিকভাবে দিন।');const p=await first(DB,'SELECT * FROM products WHERE id=? AND active=1',id);if(!p)return bad('পণ্য পাওয়া যায়নি।');const diff=physical-Number(p.current_stock_milli);if(diff!==0)return bad('প্রাথমিক সংস্করণে স্টক সমন্বয় আলাদা অনুমোদিত ধাপে করতে হবে; যাচাইয়ের সময় স্বয়ংক্রিয়ভাবে স্টক বদলানো হয়নি।',409);return json({ok:true,message:'প্রকৃত স্টক ও সিস্টেম স্টক মিলে গেছে।'});}
  if(path==='/api/settings'&&method==='GET')return json({ok:true,items:await all(DB,'SELECT key,value FROM settings ORDER BY key')});
  if(path==='/api/settings'&&method==='POST'){const d=await bodyJson(request);for(const [k,v] of Object.entries(d)){if(!/^[a-z_]{1,50}$/.test(k))continue;await run(DB,'INSERT INTO settings(key,value,updated_at) VALUES(?,?,datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',k,String(v));}return json({ok:true});}
  if(path==='/api/backup'&&method==='GET'){const tables=['settings','products','customers','suppliers','accounts','transactions','purchase_items','sale_items','cash_ledger','party_ledger','expenses','audit_log'];const data={app:'CHAMAK STORE',version:1,exported_at:new Date().toISOString(),tables:{}};for(const t of tables)data.tables[t]=await all(DB,`SELECT * FROM ${t}`);return new Response(JSON.stringify(data,null,2),{headers:{'content-type':'application/json; charset=utf-8','content-disposition':`attachment; filename="chamak-store-backup-${nowDate()}.json"`,'cache-control':'no-store'}});}
  if(path==='/api/audit-log'&&method==='GET')return json({ok:true,items:await all(DB,'SELECT * FROM audit_log ORDER BY id DESC LIMIT 100')});
  return bad('এই API রুটটি পাওয়া যায়নি।',404);
}

export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await route(request,env); }
    catch(e) { console.error('CHAMAK STORE API error',e); return bad(e?.message||'অজানা সার্ভার ত্রুটি।',400); }
  }
};
