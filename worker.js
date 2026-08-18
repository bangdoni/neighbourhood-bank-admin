// Neighbourhood Bank Admin Bot — Cloudflare Worker + D1 (SQLite)
// Replaces Google Apps Script. Instant webhook replies.
// env: BOT_TOKEN, WEBHOOK_SECRET; optional env: TIMEZONE, QR_PUBLIC_URL (custom domain for /qr)
// bindings: DB (D1), QR_BUCKET (R2, QR image object storage)

const DEFAULT_CONFIG = {
  monthly_fee: '50000', currency: 'IDR', timezone: 'Asia/Jakarta',
  payment_due_day: '10', bank_name: '', account_name: '', account_number: '',
  qr_url: '', payment_method: 'qr', pg_api_key: '', pg_api_base: 'https://api-pay-sandbox.sumopod.com/api/v1',
  monthly_reminder_enabled: 'true',
  payment_notification_enabled: 'true', admin_daily_summary_enabled: 'true'
};
const PAY_METHODS = ['QRIS', 'BANK_TRANSFER', 'CASH', 'OTHER'];
const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

const ROLE_PERMS = {
  SUPER_ADMIN: null,
  TREASURER: new Set([
    'members.read','members.create','members.update','members.disable',
    'payments.read','payments.create','payments.correct',
    'balances.read','unpaid.read','notifications.send','reports.read',
    'store.read','store.update','settings.read','audit.read'
  ]),
  ADMIN: new Set([
    'members.read','payments.read','balances.read','unpaid.read',
    'reports.read','store.read','audit.read'
  ])
};

// ---- env / db adapter (sqlite = D1 | postgres = Hyperdrive + postgres.js) ----
// DB_TYPE env: 'sqlite' (default, Cloudflare D1) or 'postgres'.
// postgres mode needs a Hyperdrive binding named DB (env.DB.connectionString) or a
// direct DB_URL; DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME build a URL otherwise.
// postgres.js is installed (npm i postgres) so wrangler/dashboard can bundle it;
// it is only ever invoked in postgres mode, and a D1 (sqlite) deployment never
// opens a connection to it.
let E = {};
let BASE = '';
let TZ = 'Asia/Jakarta';
let PG_MODE = false;
let PG = null;
let PG_INIT = false;
function initEnv(env) {
  E = env;
  TZ = env.TIMEZONE || 'Asia/Jakarta';
  PG_MODE = String(env.DB_TYPE || 'sqlite').toLowerCase() === 'postgres';
}
const pgUrl = () => {
  const user = encodeURIComponent(E.DB_USER || 'postgres');
  const pass = encodeURIComponent(E.DB_PASSWORD || '');
  const host = E.DB_HOST || 'localhost';
  const port = E.DB_PORT || '5432';
  const name = E.DB_NAME || 'postgres';
  return `postgres://${user}:${pass}@${host}:${port}/${name}`;
};
const pgq = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
async function getPg() {
  if (!PG_INIT) {
    PG_INIT = true;
    const { default: postgres } = await import('postgres');
    const conn = E.DB_URL || (E.DB && E.DB.connectionString) || pgUrl();
    PG = postgres(conn, { max: 1, prepare: false });
  }
  return PG;
}

const dbAll = async (sql, ...params) => PG_MODE
  ? (await (await getPg()).unsafe(pgq(sql), params))
  : (await E.DB.prepare(sql).bind(...params).all()).results;
const dbOne = async (sql, ...params) => {
  if (PG_MODE) { const r = await dbAll(sql, ...params); return r[0] || null; }
  return (await E.DB.prepare(sql).bind(...params).first()) || null;
};
const dbRun = async (sql, ...params) => PG_MODE
  ? { changes: ((await (await getPg()).unsafe(pgq(sql), params)).count || 0) }
  : (await E.DB.prepare(sql).bind(...params).run()).meta;
const dbInsert = async (table, row) => {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *`;
  return dbAll(sql, ...cols.map(c => row[c]));
};
const dbUpdate = async (table, pkCol, pkVal, fields) => {
  const sets = Object.keys(fields).map(c => c + ' = ?').join(',');
  const sql = `UPDATE ${table} SET ${sets} WHERE ${pkCol} = ? RETURNING *`;
  return dbAll(sql, ...Object.keys(fields).map(c => fields[c]), pkVal);
};
const dbUpsertIgnore = async (table, row, conflictCols) => {
  const cols = Object.keys(row);
  const sql = PG_MODE
    ? `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT (${conflictCols.join(',')}) DO NOTHING`
    : `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const meta = await dbRun(sql, ...cols.map(c => row[c]));
  return meta.changes > 0 ? [row] : [];
};
const dbUpsert = async (table, row, conflictCols) => {
  const cols = Object.keys(row);
  const sets = cols.filter(c => !conflictCols.includes(c)).map(c => c + ' = excluded.' + c).join(',');
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
    ON CONFLICT(${conflictCols.join(',')}) DO UPDATE SET ${sets}`;
  await dbRun(sql, ...cols.map(c => row[c]));
};

// ---- utils (sync, ported) ----
const pad = (n, l) => String(n).padStart(l, '0');
const toInt = v => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
const isPosInt = v => /^[1-9]\d*$/.test(String(v).trim());
const isValidPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p));
const isValidMemberId = id => /^NB-\d{4}$/.test(String(id));
const isValidTxId = id => /^TX-\d{6}$/.test(String(id));
const isValidTelegramId = v => /^\d+$/.test(String(v).trim());
const isValidPhone = v => /^08\d{9,12}$/.test(String(v).trim());
const uniqueId = prefix => prefix + '-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1e8).toString(36).toUpperCase();
const pageSlice = (arr, page, size) => { const s = size || 10, p = Math.max(1, toInt(page)); return arr.slice((p - 1) * s, p * s); };
const fmt = (d, opts) => new Intl.DateTimeFormat('id-ID', Object.assign({ timeZone: TZ }, opts)).format(d);
const currentPeriod = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function tzOffsetMin(date) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(date);
  const v = (p.find(x => x.type === 'timeZoneName') || {}).value || '';
  const m = /GMT([+-])(\d{2})(?::?(\d{2}))?/.exec(v);
  if (!m) return -7 * 60;
  return (m[1] === '-' ? -1 : 1) * (toInt(m[2]) * 60 + toInt(m[3] || 0));
}
function localDayRange(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d) - tzOffsetMin(new Date()) * 60000;
  return { from: new Date(start).toISOString(), to: new Date(start + 86400000).toISOString() };
}
const formatIDR = n => { n = Math.round(Number(n) || 0); const sign = n < 0 ? '-' : ''; return 'Rp ' + sign + Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); };
const periodLabel = p => MONTHS[toInt(p.substring(5)) - 1] + ' ' + p.substring(0, 4);
const periodYear = p => p.substring(0, 4);
function prevPeriod(p) {
  let m = toInt(p.substring(5)), y = toInt(p.substring(0, 4));
  if (m === 1) { y--; m = 12; } else { m--; }
  return pad(y, 4) + '-' + pad(m, 2);
}
function fmtDate(d, pat) {
  if (pat === 'yyyy-MM-dd') return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  if (pat === 'd MMMM yyyy') return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  return String(d);
}
const nowIso = () => new Date().toISOString();

// ---- config ----
async function loadConfig() {
  const rows = await dbAll('SELECT key, value FROM config');
  const m = {};
  rows.forEach(r => { m[r.key] = r.value; });
  return Object.assign({}, DEFAULT_CONFIG, m);
}
let CFG = null;
const cfg = async key => { if (!CFG) CFG = await loadConfig(); return CFG[key] === undefined || CFG[key] === '' ? DEFAULT_CONFIG[key] : CFG[key]; };
const getConfig = cfg;

// ---- ids ----
async function nextId(name, prefix, padLen) {
  const res = await dbOne('INSERT INTO counters(name, n) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET n = counters.n + 1 RETURNING n', name);
  return prefix + String(res.n).padStart(padLen, '0');
}

// ---- locks (single-isolate mutex; cross-isolate guarded by unique constraints) ----
let lockQueue = Promise.resolve();
function withLock(fn) {
  const run = lockQueue.then(fn, fn);
  lockQueue = run.catch(() => {});
  return run;
}

// ---- auth / permissions ----
async function authenticateAdmin(telegramId) {
  return dbOne('SELECT admin_id, telegram_id, name, role, status FROM admins WHERE telegram_id = ? AND status = ?', String(telegramId), 'ACTIVE');
}
function hasPermission(admin, perm) {
  if (!admin) return false;
  if (admin.role === 'SUPER_ADMIN') return true;
  const s = ROLE_PERMS[admin.role];
  return s ? s.has(perm) : false;
}

// ---- audit ----
async function writeAuditLog(admin, action, targetType, targetId, details, status) {
  const id = await nextId('audit', 'AUD-', 6);
  await dbInsert('audit', {
    audit_id: id, timestamp: nowIso(),
    admin_id: admin ? admin.admin_id : 'SYSTEM', telegram_id: admin ? String(admin.telegram_id) : '',
    action, target_type: targetType || '', target_id: targetId || '', details: details || '', status: status || 'SUCCESS'
  });
  return id;
}

// ---- admins ----
const listAdmins = () => dbAll('SELECT * FROM admins ORDER BY admin_id');
const getAdmin = id => dbOne('SELECT * FROM admins WHERE admin_id = ?', id);
const getAdminByTg = tid => dbOne('SELECT * FROM admins WHERE telegram_id = ?', String(tid));
const getAdminByPhone = phone => dbOne('SELECT * FROM admins WHERE phone = ?', String(phone));
async function activeAdmins() { return (await dbAll('SELECT * FROM admins WHERE status = ?', 'ACTIVE')).filter(a => a.telegram_id); }
async function createAdmin(admin, data) {
  const id = await nextId('admins', 'ADM-', 4);
  const row = { admin_id: id, telegram_id: data.telegram_id || '', name: data.name, phone: data.phone || '', role: data.role, status: 'ACTIVE', created_by: admin ? admin.admin_id : 'SYSTEM' };
  const created = await dbInsert('admins', row);
  await writeAuditLog(admin, 'CREATE_ADMIN', 'ADMIN', id, data.name + ' / ' + data.role, 'SUCCESS');
  return created[0];
}
async function disableAdmin(admin, id) {
  await dbUpdate('admins', 'admin_id', id, { status: 'INACTIVE' });
  await writeAuditLog(admin, 'DISABLE_ADMIN', 'ADMIN', id, '', 'SUCCESS');
  return getAdmin(id);
}

// ---- members ----
async function getMember(id) { return dbOne('SELECT * FROM users WHERE user_id = ?', id); }
const listMembers = () => dbAll('SELECT * FROM users ORDER BY name');
async function activeMembers() { return (await listMembers()).filter(u => u.status === 'ACTIVE'); }
async function inactiveMembers() { return (await listMembers()).filter(u => u.status !== 'ACTIVE'); }
async function searchMembers(qs) {
  const s = String(qs || '').toLowerCase().trim();
  const all = await listMembers();
  return all.filter(u => !s || String(u.name || '').toLowerCase().includes(s) || String(u.user_id || '').toLowerCase().includes(s) || String(u.telegram_username || '').toLowerCase().includes(s));
}
async function memberFee(m) {
  const f = toInt(m.monthly_fee);
  return f > 0 ? f : toInt(await getConfig('monthly_fee'));
}
async function createMember(admin, data) {
  const id = await nextId('users', 'NB-', 4);
  const created = await dbInsert('users', {
    user_id: id, telegram_id: data.telegram_id || null, telegram_username: data.telegram_username || null,
    name: data.name, phone: data.phone || null, address: data.address || null,
    status: 'ACTIVE', monthly_fee: data.monthly_fee ? toInt(data.monthly_fee) : null
  });
  await writeAuditLog(admin, 'CREATE_MEMBER', 'USER', id, data.name, 'SUCCESS');
  return created[0];
}
async function updateMember(admin, id, fields) {
  const upd = {};
  Object.keys(fields).forEach(k => { upd[k] = k === 'monthly_fee' ? toInt(fields[k]) : fields[k]; });
  const updated = await dbUpdate('users', 'user_id', id, upd);
  await writeAuditLog(admin, 'UPDATE_MEMBER', 'USER', id, Object.keys(fields).map(k => k + '=' + fields[k]).join(','), 'SUCCESS');
  return updated[0];
}
async function disableMember(admin, id) {
  await dbUpdate('users', 'user_id', id, { status: 'INACTIVE' });
  await writeAuditLog(admin, 'DISABLE_MEMBER', 'USER', id, '', 'SUCCESS');
  return getMember(id);
}

// ---- transactions ----
async function sumTx(userId, period) {
  const rows = period
    ? await dbAll('SELECT amount FROM transactions WHERE status = ? AND user_id = ? AND period = ?', 'COMPLETED', userId, period)
    : await dbAll('SELECT amount FROM transactions WHERE status = ? AND user_id = ?', 'COMPLETED', userId);
  return rows.reduce((s, t) => s + toInt(t.amount), 0);
}
const getBalance = userId => sumTx(userId);
async function allTx() { return dbAll('SELECT user_id, amount, period, status FROM transactions WHERE status = ?', 'COMPLETED'); }
async function getTx(id) { return dbOne('SELECT * FROM transactions WHERE transaction_id = ?', id); }
async function memberTx(userId) { return dbAll('SELECT * FROM transactions WHERE status = ? AND user_id = ? ORDER BY timestamp DESC', 'COMPLETED', userId); }
async function allTransactions() { return dbAll('SELECT * FROM transactions WHERE status = ? ORDER BY timestamp DESC', 'COMPLETED'); }
async function hasReference(ref) { return ref ? !!(await dbOne('SELECT transaction_id FROM transactions WHERE reference = ?', ref)) : false; }

async function createTransactionInner(o) {
  if (o.reference && await hasReference(o.reference)) throw new Error('DUPLICATE');
  const id = await nextId('transactions', 'TX-', 6);
  const bal = (await sumTx(o.user_id)) + toInt(o.amount);
  const created = await dbInsert('transactions', {
    transaction_id: id, timestamp: nowIso(), user_id: o.user_id, type: o.type, amount: toInt(o.amount),
    period: o.period || null, payment_method: o.payment_method || null, description: o.description || null,
    balance_after: bal, created_by: o.created_by || null, status: 'COMPLETED', reference: o.reference || null
  });
  return created[0];
}
async function createTransaction(o) { return withLock(() => createTransactionInner(o)); }

async function reverseTransaction(admin, txId, reason) {
  return withLock(async () => {
    const orig = await getTx(txId);
    if (!orig || orig.status !== 'COMPLETED') throw new Error('NOT_FOUND');
    if (orig.type === 'REVERSAL') throw new Error('ALREADY_REVERSED');
    const rev = await createTransactionInner({
      user_id: orig.user_id, type: 'REVERSAL', amount: -Math.abs(toInt(orig.amount)),
      period: orig.period, payment_method: orig.payment_method,
      description: reason || ('Pembalikan dari ' + txId), created_by: admin.admin_id, reference: txId
    });
    await writeAuditLog(admin, 'REVERSE_TRANSACTION', 'TRANSACTION', txId, formatIDR(orig.amount), 'SUCCESS');
    return rev;
  });
}

// ---- payments ----
const validMethod = m => PAY_METHODS.indexOf(m) >= 0;
async function recordPayment(admin, o) {
  return withLock(async () => {
    const member = await getMember(o.member_id);
    if (!member) throw new Error('MEMBER_NOT_FOUND');
    if (member.status !== 'ACTIVE') throw new Error('MEMBER_INACTIVE');
    if (!isPosInt(o.amount)) throw new Error('INVALID_AMOUNT');
    if (!isValidPeriod(o.period)) throw new Error('INVALID_PERIOD');
    if (!validMethod(o.method)) throw new Error('INVALID_METHOD');
    const tx = await createTransactionInner({
      user_id: o.member_id, type: 'CONTRIBUTION', amount: toInt(o.amount), period: o.period,
      payment_method: o.method, description: o.description || (periodLabel(o.period) + ' kontribusi'),
      created_by: admin.admin_id, reference: o.reference || uniqueId('PMT')
    });
    await writeAuditLog(admin, 'RECORD_PAYMENT', 'USER', o.member_id, periodLabel(o.period) + ' / ' + formatIDR(tx.amount), 'SUCCESS');
    return tx;
  });
}
async function correctPayment(admin, txId, newAmount) {
  return withLock(async () => {
    const orig = await getTx(txId);
    if (!orig || orig.status !== 'COMPLETED') throw new Error('NOT_FOUND');
    if (orig.type !== 'CONTRIBUTION') throw new Error('NOT_CONTRIBUTION');
    if (!isPosInt(newAmount)) throw new Error('INVALID_AMOUNT');
    const rev = await createTransactionInner({
      user_id: orig.user_id, type: 'REVERSAL', amount: -Math.abs(toInt(orig.amount)),
      period: orig.period, payment_method: orig.payment_method,
      description: 'Pembalikan dari ' + txId, created_by: admin.admin_id, reference: txId
    });
    const corr = await createTransactionInner({
      user_id: orig.user_id, type: 'CONTRIBUTION', amount: toInt(newAmount), period: orig.period,
      payment_method: orig.payment_method, description: 'Koreksi dari ' + txId,
      created_by: admin.admin_id, reference: 'CORR-' + txId
    });
    await writeAuditLog(admin, 'CORRECT_PAYMENT', 'TRANSACTION', txId, formatIDR(orig.amount) + ' -> ' + formatIDR(corr.amount), 'SUCCESS');
    return { reversal: rev, correction: corr };
  });
}

// ---- balances / reports / unpaid ----
async function balancesOverview() {
  const ms = await activeMembers();
  let total = 0, withBal = 0;
  for (const u of ms) { const b = await getBalance(u.user_id); total += b; if (b > 0) withBal++; }
  return { members: ms.length, totalBalance: total, withBalance: withBal, zero: ms.length - withBal, inactive: (await listMembers()).length - ms.length };
}
async function unpaidMembers(period) {
  const ms = await activeMembers();
  const out = [];
  for (const m of ms) if (await sumTx(m.user_id, period) < await memberFee(m)) out.push(m);
  return out;
}
async function unpaidSummary(period) {
  const ms = await activeMembers();
  let expected = 0, collected = 0, outstanding = 0, paid = 0;
  for (const m of ms) {
    const fee = await memberFee(m);
    const net = await sumTx(m.user_id, period);
    expected += fee; collected += Math.min(net, fee);
    if (net >= fee) paid++; else outstanding += (fee - net);
  }
  return { period, total: ms.length, expected, collected, outstanding, paid, unpaid: ms.length - paid };
}
async function monthlyReport(period) {
  const s = await unpaidSummary(period);
  let funds = 0;
  for (const m of await activeMembers()) funds += await getBalance(m.user_id);
  return { period, total: s.total, paid: s.paid, unpaid: s.unpaid, expected: s.expected, collected: s.collected, outstanding: s.outstanding, funds };
}
async function yearlyReport(year) {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const p = year + '-' + pad(m, 2);
    if (p > currentPeriod()) continue;
    const r = await monthlyReport(p);
    months.push({ period: p, label: periodLabel(p), paid: r.paid, total: r.total, collected: r.collected, expected: r.expected, outstanding: r.outstanding });
  }
  const t = { expected: 0, collected: 0, outstanding: 0, paid: 0 };
  months.forEach(x => { t.expected += x.expected; t.collected += x.collected; t.outstanding += x.outstanding; t.paid += x.paid; });
  return { year, months, totals: t };
}
async function memberBalanceSummary() {
  const list = [];
  for (const m of await activeMembers()) list.push({ user_id: m.user_id, name: m.name, balance: await getBalance(m.user_id) });
  return list.sort((a, b) => b.balance - a.balance);
}

// ---- store / QR (R2) / payment gateway ----
async function getStoreConfig() {
  return {
    bank_name: await cfg('bank_name'), account_name: await cfg('account_name'), account_number: await cfg('account_number'),
    qr_url: await cfg('qr_url'), payment_method: await cfg('payment_method'),
    pg_api_key: await cfg('pg_api_key'), pg_api_base: await cfg('pg_api_base')
  };
}
async function pgCreatePayment(c, orderId, amount) {
  const res = await fetch(c.pg_api_base + '/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': c.pg_api_key },
    body: JSON.stringify({
      order_id: orderId, amount, currency: 'IDR', expires_in_hours: 24,
      success_return_url: E.QR_PUBLIC_URL || BASE, cancel_return_url: E.QR_PUBLIC_URL || BASE,
      payment_method_type_code: 'QRIS'
    })
  });
  if (!res.ok) throw new Error('PG_HTTP_' + res.status);
  return res.json();
}
async function updateStoreField(admin, field, value) {
  await setConfig(field, value, admin.admin_id);
  await writeAuditLog(admin, 'UPDATE_STORE', 'STORE', field, String(value), 'SUCCESS');
}
async function setQrCode(admin, url) {
  await setConfig('qr_url', url, admin.admin_id);
  await writeAuditLog(admin, 'UPDATE_QR', 'STORE', 'qr_url', 'QR code replaced', 'SUCCESS');
}
async function uploadQr(buf) {
  if (!E.QR_BUCKET) throw new Error('QR_BUCKET_BINDING_MISSING');
  await E.QR_BUCKET.put('payment-qrcode.png', buf, { httpMetadata: { contentType: 'image/png' } });
  return (E.QR_PUBLIC_URL || BASE) + '/qr';
}
async function serveQr(request) {
  const obj = await E.QR_BUCKET.get('payment-qrcode.png');
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: { 'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/png', 'Cache-Control': 'public, max-age=3600' }
  });
}
async function setConfig(key, value, by) {
  await dbUpsert('config', { key, value: String(value), updated_at: nowIso(), updated_by: by || '' }, ['key']);
}

// ---- notifications ----
async function notifyMember(m, text) { if (m && m.telegram_id) await sendTelegramMessage(m.telegram_id, text); }
async function notifyAdmins(text) { for (const a of await activeAdmins()) await sendTelegramMessage(a.telegram_id, text); }
function reminderText(m, period, fee) { return '🔔 Pengingat Bulanan\n\nKontribusi ' + periodLabel(period) + ' sebesar ' + formatIDR(fee) + ' untuk ' + m.name + ' belum tercatat.\n\nSilakan lakukan pembayaran Anda.\n\nTerima kasih.'; }
async function remindUnpaid(period, memberIds) {
  const targets = memberIds ? (await Promise.all(memberIds.map(getMember))).filter(Boolean) : await unpaidMembers(period);
  let sent = 0;
  for (const m of targets) {
    if (!m || !m.telegram_id) continue;
    if (!memberIds) {
      const dup = await dbUpsertIgnore('notifications', { user_id: m.user_id, period, type: 'MONTHLY_REMINDER' }, ['user_id', 'period', 'type']);
      if (dup.length === 0) continue;
    }
    await notifyMember(m, reminderText(m, period, await memberFee(m)));
    sent++;
  }
  return sent;
}
async function dailySummary() {
  const today = todayLocal();
  const range = localDayRange(today);
  const txs = await dbAll('SELECT amount FROM transactions WHERE status = ? AND type = ? AND timestamp >= ? AND timestamp < ?', 'COMPLETED', 'CONTRIBUTION', range.from, range.to);
  const collected = txs.reduce((s, t) => s + toInt(t.amount), 0);
  const newUsers = await dbAll('SELECT created_at FROM users WHERE created_at >= ? AND created_at < ?', range.from, range.to);
  const sum = await unpaidSummary(currentPeriod());
  let funds = 0;
  for (const m of await activeMembers()) funds += await getBalance(m.user_id);
  const text = '📊 Ringkasan Harian\n' + fmtDate(new Date(), 'd MMMM yyyy')
    + '\n\nPembayaran:\n' + txs.length + '\n\nTerkumpul:\n' + formatIDR(collected)
    + '\n\nAnggota Baru:\n' + newUsers.length + '\n\nBelum Bayar:\n' + sum.unpaid
    + '\n\nDana Saat Ini:\n' + formatIDR(funds) + '\n\nSistem:\n🟢 Operasional';
  await notifyAdmins(text);
}

// ---- telegram ----
const TG = 'https://api.telegram.org/bot';
async function tg(method, payload) {
  const res = await fetch(TG + E.BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return res.json();
}
const btn = (text, data) => ({ text, callback_data: data });
async function sendTelegramMessage(chatId, text, buttons) {
  const p = { chat_id: String(chatId), text };
  if (buttons) p.reply_markup = { inline_keyboard: buttons };
  return tg('sendMessage', p);
}
async function sendTelegramPhoto(chatId, url, caption, buttons) {
  const p = { chat_id: String(chatId), photo: url, caption: caption || '' };
  if (buttons) p.reply_markup = { inline_keyboard: buttons };
  return tg('sendPhoto', p);
}
async function sendTelegramDocument(chatId, filename, content, mime) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('document', new Blob([content], { type: mime }), filename);
  return fetch(TG + E.BOT_TOKEN + '/sendDocument', { method: 'POST', body: fd }).then(r => r.json());
}
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function buildXls(sheetName, rows) {
  const cells = r => r.map(c => {
    const t = typeof c === 'number' ? 'Number' : 'String';
    return '<Cell><Data ss:Type="' + t + '">' + xmlEsc(c) + '</Data></Cell>';
  }).join('');
  const body = rows.map(r => '<Row>' + cells(r) + '</Row>').join('');
  return '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
    + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
    + '<Worksheet ss:Name="' + xmlEsc(sheetName) + '"><Table>' + body + '</Table></Worksheet></Workbook>';
}
async function answerCallback(cbId, text, alert) {
  return tg('answerCallbackQuery', { callback_query_id: String(cbId), text: text || '', show_alert: !!alert });
}
function mainMenuKeyboard(admin) {
  const kb = [];
  const push = (label, data) => kb.push([btn(label, data)]);
  if (hasPermission(admin, 'members.read')) push('👥 Anggota', 'menu_members');
  if (hasPermission(admin, 'balances.read')) push('💰 Saldo', 'menu_balances');
  if (hasPermission(admin, 'payments.read')) push('💳 Pembayaran', 'menu_payments');
  if (hasPermission(admin, 'unpaid.read')) push('❌ Belum Bayar', 'menu_unpaid');
  if (hasPermission(admin, 'reports.read')) push('📊 Laporan', 'menu_reports');
  if (hasPermission(admin, 'notifications.send')) push('🔔 Notifikasi', 'menu_notifications');
  if (hasPermission(admin, 'settings.read')) push('⚙️ Pengaturan', 'menu_settings');
  if (hasPermission(admin, 'audit.read')) push('📝 Log Audit', 'menu_audit');
  if (hasPermission(admin, 'admins.read')) push('👑 Admin', 'menu_admins');
  return kb;
}
async function sendMainMenu(chatId, admin) {
  await sendTelegramMessage(chatId, '⚙️ Menu Admin\n\n' + admin.name + ' (' + admin.role + ')', mainMenuKeyboard(admin));
}

// ---- state (DB) ----
const BACK_STACK_KEY = '_back_stack';
async function stateGet(chatId) {
  const r = await dbOne('SELECT state FROM bot_state WHERE chat_id = ?', toInt(chatId));
  if (!r) return {};
  try { return JSON.parse(r.state); } catch (e) { return {}; }
}
async function stateSet(chatId, o) {
  const cur = await stateGet(chatId) || {};
  let stack = o[BACK_STACK_KEY];
  if (stack === undefined) stack = cur[BACK_STACK_KEY];
  const merged = stack !== undefined ? { ...o, [BACK_STACK_KEY]: stack } : o;
  await dbUpsert('bot_state', { chat_id: toInt(chatId), state: JSON.stringify(merged), updated_at: nowIso() }, ['chat_id']);
}
async function stateClear(chatId) { await dbRun('DELETE FROM bot_state WHERE chat_id = ?', toInt(chatId)); }
async function pushBackTarget(chatId, target) {
  const st = await stateGet(chatId) || {};
  const stack = (st[BACK_STACK_KEY] || []).slice(-9);
  stack.push(target);
  await stateSet(chatId, { ...st, [BACK_STACK_KEY]: stack });
}
async function popBackTarget(chatId) {
  const st = await stateGet(chatId) || {};
  const stack = st[BACK_STACK_KEY] || [];
  const prev = stack.pop();
  await stateSet(chatId, { ...st, [BACK_STACK_KEY]: stack });
  return prev;
}

// ---- router ----
const deny = chatId => sendTelegramMessage(chatId, '⛔ Akses Ditolak');

async function handleUpdate(update) {
  try {
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
  } catch (err) { console.log('handleUpdate:', err && err.stack || err); }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const admin = await authenticateAdmin(msg.from.id);
  if (!admin) {
    await sendTelegramMessage(chatId, '⛔ Akses Ditolak\n\nAnda tidak memiliki izin untuk mengakses bot admin.\n\nSilakan hubungi administrator sistem.\n\n[id diterima: ' + msg.from.id + ']');
    return;
  }
  const st = await stateGet(chatId);
  if (msg.photo && st && st.flow === 'store_qr') return handleStoreQrPhoto(chatId, admin, msg, st);
  const text = msg.text || '';
  if (text === '/start' || text === '/menu' || text === '/cancel') { await stateClear(chatId); return handleCommand(chatId, admin, text); }
  if (st && st.wait) return handleStateInput(chatId, admin, st, msg);
  if (text.indexOf('/') === 0) return handleCommand(chatId, admin, text);
  return sendMainMenu(chatId, admin);
}

async function handleCommand(chatId, admin, text) {
  const name = text.split(/\s+/)[0].toLowerCase();
  const arg = text.slice(name.length).trim().toUpperCase();
  switch (name) {
    case '/start': case '/menu': case '/help': return sendMainMenu(chatId, admin);
    case '/users': return membersList(chatId, admin, 1, 'ALL');
    case '/user': if (!isValidMemberId(arg)) return sendTelegramMessage(chatId, 'Penggunaan: /user NB-0001'); return memberDetail(chatId, admin, arg);
    case '/addmember': return startAddMember(chatId, admin);
    case '/editmember': if (!isValidMemberId(arg)) return sendTelegramMessage(chatId, 'Penggunaan: /editmember NB-0001'); return editMemberMenu(chatId, admin, arg);
    case '/disablemember': if (!isValidMemberId(arg)) return sendTelegramMessage(chatId, 'Penggunaan: /disablemember NB-0001'); return disableConfirm(chatId, admin, arg);
    case '/balances': return balancesView(chatId, admin);
    case '/balance': if (!isValidMemberId(arg)) return sendTelegramMessage(chatId, 'Penggunaan: /balance NB-0001'); return memberBalanceView(chatId, admin, arg);
    case '/payment': case '/pay':
      if (isValidMemberId(arg)) return startPayment(chatId, admin, arg);
      return startPaymentPick(chatId, admin, 1);
    case '/payments': return paymentsList(chatId, admin, 1);
    case '/unpaid': return unpaidView(chatId, admin, currentPeriod());
    case '/reports': case '/report': return reportsMenu(chatId, admin);
    case '/store': return storeView(chatId, admin);
    case '/notifications': return notificationsView(chatId, admin);
    case '/settings': return settingsView(chatId, admin);
    case '/audit': return auditLog(chatId, admin, 1);
    case '/admins': return adminsList(chatId, admin, 1);
    default:
      await sendTelegramMessage(chatId, 'Perintah tidak dikenal. Gunakan /help');
      return sendMainMenu(chatId, admin);
  }
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const admin = await authenticateAdmin(cb.from.id);
  if (!admin) { await answerCallback(cb.id, 'Access Denied', true); return; }
  const parts = cb.data.split(':');
  const act = parts[0];
  const st = await stateGet(chatId);
  const guard = async () => { await answerCallback(cb.id, 'Sesi berakhir. Silakan mulai lagi.', true); await stateClear(chatId); };
  const ok = async () => answerCallback(cb.id, '');
  switch (act) {
    case 'menu_home': await ok(); return sendMainMenu(chatId, admin);
    case 'menu_members': await ok(); return membersList(chatId, admin, 1, 'ALL');
    case 'menu_balances': await ok(); return balancesView(chatId, admin);
    case 'menu_payments': await ok(); return paymentsList(chatId, admin, 1);
    case 'menu_unpaid': await ok(); return unpaidView(chatId, admin, currentPeriod());
    case 'menu_reports': await ok(); return reportsMenu(chatId, admin);
    case 'menu_store': await ok(); return storeView(chatId, admin);
    case 'menu_notifications': await ok(); return notificationsView(chatId, admin);
    case 'menu_settings': await ok(); return settingsView(chatId, admin);
    case 'menu_audit': await ok(); return auditLog(chatId, admin, 1);
    case 'menu_admins': await ok(); return adminsList(chatId, admin, 1);
    case 'mcancel': await ok(); const prev = await popBackTarget(chatId); const keep = (await stateGet(chatId) || {})[BACK_STACK_KEY] || []; await stateClear(chatId); if (keep.length) await stateSet(chatId, { [BACK_STACK_KEY]: keep }); return prev ? navigateTo(chatId, admin, prev) : sendMainMenu(chatId, admin);

    async function navigateTo(chatId, admin, target) {
      const t = target.split(':')[0];
      switch (t) {
        case 'menu_home': return sendMainMenu(chatId, admin);
        case 'menu_members': return membersList(chatId, admin, 1, 'ALL');
        case 'menu_balances': return balancesView(chatId, admin);
        case 'menu_payments': return paymentsList(chatId, admin, 1);
        case 'menu_unpaid': return unpaidView(chatId, admin, currentPeriod());
        case 'menu_reports': return reportsMenu(chatId, admin);
        case 'menu_store': return storeView(chatId, admin);
        case 'menu_notifications': return notificationsView(chatId, admin);
        case 'menu_settings': return settingsView(chatId, admin);
        case 'menu_audit': return auditLog(chatId, admin, 1);
        case 'menu_admins': return adminsList(chatId, admin, 1);
        case 'mview': return memberDetail(chatId, admin, target.split(':')[1]);
        case 'mhist': return memberHistory(chatId, admin, target.split(':')[1], toInt(target.split(':')[2]));
        case 'mbal': return memberBalanceView(chatId, admin, target.split(':')[1]);
        case 'medit': return editMemberMenu(chatId, admin, target.split(':')[1]);
        case 'plist': return paymentsList(chatId, admin, toInt(target.split(':')[1]));
        case 'pview': return paymentDetail(chatId, admin, target.split(':')[1]);
        case 'unlist': return unpaidList(chatId, admin, target.split(':')[1], toInt(target.split(':')[2]));
        case 'store_pgmenu': return storePgMenu(chatId, admin);
        case 'store_edit': return storeEditMenu(chatId, admin);
        case 'store_chqr': return startQrChange(chatId, admin);
        case 'store_qrview': return viewQr(chatId, admin);
        case 'notif_settings': return notifSettingsView(chatId, admin);
        default: return sendMainMenu(chatId, admin);
      }
    }

    case 'mlist': await ok(); await pushBackTarget(chatId, 'menu_members'); return membersList(chatId, admin, toInt(parts[2]), parts[1]);
    case 'mview': await ok(); await pushBackTarget(chatId, 'menu_members'); return memberDetail(chatId, admin, parts[1]);
    case 'mbal': await ok(); await pushBackTarget(chatId, 'mview:' + parts[1]); return memberBalanceView(chatId, admin, parts[1]);
    case 'mhist': await ok(); await pushBackTarget(chatId, 'mview:' + parts[1]); return memberHistory(chatId, admin, parts[1], toInt(parts[2]));
    case 'madd_start': await ok(); await pushBackTarget(chatId, 'menu_members'); return startAddMember(chatId, admin);
    case 'msearch_start': await ok(); await pushBackTarget(chatId, 'menu_members'); await stateSet(chatId, { flow: 'search', wait: 'q', data: {} }); return sendTelegramMessage(chatId, '🔍 Cari\n\nMasukkan nama atau ID anggota:', [[btn('❌ Batal', 'mcancel')]]);
    case 'medit': await ok(); await pushBackTarget(chatId, 'mview:' + parts[1]); return editMemberMenu(chatId, admin, parts[1]);
    case 'medit_f': if (!st || !st.data || !st.data.id) return guard(); await ok(); await pushBackTarget(chatId, 'medit:' + st.data.id); return editFieldAsk(chatId, admin, parts[1], st);
    case 'mdisable': await ok(); await pushBackTarget(chatId, 'mview:' + parts[1]); return disableConfirm(chatId, admin, parts[1]);
    case 'mdisable_yes': await ok(); return doDisable(chatId, admin, parts[1]);
    case 'mcreate': if (!st || st.flow !== 'addmember' || st.data.reqId !== parts[1]) return guard(); await ok(); return confirmCreateMember(chatId, admin, st);
    case 'add_skip': await ok(); if (!st || st.flow !== 'addmember') return sendMainMenu(chatId, admin);
      if (st.wait === 'phone') return askTg(chatId, st);
      if (st.wait === 'tg') return askFee(chatId, st);
      return sendMainMenu(chatId, admin);

    case 'pay_pick': await ok(); await pushBackTarget(chatId, 'menu_payments'); return startPaymentPick(chatId, admin, toInt(parts[1]));
    case 'pay_member': await ok(); await pushBackTarget(chatId, 'mview:' + parts[1]); return startPayment(chatId, admin, parts[1]);
    case 'pay_period': if (!st || st.flow !== 'pay') return guard(); await ok(); return payPeriod(chatId, admin, parts[1], st);
    case 'pay_amt': if (!st || st.flow !== 'pay') return guard(); await ok(); return payAmount(chatId, admin, parts[1], st);
    case 'pay_meth': if (!st || st.flow !== 'pay') return guard(); await ok(); return payMethod(chatId, admin, parts[1], st);
    case 'pay_confirm': if (!st || st.flow !== 'pay' || st.data.reqId !== parts[1]) return guard(); await ok(); return confirmPayment(chatId, admin, st);
    case 'plist': await ok(); await pushBackTarget(chatId, 'menu_payments'); return paymentsList(chatId, admin, toInt(parts[1]));
    case 'pview': await ok(); await pushBackTarget(chatId, 'menu_payments'); return paymentDetail(chatId, admin, parts[1]);
    case 'prev': await ok(); await pushBackTarget(chatId, 'pview:' + parts[1]); return reverseConfirm(chatId, admin, parts[1]);
    case 'prev_yes': await ok(); return doReverse(chatId, admin, parts[1]);
    case 'pcorr': await ok(); await pushBackTarget(chatId, 'pview:' + parts[1]); return startCorrection(chatId, admin, parts[1]);
    case 'pcorr_yes': if (!st || st.flow !== 'pay' || st.data.reqId !== parts[1]) return guard(); await ok(); return doCorrection(chatId, admin, st);

    case 'unlist': await ok(); await pushBackTarget(chatId, 'menu_unpaid'); return unpaidList(chatId, admin, parts[1], toInt(parts[2]));
    case 'remind': await ok(); await pushBackTarget(chatId, 'menu_unpaid'); return remindConfirm(chatId, admin, parts[1]);
    case 'remind_yes': await ok(); return doRemindAll(chatId, admin, parts[1]);
    case 'remind_one': await ok(); await pushBackTarget(chatId, 'menu_unpaid'); return remindOneConfirm(chatId, admin, parts[1], parts[2]);
    case 'remind_one_yes': await ok(); return doRemindOne(chatId, admin, parts[1], parts[2]);
    case 'unpaid_rpt': await ok(); await pushBackTarget(chatId, 'menu_unpaid'); return monthlyReportView(chatId, admin, parts[1]);

    case 'rpt_month': await ok(); await pushBackTarget(chatId, 'menu_reports'); return monthlyReportView(chatId, admin, parts[1]);
    case 'rpt_year': await ok(); await pushBackTarget(chatId, 'menu_reports'); return yearlyReportView(chatId, admin, parts[1]);
    case 'rpt_contrib': await ok(); await pushBackTarget(chatId, 'menu_reports'); return monthlyReportView(chatId, admin, currentPeriod());
    case 'rpt_outstanding': await ok(); await pushBackTarget(chatId, 'menu_reports'); return outstandingReportView(chatId, admin);
    case 'rpt_mbal': await ok(); await pushBackTarget(chatId, 'menu_reports'); return memberBalanceReportView(chatId, admin);
    case 'rpt_export': await ok(); await pushBackTarget(chatId, 'menu_reports'); return exportReportXls(chatId, admin);
    case 'set_month': await ok(); await pushBackTarget(chatId, 'menu_reports'); return periodPicker(chatId, admin, currentPeriod());
    case 'set_year': await ok(); await pushBackTarget(chatId, 'menu_reports'); return yearPicker(chatId, admin, periodYear(currentPeriod()));

    case 'store_qrview': await ok(); await pushBackTarget(chatId, 'menu_store'); return viewQr(chatId, admin);
    case 'store_chqr': await ok(); await pushBackTarget(chatId, 'menu_store'); return startQrChange(chatId, admin);
    case 'store_edit': await ok(); await pushBackTarget(chatId, 'menu_store'); return storeEditMenu(chatId, admin);
    case 'store_field': await ok(); await pushBackTarget(chatId, parts[1].startsWith('pg_') ? 'store_pgmenu' : 'store_edit'); return storeFieldAsk(chatId, admin, parts[1]);
    case 'store_pgmenu': await ok(); await pushBackTarget(chatId, 'menu_store'); return storePgMenu(chatId, admin);
    case 'store_pgtest': await ok(); await pushBackTarget(chatId, 'store_pgmenu'); return storePgTest(chatId, admin);
    case 'store_mode': await ok(); await pushBackTarget(chatId, 'menu_store'); return setStoreMode(chatId, admin, parts[1]);
    case 'qr_yes': await ok(); return doQrChange(chatId, admin, parts[1]);
    case 'qr_cancel': await ok(); await stateClear(chatId); return sendTelegramMessage(chatId, 'Perubahan QR code dibatalkan.');

    case 'set_edit': await ok(); await pushBackTarget(chatId, 'menu_settings'); return settingAsk(chatId, admin, parts[1]);
    case 'set_notif': await ok(); return toggleNotif(chatId, admin, parts[1], parts[2]);

    case 'notif_remind': await ok(); await pushBackTarget(chatId, 'menu_notifications'); return unpaidView(chatId, admin, currentPeriod());
    case 'notif_daily': await ok(); await pushBackTarget(chatId, 'menu_notifications'); await dailySummary(); return sendTelegramMessage(chatId, '📊 Ringkasan harian terkirim ke admin.', [[btn('⬅️ Kembali', 'mcancel')]]);
    case 'notif_settings': await ok(); await pushBackTarget(chatId, 'menu_settings'); return notifSettingsView(chatId, admin);

    case 'aadd_start': await ok(); await pushBackTarget(chatId, 'menu_admins'); return startAddAdmin(chatId, admin);
    case 'arole': if (!st || st.flow !== 'addadmin') return guard(); await ok(); return adminRole(chatId, admin, parts[1], st);
    case 'acreate': if (!st || st.flow !== 'addadmin' || st.data.reqId !== parts[1]) return guard(); await ok(); return confirmCreateAdmin(chatId, admin, st);
    case 'adis': await ok(); await pushBackTarget(chatId, 'menu_admins'); return adminDisableConfirm(chatId, admin, parts[1]);
    case 'adis_yes': await ok(); return doDisableAdmin(chatId, admin, parts[1]);

    case 'audit_page': await ok(); await pushBackTarget(chatId, 'menu_audit'); return auditLog(chatId, admin, toInt(parts[1]));
    default: await answerCallback(cb.id, 'Aksi tidak dikenal');
  }
}

async function handleStateInput(chatId, admin, st, msg) {
  const text = (msg.text || '').trim();
  if (!text) return sendTelegramMessage(chatId, 'Kirim teks.');
  switch (st.flow) {
    case 'search': {
      const res = await searchMembers(text);
      await stateClear(chatId);
      if (!res.length) return sendTelegramMessage(chatId, 'Tidak ada anggota ditemukan.');
      return searchResults(chatId, admin, res);
    }
    case 'addmember': return addMemberStep(chatId, admin, st, text);
    case 'medit': return editMemberStep(chatId, admin, st, text);
    case 'pay': return payStep(chatId, admin, st, text);
    case 'store_field': return storeFieldStep(chatId, admin, st, text);
    case 'settings': return settingsStep(chatId, admin, st, text);
    case 'addadmin': return adminStep(chatId, admin, st, text);
    default: return sendMainMenu(chatId, admin);
  }
}

// ---- views (ported from router.gs) ----
async function searchResults(chatId, admin, res) {
  const lines = res.slice(0, 10).map((u, i) => (i + 1) + '. ' + u.user_id + ' ' + u.name + (u.status !== 'ACTIVE' ? ' (tidak aktif)' : ''));
  const text = '🔍 Hasil (' + res.length + ')\n\n' + lines.join('\n');
  const kb = res.slice(0, 10).map(u => [btn(u.user_id + ' ' + u.name, 'mview:' + u.user_id)]);
  kb.push([btn('🏠 Menu', 'menu_home')]);
  return sendTelegramMessage(chatId, text, kb);
}

async function membersList(chatId, admin, page, filter) {
  if (!hasPermission(admin, 'members.read')) return deny(chatId);
  const all = filter === 'ACTIVE' ? await activeMembers() : filter === 'INACTIVE' ? await inactiveMembers() : await listMembers();
  const total = all.length;
  const rows = pageSlice(all, page, 10);
  const start = (page - 1) * 10 + 1, end = Math.min(page * 10, total);
  const lines = rows.map((u, i) => (start + i) + '. ' + u.name + (u.status !== 'ACTIVE' ? ' (tidak aktif)' : ''));
  const text = '👥 Anggota ' + start + '–' + end + ' dari ' + total + '\n\n' + lines.join('\n');
  const kb = [];
  if (hasPermission(admin, 'members.create')) kb.push([btn('➕ Tambah Anggota', 'madd_start')]);
  kb.push([btn('🔍 Cari', 'msearch_start')]);
  kb.push([btn('📋 Aktif', 'mlist:ACTIVE:1'), btn('🚫 Tidak Aktif', 'mlist:INACTIVE:1')]);
  rows.forEach(u => kb.push([btn(u.user_id + ' ' + u.name, 'mview:' + u.user_id)]));
  const nav = [];
  if (page > 1) nav.push(btn('⬅️ Sebelumnya', 'mlist:' + filter + ':' + (page - 1)));
  if (page * 10 < total) nav.push(btn('Berikutnya ➡️', 'mlist:' + filter + ':' + (page + 1)));
  if (nav.length) kb.push(nav);
  kb.push([btn('🏠 Menu', 'menu_home')]);
  return sendTelegramMessage(chatId, text, kb);
}

async function memberDetail(chatId, admin, id) {
  if (!hasPermission(admin, 'members.read')) return deny(chatId);
  const m = await getMember(id);
  if (!m) return sendTelegramMessage(chatId, 'Anggota tidak ditemukan.');
  const bal = await getBalance(id);
  const fee = await memberFee(m);
  const period = currentPeriod();
  const paid = (await sumTx(id, period)) >= fee;
  const text = '👤 Anggota\n\nID: ' + m.user_id + '\nNama: ' + m.name + '\nTelegram: ' + (m.telegram_username || '-')
    + '\nStatus: ' + m.status + '\n\nSaldo:\n' + formatIDR(bal)
    + '\n\nIuran Bulanan:\n' + formatIDR(fee)
    + '\n\n' + periodLabel(period) + ':\n' + (paid ? '✅ LUNAS' : '❌ BELUM');
  const kb = [];
  if (hasPermission(admin, 'balances.read')) kb.push([btn('💰 Saldo', 'mbal:' + id)]);
  if (hasPermission(admin, 'payments.create')) kb.push([btn('💳 Catat Pembayaran', 'pay_member:' + id)]);
  kb.push([btn('📊 Riwayat', 'mhist:' + id + ':1')]);
  if (hasPermission(admin, 'members.update')) kb.push([btn('✏️ Edit', 'medit:' + id)]);
  if (hasPermission(admin, 'members.disable') && m.status === 'ACTIVE') kb.push([btn('🚫 Nonaktifkan', 'mdisable:' + id)]);
  kb.push([btn('🏠 Menu', 'menu_home')]);
  return sendTelegramMessage(chatId, text, kb);
}

async function memberHistory(chatId, admin, id, page) {
  if (!hasPermission(admin, 'payments.read')) return deny(chatId);
  const m = await getMember(id);
  if (!m) return sendTelegramMessage(chatId, 'Anggota tidak ditemukan.');
  const tx = await memberTx(id);
  const total = tx.length, rows = pageSlice(tx, page, 10);
  const start = (page - 1) * 10 + 1, end = Math.min(page * 10, total);
  const lines = rows.map(t => t.transaction_id + ' · ' + t.period + ' · ' + t.type + ' · ' + formatIDR(t.amount));
  const text = '📊 Riwayat — ' + m.name + ' (' + m.user_id + ')\n\n' + (lines.join('\n') || 'Tidak ada transaksi.')
    + '\n\nSaldo: ' + formatIDR(await getBalance(id));
  const kb = [];
  const nav = [];
  if (page > 1) nav.push(btn('⬅️ Sebelumnya', 'mhist:' + id + ':' + (page - 1)));
  if (page * 10 < total) nav.push(btn('Berikutnya ➡️', 'mhist:' + id + ':' + (page + 1)));
  if (nav.length) kb.push(nav);
  kb.push([btn('👤 Anggota', 'mview:' + id), btn('🏠 Menu', 'menu_home')]);
  return sendTelegramMessage(chatId, text, kb);
}

async function startAddMember(chatId, admin) {
  if (!hasPermission(admin, 'members.create')) return deny(chatId);
  await stateSet(chatId, { flow: 'addmember', wait: 'name', data: { reqId: uniqueId('NM') } });
  return sendTelegramMessage(chatId, '➕ Tambah Anggota\n\n1/4 — Nama?', [[btn('❌ Batal', 'mcancel')]]);
}
async function addMemberStep(chatId, admin, st, text) {
  const d = st.data;
  switch (st.wait) {
    case 'name':
      if (!text) return sendTelegramMessage(chatId, 'Nama tidak boleh kosong.');
      d.name = text;
      await stateSet(chatId, { flow: 'addmember', wait: 'phone', data: d });
      return sendTelegramMessage(chatId, '2/4 — Nomor telepon? (opsional)', [[btn('⏭ Lewati', 'add_skip')], [btn('❌ Batal', 'mcancel')]]);
    case 'phone':
      if (text !== '/skip') {
        if (!isValidPhone(text)) return sendTelegramMessage(chatId, 'Format nomor tidak valid. Contoh: 08121231122');
        d.phone = text;
      }
      return askTg(chatId, st);
    case 'tg':
      if (text !== '/skip') {
        if (!isValidTelegramId(text)) return sendTelegramMessage(chatId, 'ID Telegram harus berupa angka.');
        d.telegram_id = text;
      }
      return askFee(chatId, st);
    case 'fee':
      if (text !== '/skip') {
        if (!isPosInt(text)) return sendTelegramMessage(chatId, 'Masukkan angka positif (mis. 50000).');
        d.monthly_fee = text;
      }
      await stateSet(chatId, { flow: 'addmember', wait: '', data: d });
      return reviewNewMember(chatId, admin, st);
  }
  return sendMainMenu(chatId, admin);
}
async function askTg(chatId, st) {
  await stateSet(chatId, { flow: 'addmember', wait: 'tg', data: st.data });
  return sendTelegramMessage(chatId, '3/4 — ID Telegram? (opsional)', [[btn('⏭ Lewati', 'add_skip')], [btn('❌ Batal', 'mcancel')]]);
}
async function askFee(chatId, st) {
  await stateSet(chatId, { flow: 'addmember', wait: 'fee', data: st.data });
  return sendTelegramMessage(chatId, '4/4 — Iuran bulanan? Default ' + formatIDR(await getConfig('monthly_fee')) + ' (angka, atau lewati)', [[btn('⏭ Lewati', 'add_skip')], [btn('❌ Batal', 'mcancel')]]);
}
async function reviewNewMember(chatId, admin, st) {
  const d = st.data;
  const text = 'Konfirmasi Anggota Baru\n\nID Anggota:\n' + (await nextId('users', 'NB-', 4))
    + '\n\nNama:\n' + d.name
    + '\n\nTelepon:\n' + (d.phone || '-')
    + '\n\nID Telegram:\n' + (d.telegram_id || '-')
    + '\n\nIuran Bulanan:\n' + formatIDR(d.monthly_fee || await getConfig('monthly_fee'))
    + '\n\nStatus:\nAKTIF';
  return sendTelegramMessage(chatId, text, [[btn('✅ Buat', 'mcreate:' + d.reqId)], [btn('❌ Batal', 'mcancel')]]);
}
async function confirmCreateMember(chatId, admin, st) {
  try {
    const m = await createMember(admin, st.data);
    await stateClear(chatId);
    await sendTelegramMessage(chatId, '✅ Anggota dibuat\n\n' + m.user_id + ' ' + m.name);
    return memberDetail(chatId, admin, m.user_id);
  } catch (e) {
    return sendTelegramMessage(chatId, '❌ Operasi Gagal\n\nTidak dapat membuat anggota.');
  }
}

async function editMemberMenu(chatId, admin, id) {
  if (!hasPermission(admin, 'members.update')) return deny(chatId);
  const m = await getMember(id);
  if (!m) return sendTelegramMessage(chatId, 'Anggota tidak ditemukan.');
  await stateSet(chatId, { flow: 'medit', data: { id } });
  return sendTelegramMessage(chatId, '✏️ Edit ' + m.name + ' (' + id + ')\n\nPilih kolom:', [
    [btn('Nama', 'medit_f:name'), btn('Telepon', 'medit_f:phone')],
    [btn('Alamat', 'medit_f:address'), btn('Username Telegram', 'medit_f:telegram_username')],
    [btn('ID Telegram', 'medit_f:telegram_id'), btn('Iuran Bulanan', 'medit_f:monthly_fee')],
    [btn('❌ Batal', 'mcancel')]
  ]);
}
async function editFieldAsk(chatId, admin, field, st) {
  if (!st || !st.data) return sendMainMenu(chatId, admin);
  const m = await getMember(st.data.id);
  const labels = { name: 'Nama', phone: 'Telepon', address: 'Alamat', telegram_username: 'Username Telegram', telegram_id: 'ID Telegram', monthly_fee: 'Iuran Bulanan' };
  await stateSet(chatId, { flow: 'medit', wait: 'field:' + field, data: { id: st.data.id } });
  return sendTelegramMessage(chatId, 'Saat ini ' + labels[field] + ': ' + (m[field] || '-') + '\n\nMasukkan nilai baru:', [[btn('❌ Batal', 'mcancel')]]);
}
async function editMemberStep(chatId, admin, st, text) {
  const wait = st.wait;
  if (wait.indexOf('field:') === 0) {
    const field = wait.split(':')[1];
    if (field === 'telegram_id' && !isValidTelegramId(text)) return sendTelegramMessage(chatId, 'ID Telegram harus berupa angka.');
    if (field === 'monthly_fee' && !isPosInt(text)) return sendTelegramMessage(chatId, 'Masukkan angka positif.');
    if (field === 'phone' && !isValidPhone(text)) return sendTelegramMessage(chatId, 'Format nomor tidak valid. Contoh: 08121231122');
    const o = {}; o[field] = text;
    await updateMember(admin, st.data.id, o);
    await stateClear(chatId);
    await sendTelegramMessage(chatId, '✅ Diperbarui.');
    return memberDetail(chatId, admin, st.data.id);
  }
  return sendMainMenu(chatId, admin);
}
async function disableConfirm(chatId, admin, id) {
  if (!hasPermission(admin, 'members.disable')) return deny(chatId);
  const m = await getMember(id);
  if (!m) return sendTelegramMessage(chatId, 'Anggota tidak ditemukan.');
  return sendTelegramMessage(chatId, '⚠️ Nonaktifkan Anggota\n\n' + m.name + ' (' + id + ')\n\nIni menghentikan kontribusi berikutnya.', [[btn('✅ Nonaktifkan', 'mdisable_yes:' + id)], [btn('❌ Batal', 'mcancel')]]);
}
async function doDisable(chatId, admin, id) {
  await disableMember(admin, id);
  return sendTelegramMessage(chatId, '🚫 Anggota dinonaktifkan: ' + id);
}

async function balancesView(chatId, admin) {
  if (!hasPermission(admin, 'balances.read')) return deny(chatId);
  const o = await balancesOverview();
  const text = '💰 Dana Komunitas\n\nAnggota:\n' + o.members
    + '\n\nTotal Saldo Saat Ini:\n' + formatIDR(o.totalBalance)
    + '\n\nAnggota Bersaldo:\n' + o.withBalance
    + '\n\nSaldo Nol:\n' + o.zero;
  return sendTelegramMessage(chatId, text, [[btn('🔍 Cari', 'msearch_start')], [btn('🏠 Menu', 'menu_home')]]);
}
async function memberBalanceView(chatId, admin, id) {
  if (!hasPermission(admin, 'balances.read')) return deny(chatId);
  const m = await getMember(id);
  if (!m) return sendTelegramMessage(chatId, 'Anggota tidak ditemukan.');
  return sendTelegramMessage(chatId, '💰 ' + m.name + ' (' + id + ')\n\nSaldo:\n' + formatIDR(await getBalance(id)), [[btn('📊 Riwayat', 'mhist:' + id + ':1')], [btn('🏠 Menu', 'menu_home')]]);
}

async function startPaymentPick(chatId, admin, page) {
  if (!hasPermission(admin, 'payments.create')) return deny(chatId);
  const all = await activeMembers(), total = all.length;
  const rows = pageSlice(all, page, 10);
  const start = (page - 1) * 10 + 1, end = Math.min(page * 10, total);
  const text = '💳 Catat Pembayaran — Pilih anggota (' + start + '–' + end + ' dari ' + total + ')';
  const kb = rows.map(u => [btn(u.user_id + ' ' + u.name, 'pay_member:' + u.user_id)]);
  const nav = [];
  if (page > 1) nav.push(btn('⬅️ Sebelumnya', 'pay_pick:' + (page - 1)));
  if (page * 10 < total) nav.push(btn('Berikutnya ➡️', 'pay_pick:' + (page + 1)));
  if (nav.length) kb.push(nav);
  kb.push([btn('❌ Batal', 'mcancel')]);
  return sendTelegramMessage(chatId, text, kb);
}
async function startPayment(chatId, admin, id) {
  if (!hasPermission(admin, 'payments.create')) return deny(chatId);
  const m = await getMember(id);
  if (!m) return sendTelegramMessage(chatId, 'Anggota tidak ditemukan.');
  if (m.status !== 'ACTIVE') return sendTelegramMessage(chatId, 'Anggota tidak aktif.');
  await stateSet(chatId, { flow: 'pay', data: { member_id: id, reqId: uniqueId('PMT') } });
  const p = currentPeriod();
  return sendTelegramMessage(chatId, '💳 ' + m.name + ' (' + id + ')\n\nPilih periode:', [
    [btn(periodLabel(p), 'pay_period:' + p)],
    [btn(periodLabel(prevPeriod(p)), 'pay_period:' + prevPeriod(p))],
    [btn('✏️ Kustom (YYYY-MM)', 'pay_period:CUSTOM')],
    [btn('❌ Batal', 'mcancel')]
  ]);
}
async function payPeriod(chatId, admin, p, st) {
  if (p === 'CUSTOM') {
    await stateSet(chatId, { flow: 'pay', wait: 'period', data: st.data });
    return sendTelegramMessage(chatId, 'Masukkan periode sebagai YYYY-MM:', [[btn('❌ Batal', 'mcancel')]]);
  }
  st.data.period = p;
  return showAmountOptions(chatId, admin, st);
}
async function showAmountOptions(chatId, admin, st) {
  const m = await getMember(st.data.member_id);
  const fee = await memberFee(m);
  await stateSet(chatId, { flow: 'pay', wait: 'amount', data: st.data });
  return sendTelegramMessage(chatId, 'Jumlah untuk ' + periodLabel(st.data.period) + '?\n\nDefault iuran bulanan: ' + formatIDR(fee), [
    [btn(formatIDR(fee), 'pay_amt:' + fee), btn(formatIDR(Math.round(fee / 2)), 'pay_amt:' + Math.round(fee / 2))],
    [btn('✏️ Kustom', 'pay_amt:CUSTOM')],
    [btn('❌ Batal', 'mcancel')]
  ]);
}
async function payAmount(chatId, admin, a, st) {
  if (a === 'CUSTOM') {
    await stateSet(chatId, { flow: 'pay', wait: 'amount', data: st.data });
    return sendTelegramMessage(chatId, 'Masukkan jumlah dalam IDR (angka positif):', [[btn('❌ Batal', 'mcancel')]]);
  }
  if (!isPosInt(a)) return sendTelegramMessage(chatId, 'Jumlah tidak valid.');
  st.data.amount = a;
  return payMethodSelect(chatId, admin, st);
}
async function payMethodSelect(chatId, admin, st) {
  await stateSet(chatId, { flow: 'pay', wait: '', data: st.data });
  return sendTelegramMessage(chatId, 'Metode pembayaran untuk ' + formatIDR(st.data.amount) + '?', [
    [btn('QRIS', 'pay_meth:QRIS'), btn('Transfer Bank', 'pay_meth:BANK_TRANSFER')],
    [btn('Tunai', 'pay_meth:CASH'), btn('Lainnya', 'pay_meth:OTHER')],
    [btn('❌ Batal', 'mcancel')]
  ]);
}
async function payMethod(chatId, admin, method, st) {
  if (!validMethod(method)) return sendTelegramMessage(chatId, 'Metode tidak valid.');
  st.data.method = method;
  await stateSet(chatId, { flow: 'pay', wait: '', data: st.data });
  return reviewPayment(chatId, admin, st);
}
async function reviewPayment(chatId, admin, st) {
  const d = st.data;
  const m = await getMember(d.member_id);
  const bal = await getBalance(d.member_id);
  const amount = toInt(d.amount);
  const text = '⚠️ Konfirmasi Pembayaran\n\nAnggota:\n' + m.name
    + '\n\nID Anggota:\n' + m.user_id
    + '\n\nPeriode:\n' + periodLabel(d.period)
    + '\n\nJumlah:\n' + formatIDR(amount)
    + '\n\nMetode:\n' + d.method
    + '\n\nSaldo Saat Ini:\n' + formatIDR(bal)
    + '\n\nSaldo Baru:\n' + formatIDR(bal + amount);
  return sendTelegramMessage(chatId, text, [[btn('✅ Konfirmasi', 'pay_confirm:' + d.reqId)], [btn('❌ Batal', 'mcancel')]]);
}
async function confirmPayment(chatId, admin, st) {
  const d = st.data;
  let tx;
  try {
    tx = await recordPayment(admin, { member_id: d.member_id, period: d.period, amount: d.amount, method: d.method, reference: d.reqId });
  } catch (err) {
    await stateClear(chatId);
    if (err.message === 'DUPLICATE') return sendTelegramMessage(chatId, 'Pembayaran ini sudah tercatat.');
    return sendTelegramMessage(chatId, '❌ Operasi Gagal\n\nTidak dapat mencatat pembayaran.');
  }
  await stateClear(chatId);
  await sendTelegramMessage(chatId, '✅ Pembayaran tercatat\n\n' + tx.transaction_id + '\n' + d.member_id + ' · ' + periodLabel(tx.period) + ' · ' + formatIDR(tx.amount));
  if (await getConfig('payment_notification_enabled') === 'true') {
    const m = await getMember(d.member_id);
    await notifyMember(m, '✅ Pembayaran Dikonfirmasi\n\nTerima kasih ' + (m ? m.name : '') + '! Kontribusi ' + periodLabel(tx.period) + ' Anda sebesar ' + formatIDR(tx.amount) + ' telah tercatat.');
  }
}
async function payStep(chatId, admin, st, text) {
  const d = st.data;
  if (st.wait === 'period') {
    if (!isValidPeriod(text)) return sendTelegramMessage(chatId, 'Periode tidak valid. Gunakan YYYY-MM (mis. 2026-08).');
    d.period = text;
    return showAmountOptions(chatId, admin, st);
  }
  if (st.wait === 'amount') {
    if (!isPosInt(text)) return sendTelegramMessage(chatId, 'Masukkan angka positif.');
    d.amount = text;
    return payMethodSelect(chatId, admin, st);
  }
  if (st.wait === 'corr') {
    if (!isPosInt(text)) return sendTelegramMessage(chatId, 'Masukkan angka positif.');
    d.amount = text;
    await stateSet(chatId, { flow: 'pay', wait: 'corr_review', data: d });
    const t = await getTx(d.txId);
    return sendTelegramMessage(chatId, '⚠️ Konfirmasi Koreksi\n\nAsli:\n' + t.transaction_id + ' ' + formatIDR(t.amount)
      + '\n\nBenar:\n' + formatIDR(text)
      + '\n\nPEMBALIKAN diikuti entri terkoreksi akan dicatat.',
      [[btn('✅ Konfirmasi', 'pcorr_yes:' + d.reqId)], [btn('❌ Batal', 'mcancel')]]);
  }
  return sendMainMenu(chatId, admin);
}

async function paymentsList(chatId, admin, page) {
  if (!hasPermission(admin, 'payments.read')) return deny(chatId);
  const tx = await allTransactions(), total = tx.length, rows = pageSlice(tx, page, 10);
  const start = (page - 1) * 10 + 1, end = Math.min(page * 10, total);
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    const m = await getMember(t.user_id);
    lines.push((start + i) + '. ' + t.transaction_id + ' · ' + (m ? m.name : t.user_id) + ' · ' + formatIDR(t.amount));
  }
  const text = '💳 Pembayaran ' + start + '–' + end + ' dari ' + total + '\n\n' + (lines.join('\n') || 'Tidak ada transaksi.');
  const kb = [];
  for (const t of rows) {
    const m = await getMember(t.user_id);
    kb.push([btn(t.transaction_id + ' · ' + (m ? m.name : t.user_id) + ' · ' + formatIDR(t.amount), 'pview:' + t.transaction_id)]);
  }
  const nav = [];
  if (page > 1) nav.push(btn('⬅️ Sebelumnya', 'plist:' + (page - 1)));
  if (page * 10 < total) nav.push(btn('Berikutnya ➡️', 'plist:' + (page + 1)));
  if (nav.length) kb.push(nav);
  kb.push([btn('🏠 Menu', 'menu_home')]);
  return sendTelegramMessage(chatId, text, kb);
}
async function paymentDetail(chatId, admin, txId) {
  if (!hasPermission(admin, 'payments.read')) return deny(chatId);
  const t = await getTx(txId);
  if (!t) return sendTelegramMessage(chatId, 'Transaksi tidak ditemukan.');
  const m = await getMember(t.user_id);
  const text = '🧾 Transaksi\n\nID:\n' + t.transaction_id
    + '\n\nAnggota:\n' + (m ? m.name : t.user_id)
    + '\n\nTipe:\n' + t.type
    + '\n\nPeriode:\n' + periodLabel(t.period)
    + '\n\nJumlah:\n' + formatIDR(t.amount)
    + '\n\nMetode:\n' + (t.payment_method || '-')
    + '\n\nSaldo Setelah:\n' + formatIDR(t.balance_after)
    + '\n\nOleh:\n' + (t.created_by || '-')
    + '\n\n' + t.timestamp;
  const kb = [];
  if (hasPermission(admin, 'payments.correct') && t.type === 'CONTRIBUTION') {
    kb.push([btn('↩️ Balikkan', 'prev:' + txId)]);
    kb.push([btn('✏️ Koreksi Jumlah', 'pcorr:' + txId)]);
  }
  kb.push([btn('💳 Pembayaran', 'plist:1'), btn('🏠 Menu', 'menu_home')]);
  return sendTelegramMessage(chatId, text, kb);
}
async function reverseConfirm(chatId, admin, txId) {
  if (!hasPermission(admin, 'payments.correct')) return deny(chatId);
  const t = await getTx(txId);
  if (!t) return sendTelegramMessage(chatId, 'Tidak ditemukan.');
  return sendTelegramMessage(chatId, '⚠️ Balikkan transaksi ' + txId + ' (' + formatIDR(t.amount) + ')?\n\nPEMBALIKAN akan dicatat. Transaksi asli tetap di riwayat.', [[btn('✅ Balikkan', 'prev_yes:' + txId)], [btn('❌ Batal', 'mcancel')]]);
}
async function doReverse(chatId, admin, txId) {
  try {
    await reverseTransaction(admin, txId, 'Reversal by admin');
    return sendTelegramMessage(chatId, '✅ ' + txId + ' dibalikkan.');
  } catch (e) {
    return sendTelegramMessage(chatId, '❌ Tidak dapat membalikkan transaksi.');
  }
}
async function startCorrection(chatId, admin, txId) {
  if (!hasPermission(admin, 'payments.correct')) return deny(chatId);
  const t = await getTx(txId);
  if (!t) return sendTelegramMessage(chatId, 'Tidak ditemukan.');
  await stateSet(chatId, { flow: 'pay', wait: 'corr', data: { txId, reqId: uniqueId('COR') } });
  return sendTelegramMessage(chatId, '✏️ Koreksi Jumlah\n\nAsli ' + txId + ': ' + formatIDR(t.amount) + '\n\nMasukkan jumlah yang benar (IDR):', [[btn('❌ Batal', 'mcancel')]]);
}
async function doCorrection(chatId, admin, st) {
  try {
    const r = await correctPayment(admin, st.data.txId, st.data.amount);
    await stateClear(chatId);
    return sendTelegramMessage(chatId, '✅ Koreksi selesai\n\nPembalikan: ' + r.reversal.transaction_id + ' (' + formatIDR(r.reversal.amount) + ')\nEntri baru: ' + r.correction.transaction_id + ' (' + formatIDR(r.correction.amount) + ')');
  } catch (e) {
    return sendTelegramMessage(chatId, '❌ Tidak dapat mengoreksi transaksi.');
  }
}

async function unpaidView(chatId, admin, period) {
  if (!hasPermission(admin, 'unpaid.read')) return deny(chatId);
  const s = await unpaidSummary(period);
  const text = '❌ Belum Bayar\n\n' + periodLabel(period)
    + '\n\nEkspektasi:\n' + formatIDR(s.expected)
    + '\n\nTerkumpul:\n' + formatIDR(s.collected)
    + '\n\nKurang:\n' + formatIDR(s.outstanding)
    + '\n\nLunas:\n' + s.paid
    + '\n\nBelum:\n' + s.unpaid;
  const kb = [];
  if (hasPermission(admin, 'notifications.send')) {
    kb.push([btn('📢 Ingatkan Semua', 'remind:' + period)]);
    kb.push([btn('📢 Pilih Anggota', 'unlist:' + period + ':1')]);
  }
  kb.push([btn('📊 Laporan', 'unpaid_rpt:' + period)]);
  kb.push([btn('⬅️ Kembali', 'mcancel')]);
  kb.push([btn('🏠 Menu', 'menu_home')]);
  return sendTelegramMessage(chatId, text, kb);
}
async function unpaidList(chatId, admin, period, page) {
  if (!hasPermission(admin, 'unpaid.read')) return deny(chatId);
  const all = await unpaidMembers(period), total = all.length, rows = pageSlice(all, page, 10);
  const start = (page - 1) * 10 + 1, end = Math.min(page * 10, total);
  const text = '📢 Pilih anggota yang belum bayar (' + start + '–' + end + ' dari ' + total + ')';
  const kb = rows.map(u => [btn(u.user_id + ' ' + u.name, 'remind_one:' + u.user_id + ':' + period)]);
  const nav = [];
  if (page > 1) nav.push(btn('⬅️ Sebelumnya', 'unlist:' + period + ':' + (page - 1)));
  if (page * 10 < total) nav.push(btn('Berikutnya ➡️', 'unlist:' + period + ':' + (page + 1)));
  if (nav.length) kb.push(nav);
  kb.push([btn('❌ Batal', 'mcancel')]);
  return sendTelegramMessage(chatId, text, kb);
}
async function remindConfirm(chatId, admin, period) {
  if (!hasPermission(admin, 'notifications.send')) return deny(chatId);
  const s = await unpaidSummary(period);
  return sendTelegramMessage(chatId, '⚠️ Kirim pengingat ke ' + s.unpaid + ' anggota yang belum bayar untuk ' + periodLabel(period) + '?', [[btn('✅ Kirim', 'remind_yes:' + period)], [btn('❌ Batal', 'mcancel')]]);
}
async function doRemindAll(chatId, admin, period) {
  const n = await remindUnpaid(period);
  return sendTelegramMessage(chatId, '📢 Pengingat terkirim ke ' + n + ' anggota.', [[btn('⬅️ Kembali', 'mcancel')]]);
}
async function remindOneConfirm(chatId, admin, id, period) {
  const m = await getMember(id);
  if (!m) return sendTelegramMessage(chatId, 'Anggota tidak ditemukan.');
  return sendTelegramMessage(chatId, '📢 Kirim pengingat ke ' + m.name + ' untuk ' + periodLabel(period) + '?', [[btn('✅ Kirim', 'remind_one_yes:' + id + ':' + period)], [btn('❌ Batal', 'mcancel')]]);
}
async function doRemindOne(chatId, admin, id, period) {
  const m = await getMember(id);
  if (!m) return sendTelegramMessage(chatId, 'Anggota tidak ditemukan.');
  await notifyMember(m, reminderText(m, period, await memberFee(m)));
  return sendTelegramMessage(chatId, '📢 Pengingat terkirim ke ' + m.name + '.', [[btn('⬅️ Kembali', 'mcancel')]]);
}

async function reportsMenu(chatId, admin) {
  if (!hasPermission(admin, 'reports.read')) return deny(chatId);
  return sendTelegramMessage(chatId, '📊 Laporan', [
    [btn('📅 Bulanan', 'set_month'), btn('🗓 Tahunan', 'set_year')],
    [btn('📈 Ringkasan Kontribusi', 'rpt_contrib')],
    [btn('📉 Kurang Bayar', 'rpt_outstanding')],
    [btn('💰 Saldo Anggota', 'rpt_mbal')],
    [btn('📤 Export XLS', 'rpt_export')],
    [btn('🏠 Menu', 'menu_home')]
  ]);
}
async function periodPicker(chatId, admin, p) {
  const prev = prevPeriod(p);
  return sendTelegramMessage(chatId, 'Pilih bulan:', [[btn(periodLabel(p), 'rpt_month:' + p)], [btn(periodLabel(prev), 'rpt_month:' + prev)], [btn('❌ Batal', 'mcancel')]]);
}
async function yearPicker(chatId, admin, y) {
  return sendTelegramMessage(chatId, 'Pilih tahun:', [[btn(String(y), 'rpt_year:' + y)], [btn(String(y - 1), 'rpt_year:' + (y - 1))], [btn('❌ Batal', 'mcancel')]]);
}
async function monthlyReportView(chatId, admin, period) {
  if (!hasPermission(admin, 'reports.read')) return deny(chatId);
  const r = await monthlyReport(period);
  const text = '📊 ' + periodLabel(period)
    + '\n\nAnggota:\n' + r.total
    + '\n\nLunas:\n' + r.paid
    + '\n\nBelum:\n' + r.unpaid
    + '\n\nEkspektasi:\n' + formatIDR(r.expected)
    + '\n\nTerkumpul:\n' + formatIDR(r.collected)
    + '\n\nKurang:\n' + formatIDR(r.outstanding)
    + '\n\nDana Saat Ini:\n' + formatIDR(r.funds);
  return sendTelegramMessage(chatId, text, [[btn('⬅️ Kembali', 'mcancel')], [btn('📊 Laporan', 'menu_reports'), btn('🏠 Menu', 'menu_home')]]);
}
async function yearlyReportView(chatId, admin, year) {
  if (!hasPermission(admin, 'reports.read')) return deny(chatId);
  const r = await yearlyReport(year);
  const lines = r.months.map(x => x.period + '  Lunas ' + x.paid + '/' + x.total + '  ' + formatIDR(x.collected));
  const text = '📊 Ringkasan Tahunan ' + year + '\n\n' + (lines.join('\n') || 'Tidak ada data.')
    + '\n\nEkspektasi:\n' + formatIDR(r.totals.expected)
    + '\n\nTerkumpul:\n' + formatIDR(r.totals.collected)
    + '\n\nKurang:\n' + formatIDR(r.totals.outstanding);
  return sendTelegramMessage(chatId, text, [[btn('🏠 Menu', 'menu_home')]]);
}
async function outstandingReportView(chatId, admin) {
  const period = currentPeriod();
  const s = await unpaidSummary(period);
  const list = [];
  for (const u of await unpaidMembers(period)) {
    const fee = await memberFee(u);
    list.push(u.user_id + ' ' + u.name + ' — ' + formatIDR(fee - Math.min(await sumTx(u.user_id, period), fee)));
  }
  const text = '📉 Kurang Bayar — ' + periodLabel(period) + '\n\n' + (list.join('\n') || 'Tidak ada!')
    + '\n\nTotal Kurang:\n' + formatIDR(s.outstanding);
  return sendTelegramMessage(chatId, text, [[btn('⬅️ Kembali', 'mcancel')], [btn('🏠 Menu', 'menu_home')]]);
}
async function memberBalanceReportView(chatId, admin) {
  const list = await memberBalanceSummary();
  const lines = list.map(x => x.user_id + ' ' + x.name + ' — ' + formatIDR(x.balance));
  const total = list.reduce((s, x) => s + x.balance, 0);
  const text = '💰 Ringkasan Saldo Anggota\n\n' + (lines.join('\n') || 'Tidak ada anggota.') + '\n\nTotal:\n' + formatIDR(total);
  return sendTelegramMessage(chatId, text, [[btn('⬅️ Kembali', 'mcancel')], [btn('🏠 Menu', 'menu_home')]]);
}

async function exportReportXls(chatId, admin) {
  if (!hasPermission(admin, 'reports.read')) return deny(chatId);
  const period = currentPeriod();
  const rows = [['ID', 'Nama', 'Telepon', 'Iuran', 'Periode', 'Status', 'Saldo']];
  for (const m of await activeMembers()) {
    const fee = await memberFee(m);
    const paid = await sumTx(m.user_id, period) >= fee;
    rows.push([m.user_id, m.name, m.phone || '-', fee, period, paid ? 'LUNAS' : 'BELUM', await getBalance(m.user_id)]);
  }
  const file = buildXls('Laporan ' + period, rows);
  await sendTelegramDocument(chatId, 'laporan_' + period + '.xls', file, 'application/vnd.ms-excel');
  await writeAuditLog(admin, 'EXPORT_REPORT', 'REPORT', period, 'Exported report to XLS', 'SUCCESS');
  return sendTelegramMessage(chatId, '📤 Laporan diekspor (' + period + ').', [[btn('⬅️ Kembali', 'mcancel')], [btn('📊 Laporan', 'menu_reports'), btn('🏠 Menu', 'menu_home')]]);
}

async function storeView(chatId, admin) {
  if (!hasPermission(admin, 'store.read')) return deny(chatId);
  const c = await getStoreConfig();
  const gw = c.payment_method === 'gateway';
  const text = '🏦 Rekening Pembayaran\n\nMetode:\n' + (gw ? '🌐 Payment Gateway' : '🖼 QR Code')
    + '\n\nBank:\n' + (c.bank_name || '-')
    + '\n\nNama Rekening:\n' + (c.account_name || '-')
    + '\n\nNomor Rekening:\n' + (c.account_number || '-')
    + '\n\nQR Code:\n' + (c.qr_url ? '✅ Terpasang' : '❌ Belum diatur')
    + '\n\nPayment Gateway:\n' + (c.pg_api_key ? '✅ API Key terpasang' : '❌ API Key belum diatur')
    + '\nEndpoint:\n' + (c.pg_api_base || '-');
  const kb = [];
  if (!gw && c.qr_url) kb.push([btn('👁 Lihat QR', 'store_qrview')]);
  if (hasPermission(admin, 'store.update')) {
    if (gw) {
      kb.push([btn('🌐 Konfigurasi Gateway', 'store_pgmenu'), btn('🧪 Test Payment', 'store_pgtest')]);
      kb.push([btn('🖼 Pakai QR Code', 'store_mode:qr')]);
    } else {
      kb.push([btn('🔄 Ganti QR', 'store_chqr'), btn('✏️ Edit Rekening', 'store_edit')]);
      kb.push([btn('🌐 Pakai Payment Gateway', 'store_mode:gateway')]);
    }
  }
  kb.push([btn('⚙️ Pengaturan', 'menu_settings')]);
  return sendTelegramMessage(chatId, text, kb);
}
async function storePgMenu(chatId, admin) {
  if (!hasPermission(admin, 'store.update')) return deny(chatId);
  return sendTelegramMessage(chatId, '🌐 Konfigurasi Payment Gateway', [
    [btn('🔑 API Key', 'store_field:pg_api_key'), btn('🔗 Endpoint Base', 'store_field:pg_api_base')],
    [btn('🔔 Webhook URL', 'store_field:pg_webhook_url'), btn('🔒 Signing Secret', 'store_field:pg_webhook_secret')],
    [btn('🎫 Webhook Token', 'store_field:pg_webhook_token')],
    [btn('⚙️ Pengaturan', 'menu_settings'), btn('❌ Batal', 'mcancel')]
  ]);
}
async function storePgTest(chatId, admin) {
  if (!hasPermission(admin, 'store.update')) return deny(chatId);
  const c = await getStoreConfig();
  if (!c.pg_api_key) return sendTelegramMessage(chatId, '❌ API Key belum diatur.\n\nKonfigurasi API Key dahulu.', [[btn('🔑 API Key', 'store_field:pg_api_key')]]);
  try {
    const p = await pgCreatePayment(c, uniqueId('PGT'), 1000);
    await writeAuditLog(admin, 'PG_TEST', 'STORE', 'pg', 'Test payment ' + p.payment_id, 'SUCCESS');
    return sendTelegramMessage(chatId, '🧪 Test Payment\n\nStatus:\n' + p.status + '\n\nLink Pembayaran:\n' + p.payment_link_url
      + '\n\nKode:\n' + (p.payment_code || '-'), [[btn('⚙️ Pengaturan', 'menu_settings')]]);
  } catch (e) {
    console.log('pg test error', e && e.stack || e);
    return sendTelegramMessage(chatId, '❌ Operasi Gagal\n\nTidak dapat membuat test payment.\n\nPeriksa API Key dan koneksi gateway.', [[btn('⚙️ Pengaturan', 'menu_settings')]]);
  }
}
async function setStoreMode(chatId, admin, mode) {
  if (!hasPermission(admin, 'store.update')) return deny(chatId);
  const m = mode === 'gateway' ? 'gateway' : 'qr';
  await setConfig('payment_method', m, admin.admin_id);
  await writeAuditLog(admin, 'UPDATE_STORE', 'STORE', 'payment_method', m, 'SUCCESS');
  await sendTelegramMessage(chatId, '✅ Metode pembayaran diperbarui.');
  return storeView(chatId, admin);
}
async function viewQr(chatId, admin) {
  const url = await cfg('qr_url');
  if (!url) return sendTelegramMessage(chatId, 'QR code belum diatur.');
  return sendTelegramPhoto(chatId, url, 'QR Code', [[btn('🏠 Menu', 'menu_home')]]);
}
async function startQrChange(chatId, admin) {
  if (!hasPermission(admin, 'store.update')) return deny(chatId);
  await stateSet(chatId, { flow: 'store_qr', data: {} });
  return sendTelegramMessage(chatId, 'Kirim gambar QR code baru.', [[btn('❌ Batal', 'mcancel')]]);
}
async function handleStoreQrPhoto(chatId, admin, msg, st) {
  try {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const f = await tg('getFile', { file_id: fileId });
    if (!f.ok) throw new Error('getFile failed');
    const img = await fetch('https://api.telegram.org/file/bot' + E.BOT_TOKEN + '/' + f.result.file_path);
    const url = await uploadQr(await img.arrayBuffer());
    await stateSet(chatId, { flow: 'store_qr', data: { url } });
    return sendTelegramMessage(chatId, 'QR Code Baru Diterima.\n\nGanti QR code saat ini?', [[btn('✅ Ganti', 'qr_yes:' + url)], [btn('❌ Batal', 'mcancel')]]);
  } catch (e) {
    await stateClear(chatId);
    return sendTelegramMessage(chatId, '❌ Tidak dapat memproses gambar.');
  }
}
async function doQrChange(chatId, admin, url) {
  await setQrCode(admin, url);
  await stateClear(chatId);
  await sendTelegramMessage(chatId, '✅ QR code diganti.');
  return storeView(chatId, admin);
}
async function storeEditMenu(chatId, admin) {
  if (!hasPermission(admin, 'store.update')) return deny(chatId);
  return sendTelegramMessage(chatId, '✏️ Edit Rekening Pembayaran', [
    [btn('🏦 Nama Bank', 'store_field:bank_name'), btn('👤 Nama Rekening', 'store_field:account_name')],
    [btn('🔢 Nomor Rekening', 'store_field:account_number')],
    [btn('❌ Batal', 'mcancel')]
  ]);
}
async function storeFieldAsk(chatId, admin, field) {
  await stateSet(chatId, { flow: 'store_field', wait: 'field:' + field, data: {} });
  const labels = { bank_name: 'Nama Bank', account_name: 'Nama Rekening', account_number: 'Nomor Rekening', pg_api_key: 'API Key', pg_api_base: 'Endpoint Base URL', pg_webhook_url: 'Webhook URL', pg_webhook_secret: 'Webhook Signing Secret', pg_webhook_token: 'Webhook Token' };
  return sendTelegramMessage(chatId, 'Masukkan ' + (labels[field] || field) + ' baru:', [[btn('❌ Batal', 'mcancel')]]);
}
async function storeFieldStep(chatId, admin, st, text) {
  const field = st.wait.split(':')[1];
  await updateStoreField(admin, field, text);
  await stateClear(chatId);
  await sendTelegramMessage(chatId, '✅ Diperbarui.');
  return storeView(chatId, admin);
}

async function settingsView(chatId, admin) {
  if (!hasPermission(admin, 'settings.read')) return deny(chatId);
  const text = '⚙️ Pengaturan\n\nIuran Bulanan:\n' + formatIDR(await getConfig('monthly_fee'))
    + '\n\nHari Jatuh Tempo:\n' + await getConfig('payment_due_day')
    + '\n\nZona Waktu:\n' + await getConfig('timezone')
    + '\n\nPengingat Bulanan:\n' + ((await getConfig('monthly_reminder_enabled')) === 'true' ? '✅ Nyala' : '❌ Mati')
    + '\n\nNotifikasi Pembayaran:\n' + ((await getConfig('payment_notification_enabled')) === 'true' ? '✅ Nyala' : '❌ Mati')
    + '\n\nRingkasan Harian Admin:\n' + ((await getConfig('admin_daily_summary_enabled')) === 'true' ? '✅ Nyala' : '❌ Mati');
  const kb = [];
  if (hasPermission(admin, 'settings.update')) {
    kb.push([btn('💰 Iuran Bulanan', 'set_edit:monthly_fee'), btn('📅 Hari Jatuh Tempo', 'set_edit:payment_due_day')]);
    kb.push([btn('🌍 Zona Waktu', 'set_edit:timezone')]);
  }
  kb.push([btn('🔔 Notifikasi', 'notif_settings')]);
  if (hasPermission(admin, 'store.read')) kb.push([btn('🏦 Rekening', 'menu_store')]);
  kb.push([btn('🏠 Menu', 'menu_home')]);
  return sendTelegramMessage(chatId, text, kb);
}
async function settingAsk(chatId, admin, key) {
  if (!hasPermission(admin, 'settings.update')) return deny(chatId);
  await stateSet(chatId, { flow: 'settings', wait: 'key:' + key, data: {} });
  const note = key === 'monthly_fee' ? '\n\n⚠️ Ini hanya memengaruhi kontribusi mendatang.' : '';
  return sendTelegramMessage(chatId, 'Saat ini ' + key + ': ' + (await getConfig(key) || '-') + note + '\n\nMasukkan nilai baru:', [[btn('❌ Batal', 'mcancel')]]);
}
async function settingsStep(chatId, admin, st, text) {
  const key = st.wait.split(':')[1];
  if (!text) return sendTelegramMessage(chatId, 'Nilai tidak boleh kosong.');
  if (key === 'monthly_fee' && !isPosInt(text)) return sendTelegramMessage(chatId, 'Masukkan angka positif.');
  if (key === 'payment_due_day' && (toInt(text) < 1 || toInt(text) > 31)) return sendTelegramMessage(chatId, 'Masukkan hari antara 1 dan 31.');
  await setConfig(key, text, admin.admin_id);
  await writeAuditLog(admin, 'UPDATE_SETTINGS', 'CONFIG', key, text, 'SUCCESS');
  await stateClear(chatId);
  await sendTelegramMessage(chatId, '✅ Diperbarui.');
  return settingsView(chatId, admin);
}
async function notifSettingsView(chatId, admin) {
  const on = '✅ Nyala', off = '❌ Mati';
  const row = async (key, label) => {
    const cur = (await getConfig(key)) === 'true';
    return [btn(label + ' ' + (cur ? on : off), 'set_notif:' + key + ':' + (cur ? 'false' : 'true'))];
  };
  return sendTelegramMessage(chatId, '🔔 Pengaturan Notifikasi', [
    await row('monthly_reminder_enabled', 'Pengingat Bulanan'),
    await row('payment_notification_enabled', 'Konfirmasi Pembayaran'),
    await row('admin_daily_summary_enabled', 'Ringkasan Harian Admin'),
    [btn('🏠 Menu', 'menu_home')]
  ]);
}
async function toggleNotif(chatId, admin, key, val) {
  if (!hasPermission(admin, 'settings.update')) return deny(chatId);
  await setConfig(key, val, admin.admin_id);
  await writeAuditLog(admin, 'UPDATE_SETTINGS', 'CONFIG', key, '=' + val, 'SUCCESS');
  return notifSettingsView(chatId, admin);
}
async function notificationsView(chatId, admin) {
  if (!hasPermission(admin, 'notifications.send')) return deny(chatId);
  return sendTelegramMessage(chatId, '🔔 Notifikasi', [
    [btn('📢 Pengingat Bulanan', 'notif_remind')],
    [btn('📊 Ringkasan Harian Sekarang', 'notif_daily')],
    [btn('🏠 Menu', 'menu_home')]
  ]);
}

async function auditLog(chatId, admin, page) {
  if (!hasPermission(admin, 'audit.read')) return deny(chatId);
  const all = await dbAll('SELECT * FROM audit ORDER BY timestamp DESC');
  const total = all.length, rows = pageSlice(all, page, 10);
  const start = (page - 1) * 10 + 1, end = Math.min(page * 10, total);
  const lines = rows.map((a, i) => (start + i) + '. ' + a.timestamp + ' [' + a.action + '] ' + (a.target_id || '') + ' ' + (a.details || ''));
  const text = '📝 Log Audit ' + start + '–' + end + ' dari ' + total + '\n\n' + (lines.join('\n') || 'Kosong.');
  const kb = [];
  const nav = [];
  if (page > 1) nav.push(btn('⬅️ Sebelumnya', 'audit_page:' + (page - 1)));
  if (page * 10 < total) nav.push(btn('Berikutnya ➡️', 'audit_page:' + (page + 1)));
  if (nav.length) kb.push(nav);
  kb.push([btn('🏠 Menu', 'menu_home')]);
  return sendTelegramMessage(chatId, text, kb);
}

async function adminsList(chatId, admin, page) {
  if (!hasPermission(admin, 'admins.read')) return deny(chatId);
  const all = await listAdmins(), total = all.length;
  const rows = pageSlice(all, page, 10);
  const start = (page - 1) * 10 + 1, end = Math.min(page * 10, total);
  const lines = rows.map((a, i) => (start + i) + '. ' + a.admin_id + ' ' + a.name + ' [' + a.role + ']' + (a.status === 'ACTIVE' ? '' : ' ⚠️ tidak aktif'));
  const text = '👑 Admin ' + start + '–' + end + ' dari ' + total + '\n\n' + lines.join('\n');
  const kb = [];
  if (hasPermission(admin, 'admins.create')) kb.push([btn('➕ Tambah Admin', 'aadd_start')]);
  rows.forEach(a => {
    if (a.status === 'ACTIVE' && hasPermission(admin, 'admins.disable') && a.admin_id !== admin.admin_id) {
      kb.push([btn('🚫 Nonaktifkan ' + a.name, 'adis:' + a.admin_id)]);
    }
  });
  kb.push([btn('🏠 Menu', 'menu_home')]);
  return sendTelegramMessage(chatId, text, kb);
}
async function startAddAdmin(chatId, admin) {
  if (!hasPermission(admin, 'admins.create')) return deny(chatId);
  await stateSet(chatId, { flow: 'addadmin', wait: 'phone', data: { reqId: uniqueId('NA') } });
  return sendTelegramMessage(chatId, '➕ Tambah Admin\n\n1/3 — Nomor telepon (contoh: 08121231122):', [[btn('❌ Batal', 'mcancel')]]);
}
async function adminStep(chatId, admin, st, text) {
  const d = st.data;
  if (st.wait === 'phone') {
    if (!isValidPhone(text)) return sendTelegramMessage(chatId, 'Format nomor tidak valid. Contoh: 08121231122');
    if (await getAdminByPhone(text)) return sendTelegramMessage(chatId, 'Nomor telepon ini sudah terdaftar.');
    d.phone = text;
    await stateSet(chatId, { flow: 'addadmin', wait: 'name', data: d });
    return sendTelegramMessage(chatId, '2/3 — Nama:', [[btn('❌ Batal', 'mcancel')]]);
  }
  if (st.wait === 'name') {
    if (!text) return sendTelegramMessage(chatId, 'Nama wajib diisi.');
    d.name = text;
    await stateSet(chatId, { flow: 'addadmin', wait: 'role', data: d });
    return sendTelegramMessage(chatId, '3/3 — Peran:', [
      [btn('👑 SUPER_ADMIN', 'arole:SUPER_ADMIN')],
      [btn('💼 TREASURER', 'arole:TREASURER')],
      [btn('🛠 ADMIN', 'arole:ADMIN')],
      [btn('❌ Batal', 'mcancel')]
    ]);
  }
  return sendMainMenu(chatId, admin);
}
async function adminRole(chatId, admin, role, st) {
  st.data.role = role;
  await stateSet(chatId, { flow: 'addadmin', wait: '', data: st.data });
  return sendTelegramMessage(chatId, 'Konfirmasi Admin Baru\n\nTelepon:\n' + st.data.phone
    + '\n\nNama:\n' + st.data.name
    + '\n\nPeran:\n' + role,
    [[btn('✅ Buat', 'acreate:' + st.data.reqId)], [btn('❌ Batal', 'mcancel')]]);
}
async function confirmCreateAdmin(chatId, admin, st) {
  try {
    const a = await createAdmin(admin, { phone: st.data.phone, name: st.data.name, role: st.data.role });
    await stateClear(chatId);
    await sendTelegramMessage(chatId, '✅ Admin dibuat\n\n' + a.admin_id + ' ' + a.name + ' [' + a.role + ']');
    return adminsList(chatId, admin, 1);
  } catch (e) {
    return sendTelegramMessage(chatId, '❌ Tidak dapat membuat admin.');
  }
}
async function adminDisableConfirm(chatId, admin, id) {
  if (!hasPermission(admin, 'admins.disable')) return deny(chatId);
  const a = await getAdmin(id);
  if (!a) return sendTelegramMessage(chatId, 'Tidak ditemukan.');
  if (admin.admin_id === id) return sendTelegramMessage(chatId, 'Anda tidak dapat menonaktifkan diri sendiri.');
  return sendTelegramMessage(chatId, '⚠️ Nonaktifkan admin ' + a.name + ' (' + id + ')?', [[btn('✅ Nonaktifkan', 'adis_yes:' + id)], [btn('❌ Batal', 'mcancel')]]);
}
async function doDisableAdmin(chatId, admin, id) {
  await disableAdmin(admin, id);
  await sendTelegramMessage(chatId, '✅ Admin dinonaktifkan: ' + id);
  return adminsList(chatId, admin, 1);
}

// ---- cron jobs ----
async function monthlyReminderJob() {
  if ((await getConfig('monthly_reminder_enabled')) === 'true') await remindUnpaid(currentPeriod());
}
async function dailySummaryJob() {
  if ((await getConfig('admin_daily_summary_enabled')) === 'true') await dailySummary();
}

// ---- payment gateway webhook ----
async function handlePaymentWebhook(request, env) {
  try {
    const body = await request.json();
    const eventType = body.event_type;
    const data = body.data || {};
    const paymentId = data.payment_id || '';
    const orderId = data.order_id || '';
    const status = data.status || '';
    
    if (!paymentId || !orderId) return new Response('INVALID', { status: 400 });
    
    const c = await getStoreConfig();
    const secret = await getConfig('pg_webhook_secret') || '';
    
    // Basic signature validation (expand this for production)
    if (secret && data.signature) {
      const expected = crypto.subtle ? 'TODO_IMPLEMENT_V' : '';
      // Add HMAC verification here using pg_webhook_secret
    }
    
    console.log('PG Webhook:', eventType, paymentId, orderId, status);
    
    // Map event to transaction update
    if (eventType === 'payment.completed') {
      const amount = toInt(data.amount) || 0;
      const userId = await dbGetRow('SELECT user_id FROM transactions WHERE reference = ?', ['PG:' + paymentId]);
      if (userId) {
        await writeTransaction(userId.user_id, 'CONTRIBUTION', amount, currentPeriod(), 'WEBHOOK', 'Auto-verified via ' + eventType, true);
      } else {
        await createTransaction(orderId, 'CONTRIBUTION', amount, currentPeriod(), 'WEBHOOK', 'Gateway callback: ' + eventType, null, null, null);
      }
    } else if (eventType === 'payment.failed' || eventType === 'payment.expired') {
      // Update transaction status to FAILED if exists
      await dbRun('UPDATE transactions SET status = ? WHERE reference = ?', [status, 'PG:' + paymentId]);
    }
    
    await writeAuditLog(null, 'WEBHOOK_EVENT', 'GATEWAY', 'pg_' + eventType, JSON.stringify(body), 'SUCCESS');
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.log('webhook error', e && e.stack || e);
    return new Response('ERROR', { status: 500 });
  }
}

// ---- entry ----
function isValidHook(request) {
  const hdr = request.headers.get('x-telegram-bot-api-secret-token');
  if (hdr && hdr === E.WEBHOOK_SECRET) return true;
  const u = new URL(request.url);
  return u.searchParams.get('hook') === E.WEBHOOK_SECRET;
}

export default {
  async fetch(request, env) {
    initEnv(env);
    const reqUrl = new URL(request.url);
    BASE = reqUrl.origin;
    if (request.method === 'GET') {
      if (reqUrl.pathname === '/qr') return serveQr(request);
      return new Response('Neighbourhood Bank Admin Bot OK', { status: 200 });
    }
    // Payment gateway webhook handler
    if (reqUrl.pathname.startsWith('/webhook/pg/')) {
      return handlePaymentWebhook(request, env);
    }
    if (request.method !== 'POST' || !isValidHook(request)) return new Response('NO', { status: 200 });
    CFG = null;
    let update;
    try { update = await request.json(); } catch (e) { return new Response('OK', { status: 200 }); }
    const inserted = await dbUpsertIgnore('processed_updates', { update_id: update.update_id, processed_at: nowIso() }, ['update_id']).catch(() => []);
    if (!inserted || inserted.length === 0) return new Response('OK', { status: 200 });
    await handleUpdate(update);
    return new Response('OK', { status: 200 });
  },
  async scheduled(event, env, ctx) {
    initEnv(env);
    CFG = null;
    const h = toInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    try {
      if (h === 8) await monthlyReminderJob();
      if (h === 20) await dailySummaryJob();
    } catch (err) { console.log('scheduled:', err && err.stack || err); }
  }
};
