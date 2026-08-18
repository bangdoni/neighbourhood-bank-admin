const fs = require('fs');
const assert = require('assert');
const path = require('path');
const vm = require('vm');

// Pure logic lives in worker.js (formatted/utils/permissions). The whole file is
// loaded minus the entry-point section (fetch/scheduled handlers) which needs env.
const src = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
const core = src.split('\n// ---- entry ----')[0];

const testCode = `
const assert = require('assert');

// --- formatting ---
assert.strictEqual(formatIDR(50000), 'Rp 50.000');
assert.strictEqual(formatIDR(12450000), 'Rp 12.450.000');
assert.strictEqual(formatIDR(50000.4), 'Rp 50.000');
assert.strictEqual(formatIDR(-5000), 'Rp -5.000');
assert.strictEqual(formatIDR(0), 'Rp 0');
assert.strictEqual(periodLabel('2026-08'), 'Agustus 2026');
assert.strictEqual(prevPeriod('2026-01'), '2025-12');
assert.strictEqual(prevPeriod('2026-08'), '2026-07');
assert.strictEqual(periodYear('2026-08'), '2026');
assert(pad(7, 4) === '0007');
assert.strictEqual(toInt('50000'), 50000);
assert.strictEqual(toInt('abc'), 0);

// --- utils validation ---
assert(isPosInt('50000'));
assert(!isPosInt('0'));
assert(!isPosInt('-50000'));
assert(!isPosInt('50,000'));
assert(!isPosInt('50a'));
assert(!isPosInt(''));
assert(isValidPeriod('2026-08'));
assert(!isValidPeriod('2026-13'));
assert(!isValidPeriod('08-2026'));
assert(isValidMemberId('NB-0001'));
assert(!isValidMemberId('NB-1'));
assert(!isValidMemberId('abc'));
assert(isValidTxId('TX-000001'));
assert(!isValidTxId('TX-1'));
assert(isValidTelegramId('123456789'));
assert(!isValidTelegramId('abc'));
assert(!isValidTelegramId('12 34'));
assert(isValidPhone('08121231122'));
assert(!isValidPhone('8121231122'));
assert(!isValidPhone('0812'));
assert(!isValidPhone('+628121231122'));
assert(!isValidPhone('abc'));
assert.strictEqual(pageSlice([1,2,3,4,5], 1, 2).length, 2);
assert.strictEqual(pageSlice([1,2,3,4,5], 3, 2)[0], 5);
assert(/^\\d{4}-\\d{2}$/.test(currentPeriod()));

// --- tz / period helpers ---
assert(/^\\d{4}-\\d{2}-\\d{2}$/.test(todayLocal()));
assert.strictEqual(periodLabel(prevPeriod(currentPeriod())) !== '', true);

// --- permissions ---
assert(hasPermission({role:'SUPER_ADMIN'}, 'settings.update'));
assert(hasPermission({role:'SUPER_ADMIN'}, 'admins.create'));
assert(hasPermission({role:'TREASURER'}, 'payments.correct'));
assert(hasPermission({role:'TREASURER'}, 'store.update'));
assert(!hasPermission({role:'TREASURER'}, 'settings.update'));
assert(!hasPermission({role:'TREASURER'}, 'admins.create'));
assert(hasPermission({role:'ADMIN'}, 'members.read'));
assert(!hasPermission({role:'ADMIN'}, 'members.create'));
assert(!hasPermission({role:'ADMIN'}, 'payments.correct'));
assert(!hasPermission(null, 'members.read'));

// --- pg adapter (postgres dialect helpers) ---
assert.strictEqual(pgq('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
assert.strictEqual(pgq('INSERT INTO t (a,b) VALUES (?, ?) ON CONFLICT (a) DO NOTHING'), 'INSERT INTO t (a,b) VALUES ($1, $2) ON CONFLICT (a) DO NOTHING');
assert.strictEqual(pgq('UPDATE t SET a = ?, b = ? WHERE c = ? RETURNING *'), 'UPDATE t SET a = $1, b = $2 WHERE c = $3 RETURNING *');
assert.strictEqual(pgq('no placeholders'), 'no placeholders');
E = { DB_USER: 'u', DB_PASSWORD: 'p', DB_HOST: 'h', DB_PORT: '5432', DB_NAME: 'd' };
assert.strictEqual(pgUrl(), 'postgres://u:p@h:5432/d');
E = {};
assert.strictEqual(pgUrl(), 'postgres://postgres:@localhost:5432/postgres');

// --- xls export ---
var xls = buildXls('Laporan 2026-08', [['ID', 'Nama'], ['NB-0001', 'Ahmad']]);
assert(xls.indexOf('<Workbook') !== -1);
assert(xls.indexOf('<Row><Cell><Data ss:Type="String">ID</Data></Cell><Cell><Data ss:Type="String">Nama</Data></Cell></Row>') !== -1);
assert(xls.indexOf('NB-0001') !== -1);
assert(buildXls('T', [['a&b<c']]).indexOf('a&amp;b&lt;c') !== -1);
assert(buildXls('T', [[1]]).indexOf('ss:Type="Number">1</Data>') !== -1);

console.log('selfcheck OK');
`;

vm.runInNewContext(core + '\n' + testCode, { console, require, Intl, Date, Promise, Math, JSON, parseInt, String, Number });
