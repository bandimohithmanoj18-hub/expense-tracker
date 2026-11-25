import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase, seedCategories } from './db.mjs';

const scrypt = promisify(scryptCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const DAY_MS = 86_400_000;
const uuid = () => randomUUID();
const nowIso = () => new Date().toISOString();
const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);
const hashToken = token => createHash('sha256').update(token).digest('hex');

class HttpError extends Error {
  constructor(status, message, code = 'request_error') { super(message); this.status = status; this.code = code; }
}

function moneyToCents(value, { allowZero = false } = {}) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw new HttpError(400, 'Enter an amount with up to two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || (!allowZero && cents <= 0)) throw new HttpError(400, allowZero ? 'Amount cannot be negative.' : 'Amount must be greater than zero.');
  return cents;
}

function centsToAmount(cents) { return (Number(cents || 0) / 100).toFixed(2); }
function validDate(value, label = 'Date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${label} must be a valid date.`);
  }
  return value;
}
function text(value, label, max = 180, required = false) {
  const clean = String(value ?? '').trim();
  if (required && !clean) throw new HttpError(400, `${label} is required.`);
  if (clean.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return clean;
}
function emailValue(value) {
  const email = text(value, 'Email', 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}
function addDays(date, days) { return utcDay(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)); }
function advanceDate(date, frequency) {
  const d = new Date(`${date}T00:00:00Z`);
  if (frequency === 'weekly') return addDays(date, 7);
  if (frequency === 'monthly') {
    const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last)); return utcDay(d);
  }
  if (frequency === 'yearly') {
    const year = d.getUTCFullYear() + 1, month = d.getUTCMonth(), day = d.getUTCDate();
    return utcDay(new Date(Date.UTC(year, month, Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()))));
  }
  return date;
}
function monthBounds(date = utcDay()) {
  const start = `${date.slice(0, 7)}-01`;
  const d = new Date(`${start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1);
  return { start, end: addDays(utcDay(d), -1) };
}
function weekStart(date = utcDay()) {
  const d = new Date(`${date}T00:00:00Z`); return addDays(date, -((d.getUTCDay() + 6) % 7));
}
function toUser(row) { return { id: row.id, email: row.email, name: row.display_name }; }
function cookieValue(req, name) {
  const parts = (req.headers.cookie || '').split(';');
  for (const part of parts) { const [key, ...rest] = part.trim().split('='); if (key === name) return rest.join('='); }
  return '';
}
function setSessionCookie(res, token, secure = false, days = 14) {
  res.setHeader('Set-Cookie', `spendwise_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${days * 86400}${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res, secure = false) {
  res.setHeader('Set-Cookie', `spendwise_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
}
function json(res, status, value) {
  if (res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); res.end(body);
}
async function readBody(req, maxBytes = 1_200_000) {
  let total = 0, chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > maxBytes) throw new HttpError(413, 'This upload is too large.'); chunks.push(chunk); }
  if (!total) return {};
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new HttpError(400, 'The request could not be read. Please check the form and try again.'); }
}
async function categoryFor(db, userId, categoryId) {
  if (categoryId == null || categoryId === '') return null;
  const row = (await (db.prepare('SELECT id FROM categories WHERE id=? AND user_id=?').get(String(categoryId), userId)));
  if (!row) throw new HttpError(400, 'Choose a category from your list.');
  return row.id;
}
function txRecord(row) {
  return { id: row.id, type: row.type, amount: centsToAmount(row.amount_cents), categoryId: row.category_id,
    category: row.category_name || 'Uncategorized', categoryColor: row.category_color || '#93948a',
    description: row.description, purpose: row.purpose, merchant: row.merchant,
    paymentMethod: row.payment_method, date: row.date, notes: row.notes, source: row.source, createdAt: row.created_at };
}
async function insertNotification(db, userId, title, message, kind = 'info', dedupeKey = null) {
  (await (db.prepare(`INSERT INTO notifications(id,user_id,title,message,kind,dedupe_key,created_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,dedupe_key) DO NOTHING`).run(uuid(), userId, title, message, kind, dedupeKey, nowIso())));
}
function periodStart(budget, today = utcDay()) { return budget.period === 'weekly' ? weekStart(today) : monthBounds(today).start; }
async function checkBudgetThresholds(db, userId, categoryId) {
  const settings = (await (db.prepare('SELECT notify_budgets FROM settings WHERE user_id=?').get(userId)));
  if (!settings?.notify_budgets) return;
  const today = utcDay();
  const budgets = (await (db.prepare('SELECT * FROM budgets WHERE user_id=? AND start_date<=?').all(userId, today)));
  for (const budget of budgets) {
    if (budget.category_id && budget.category_id !== categoryId) continue;
    const start = periodStart(budget, today);
    const total = (await (db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS total FROM transactions
      WHERE user_id=? AND type='expense' AND date>=? AND date<=? AND (? IS NULL OR category_id=?)`).get(userId, start, today, budget.category_id, budget.category_id))).total;
    const ratio = Number(total) / Number(budget.amount_cents);
    const key = `budget:${budget.id}:${start}:${ratio >= 1 ? 'over' : 'near'}`;
    if (ratio >= 1) (await (insertNotification(db, userId, 'Budget limit reached', `${budget.name} is at ${Math.round(ratio * 100)}% for this period.`, 'warning', key)));
    else if (ratio >= budget.warn_percent / 100) (await (insertNotification(db, userId, 'Budget getting close', `${budget.name} has used ${Math.round(ratio * 100)}% of its limit.`, 'warning', key)));
  }
}
async function checkUpcomingBillAlerts(db,userId) {
  const settings=(await (db.prepare('SELECT notify_bills FROM settings WHERE user_id=?').get(userId)));
  if(!settings?.notify_bills)return;
  const today=utcDay(),through=addDays(today,7);
  const bills=(await (db.prepare('SELECT id,title,due_date FROM bills WHERE user_id=? AND completed=0 AND due_date>=? AND due_date<=?').all(userId,today,through)));
  for(const bill of bills)(await (insertNotification(db,userId,'Bill due soon',`${bill.title} is due ${bill.due_date===today?'today':`on ${bill.due_date}`}.`,'warning',`bill:${bill.id}:${bill.due_date}`)));
}
async function checkCashReminder(db,userId) {
  const settings=(await (db.prepare('SELECT notify_cash FROM settings WHERE user_id=?').get(userId)));
  if(!settings?.notify_cash)return;
  const today=utcDay();
  const hasCash=(await (db.prepare("SELECT id FROM transactions WHERE user_id=? AND type='expense' AND payment_method='Cash' AND date=? LIMIT 1").get(userId,today)));
  if(!hasCash)(await (insertNotification(db,userId,'Quick cash check-in','Did you make a cash purchase today? Add it while it is fresh in your mind.','info',`cash:${today}`)));
}
async function processRecurring(db, userId) {
  const today = utcDay();
  const due = (await (db.prepare('SELECT * FROM recurring_transactions WHERE user_id=? AND active=1 AND next_date<=? ORDER BY next_date').all(userId, today)));
  const insert = db.prepare(`INSERT INTO transactions(id,user_id,type,amount_cents,category_id,description,purpose,merchant,payment_method,date,notes,source,recurrence_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'','recurring',?,?)`);
  const update = db.prepare('UPDATE recurring_transactions SET next_date=?,active=? WHERE id=? AND user_id=?');
  for (const item of due) {
    let next = item.next_date, loops = 0, active = 1;
    while (next <= today && loops < 120) {
      if (item.end_date && next > item.end_date) { active = 0; break; }
      const exists = (await (db.prepare('SELECT id FROM transactions WHERE recurrence_id=? AND date=? LIMIT 1').get(item.id, next)));
      if (!exists) {
        (await (insert.run(uuid(), userId, item.type, item.amount_cents, item.category_id, item.description, item.description, item.merchant, item.payment_method, next, item.id, nowIso())));
        if(item.type==='expense')(await (checkBudgetThresholds(db,userId,item.category_id)));
      }
      next = advanceDate(next, item.frequency); loops++;
    }
    if (loops >= 120 && next <= today) active = 0;
    if (item.end_date && next > item.end_date) active = 0;
    (await (update.run(next, active, item.id, userId)));
  }
}
async function userSettings(db, userId) {
  const row = (await (db.prepare('SELECT * FROM settings WHERE user_id=?').get(userId)));
  return { theme: row.theme, currency: row.currency, dateFormat: row.date_format, privacyMode: !!row.privacy_mode,
    notifications: { budgets: !!row.notify_budgets, bills: !!row.notify_bills, goals: !!row.notify_goals, cash: !!row.notify_cash }, motion: !!row.motion };
}
async function validateTransaction(db, userId, body, previous = {}) {
  const type = body.type ?? previous.type;
  if (!['expense', 'income'].includes(type)) throw new HttpError(400, 'Choose expense or income.');
  const amount = moneyToCents(body.amount ?? centsToAmount(previous.amount_cents));
  const categoryId = (await (categoryFor(db, userId, body.categoryId ?? previous.category_id)));
  const description = text(body.description ?? body.purpose ?? previous.description, 'Purpose', 120, true);
  const purpose = text(body.purpose ?? previous.purpose ?? description, 'Purpose', 180);
  const merchant = text(body.merchant ?? previous.merchant, 'Merchant', 100);
  const method = text(body.paymentMethod ?? previous.payment_method ?? 'Cash', 'Payment method', 32, true);
  if (!['Cash', 'UPI', 'Card', 'Bank transfer', 'Wallet', 'Other'].includes(method)) throw new HttpError(400, 'Choose a valid payment method.');
  const date = validDate(body.date ?? previous.date ?? utcDay());
  const notes = text(body.notes ?? previous.notes, 'Notes', 500);
  return { type, amount, categoryId, description, purpose, merchant, method, date, notes };
}
function budgetStartFor(period, requested) {
  const date = validDate(requested || utcDay(), 'Budget start date');
  return period === 'weekly' ? weekStart(date) : monthBounds(date).start;
}
async function formatBudget(db, userId, row, today = utcDay()) {
  const start = periodStart(row, today);
  const spent = (await (db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS total FROM transactions
    WHERE user_id=? AND type='expense' AND date>=? AND date<=? AND (? IS NULL OR category_id=?)`).get(userId, start, today, row.category_id, row.category_id))).total;
  const cat = row.category_id ? (await (db.prepare('SELECT name,color FROM categories WHERE id=? AND user_id=?').get(row.category_id, userId))) : null;
  return { id: row.id, name: row.name, amount: centsToAmount(row.amount_cents), spent: centsToAmount(spent),
    remaining: centsToAmount(Math.max(0, row.amount_cents - spent)), percent: Math.min(999, Math.round(spent / row.amount_cents * 100)),
    categoryId: row.category_id, category: cat?.name || 'All categories', color: cat?.color || '#c2a46d',
    period: row.period, startDate: row.start_date, warnPercent: row.warn_percent };
}
async function sqlTransactionList(db, userId, filters = {}) {
  let sql = `SELECT t.*,c.name AS category_name,c.color AS category_color FROM transactions t
    LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=?`;
  const args = [userId];
  if (filters.type && ['expense','income'].includes(filters.type)) { sql += ' AND t.type=?'; args.push(filters.type); }
  if (filters.categoryId) { sql += ' AND t.category_id=?'; args.push(filters.categoryId); }
  if (filters.from) { sql += ' AND t.date>=?'; args.push(validDate(filters.from, 'From date')); }
  if (filters.to) { sql += ' AND t.date<=?'; args.push(validDate(filters.to, 'To date')); }
  if (filters.q) { sql += ' AND (t.description LIKE ? OR t.purpose LIKE ? OR t.merchant LIKE ? OR c.name LIKE ?)'; const q = `%${String(filters.q).slice(0, 100)}%`; args.push(q,q,q,q); }
  const order = { newest: 't.date DESC,t.created_at DESC', oldest: 't.date ASC,t.created_at ASC', amount_desc: 't.amount_cents DESC,t.date DESC', amount_asc: 't.amount_cents ASC,t.date DESC' }[filters.sort] || 't.date DESC,t.created_at DESC';
  sql += ` ORDER BY ${order} LIMIT 1000`;
  return (await (db.prepare(sql).all(...args))).map(txRecord);
}
async function dashboardData(db, userId) {
  (await (processRecurring(db, userId)));
  const { start, end } = monthBounds();
  const aggregate = (await (db.prepare(`SELECT type,COALESCE(SUM(amount_cents),0) AS total FROM transactions WHERE user_id=? AND date>=? AND date<=? GROUP BY type`).all(userId,start,end)));
  const sums = Object.fromEntries(aggregate.map(row => [row.type, Number(row.total)]));
  const all = (await (db.prepare(`SELECT type,COALESCE(SUM(amount_cents),0) AS total FROM transactions WHERE user_id=? GROUP BY type`).all(userId)));
  const balance = all.reduce((sum,row)=>sum + (row.type === 'income' ? Number(row.total) : -Number(row.total)),0);
  const budgets = await Promise.all((await db.prepare('SELECT * FROM budgets WHERE user_id=? ORDER BY start_date DESC').all(userId)).map(b => formatBudget(db, userId, b)));
  const recent = (await (sqlTransactionList(db,userId))).slice(0,7);
  const through = addDays(utcDay(),30);
  const bills = (await (db.prepare('SELECT b.*,c.name AS category FROM bills b LEFT JOIN categories c ON c.id=b.category_id WHERE b.user_id=? AND b.completed=0 AND b.due_date<=? ORDER BY b.due_date LIMIT 8').all(userId,through))).map(b=>({id:b.id,title:b.title,amount:centsToAmount(b.amount_cents),dueDate:b.due_date,recurrence:b.recurrence,category:b.category||'Bills',notes:b.notes}));
  const goals = (await (db.prepare('SELECT * FROM goals WHERE user_id=? ORDER BY created_at DESC LIMIT 5').all(userId))).map(g=>({id:g.id,name:g.name,target:centsToAmount(g.target_cents),current:centsToAmount(g.current_cents),percent:Math.min(100,Math.round(g.current_cents/g.target_cents*100)),targetDate:g.target_date,description:g.description}));
  const priorMonth = monthBounds(addDays(start,-1));
  const dayOfMonth=Number(utcDay().slice(-2));
  const priorMonthLastDay=Number(priorMonth.end.slice(-2));
  const prior={...priorMonth,end:`${priorMonth.end.slice(0,8)}${String(Math.min(dayOfMonth,priorMonthLastDay)).padStart(2,'0')}`};
  const currentByCat = (await (db.prepare(`SELECT c.name,COALESCE(SUM(t.amount_cents),0) AS total FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=? AND t.type='expense' AND t.date>=? AND t.date<=? GROUP BY t.category_id ORDER BY total DESC LIMIT 1`).get(userId,start,end)));
  const insights = [];
  const currentExpense = sums.expense || 0, priorExpense = Number((await (db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS total FROM transactions WHERE user_id=? AND type='expense' AND date>=? AND date<=?").get(userId,prior.start,prior.end))).total);
  if (currentExpense && currentByCat) insights.push({kind:'category',title:'Your biggest category',text:`${currentByCat.name || 'Uncategorized'} is your largest recorded expense category this month.`});
  if (priorExpense && currentExpense > priorExpense * 1.15) insights.push({kind:'trend',title:'Spending is up',text:`Recorded expenses are ${Math.round((currentExpense/priorExpense-1)*100)}% above last month so far.`});
  else if (priorExpense && currentExpense < priorExpense * 0.85) insights.push({kind:'trend',title:'Spending is lower',text:`Recorded expenses are ${Math.round((1-currentExpense/priorExpense)*100)}% below last month so far.`});
  const close = budgets.find(b=>b.percent>=b.warnPercent);
  if (close) insights.push({kind:'budget',title:'Budget getting close',text:`${close.name} has used ${close.percent}% of its current limit.`});
  if (bills.length) insights.push({kind:'bill',title:'Upcoming commitments',text:`${bills.length} bill${bills.length===1?' is':'s are'} due within the next 30 days.`});
  if (!currentExpense && !priorExpense) insights.push({kind:'empty',title:'Your spending pulse is warming up',text:'Add a few transactions to see useful patterns based on your own records.'});
  const unread = (await (db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read_at IS NULL').get(userId))).count;
  return {period:{start,end},income:centsToAmount(sums.income||0),expenses:centsToAmount(currentExpense),net:centsToAmount((sums.income||0)-currentExpense),balance:centsToAmount(balance),budgets,recent,bills,goals,insights,unread};
}
async function analyticsData(db,userId,range='month') {
  (await (processRecurring(db,userId)));
  const today=utcDay(); let from;
  if(range==='year') from=`${today.slice(0,4)}-01-01`;
  else if(range==='all') from='0001-01-01';
  else from=monthBounds(addDays(monthBounds().start,-1)).start;
  const rows=(await (db.prepare(`SELECT t.*,c.name AS category_name,c.color AS category_color FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=? AND t.date>=? AND t.date<=? ORDER BY t.date`).all(userId,from,today)));
  const categories=new Map(), months=new Map(), daily=new Map();
  for(const r of rows){
    if(r.type==='expense'){
      const k=r.category_name||'Uncategorized';const item=categories.get(k)||{name:k,color:r.category_color||'#93948a',total:0};item.total+=r.amount_cents;categories.set(k,item);
    }
    const m=r.date.slice(0,7);const mo=months.get(m)||{month:m,income:0,expenses:0};mo[r.type==='income'?'income':'expenses']+=r.amount_cents;months.set(m,mo);
    if(r.type==='expense'){const d=daily.get(r.date)||{date:r.date,amount:0};d.amount+=r.amount_cents;daily.set(r.date,d);}
  }
  const allExpense=rows.filter(r=>r.type==='expense').reduce((s,r)=>s+r.amount_cents,0);
  const expenseDays=new Set(rows.filter(r=>r.type==='expense').map(r=>r.date)).size;
  const average=expenseDays?allExpense/expenseDays:0;
  const sortedCats=[...categories.values()].sort((a,b)=>b.total-a.total).map(x=>({...x,amount:centsToAmount(x.total)}));
  return {range,from,to:today,months:[...months.values()].sort((a,b)=>a.month.localeCompare(b.month)).slice(-12).map(x=>({month:x.month,income:centsToAmount(x.income),expenses:centsToAmount(x.expenses)})),
    categories:sortedCats.map(({name,color,amount})=>({name,color,amount})),daily:[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-31).map(x=>({date:x.date,amount:centsToAmount(x.amount)})),
    averageDaily:centsToAmount(average),transactionCount:rows.length,expenseTotal:centsToAmount(allExpense),hasData:rows.length>0};
}
async function replayData(db,userId,month) {
  (await (processRecurring(db,userId)));
  const start=validDate(`${month}-01`,'Month');const end=monthBounds(start).end;
  const rows=(await (db.prepare(`SELECT t.*,c.name AS category_name,c.color AS category_color FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=? AND t.date>=? AND t.date<=? ORDER BY t.date,t.created_at`).all(userId,start,end)));
  let running=0,income=0,expenses=0;
  const events=rows.map(r=>{const amount=Number(r.amount_cents);if(r.type==='income'){income+=amount;running+=amount;}else{expenses+=amount;running-=amount;}return {...txRecord(r),runningBalance:centsToAmount(running)};});
  const goals=(await (db.prepare('SELECT name,current_cents,target_cents FROM goals WHERE user_id=?').all(userId))).map(g=>({name:g.name,current:centsToAmount(g.current_cents),target:centsToAmount(g.target_cents)}));
  return {month,start,end,events,income:centsToAmount(income),expenses:centsToAmount(expenses),net:centsToAmount(income-expenses),endingRecordedBalance:centsToAmount(running),goals};
}

export function createApp({ db = openDatabase(), publicDir = ROOT, sessionDays = 14 } = {}) {
  const loginAttempts = new Map();
  const secureCookie = process.env.NODE_ENV === 'production';
  let lastSessionCleanup = 0;
  async function pruneExpiredSessions() {
    const now = Date.now();
    if (now - lastSessionCleanup < 60 * 60 * 1000) return;
    (await (db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString())));
    lastSessionCleanup = now;
  }
  async function inTransaction(callback) {
    if (typeof db.transaction === 'function') return db.transaction(callback);
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function checkOrigin(req) {
    const origin=req.headers.origin;
    if(!origin)return;
    let parsed;try{parsed=new URL(origin);}catch{throw new HttpError(403,'This request was blocked.');}
    if(parsed.host!==req.headers.host || !['http:','https:'].includes(parsed.protocol)) throw new HttpError(403,'This request was blocked.');
  }
  async function createAccount(req,res,body) {
    checkOrigin(req);
    const email=emailValue(body.email);const name=text(body.name,'Name',80,true);
    const password=String(body.password||'');
    if(password.length<10 || password.length>128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) throw new HttpError(400,'Use at least 10 characters with a lowercase letter, uppercase letter, and number.');
    if((await (db.prepare('SELECT id FROM users WHERE email=?').get(email))))throw new HttpError(409,'An account with this email already exists.');
    const userId=uuid(),now=nowIso(),salt=randomBytes(16),derived=await scrypt(password,salt,64);
    const passwordHash=`scrypt$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
    const token=randomBytes(32).toString('base64url');
    await inTransaction(async tx => {
      await tx.prepare('INSERT INTO users(id,email,display_name,password_hash,created_at) VALUES(?,?,?,?,?)').run(userId,email,name,passwordHash,now);
      await seedCategories(tx,userId,now);
      await tx.prepare('INSERT INTO settings(user_id,updated_at) VALUES(?,?)').run(userId,now);
      await tx.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token),userId,new Date(Date.now()+sessionDays*DAY_MS).toISOString(),now);
    });
    setSessionCookie(res,token,secureCookie,sessionDays);
    return {user:toUser(await db.prepare('SELECT * FROM users WHERE id=?').get(userId)),settings:await userSettings(db,userId)};
  }
  async function login(req,res,body) {
    checkOrigin(req);
    const key=req.socket.remoteAddress||'unknown',now=Date.now();
    const attempt=loginAttempts.get(key)||{count:0,resetAt:now+900_000};
    if(attempt.resetAt<now){attempt.count=0;attempt.resetAt=now+900_000;}
    if(attempt.count>=12)throw new HttpError(429,'Too many sign-in attempts. Try again in a few minutes.');
    const email=emailValue(body.email),password=String(body.password||'');
    const user=(await (db.prepare('SELECT * FROM users WHERE email=?').get(email)));
    let matched=false;
    if(user){
      const [,saltHex,hashHex]=user.password_hash.split('$');const derived=Buffer.from(await scrypt(password,Buffer.from(saltHex,'hex'),64));const expected=Buffer.from(hashHex,'hex');matched=derived.length===expected.length&&timingSafeEqual(derived,expected);
    }
    if(!matched){attempt.count++;loginAttempts.set(key,attempt);throw new HttpError(401,'Email or password did not match.');}
    loginAttempts.delete(key);
    const token=randomBytes(32).toString('base64url'),nowIsoValue=nowIso();
    (await (db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token),user.id,new Date(Date.now()+sessionDays*DAY_MS).toISOString(),nowIsoValue)));
    setSessionCookie(res,token,secureCookie,sessionDays);return {user:toUser(user),settings:(await (userSettings(db,user.id)))};
  }
  async function route(req,res) {
    await pruneExpiredSessions();
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    const url=new URL(req.url,'http://localhost'),pathname=decodeURIComponent(url.pathname);
    if(pathname.startsWith('/api/')){
      const body=['POST','PUT','PATCH','DELETE'].includes(req.method)?await readBody(req):{};
      if(req.method==='POST'&&pathname==='/api/register')return json(res,201,await createAccount(req,res,body));
      if(req.method==='POST'&&pathname==='/api/login')return json(res,200,await login(req,res,body));
      if(req.method==='POST'&&pathname==='/api/logout'){
        checkOrigin(req);const token=cookieValue(req,'spendwise_session');if(token)(await (db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token))));clearSessionCookie(res,secureCookie);return json(res,200,{ok:true});
      }
      const token=cookieValue(req,'spendwise_session');
      const session=token?(await (db.prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?').get(hashToken(token)))):null;
      if(!session||session.expires_at<=nowIso()){if(session)(await (db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token))));throw new HttpError(401,'Please sign in to continue.','unauthorized');}
      const userId=session.user_id;
      if(['POST','PUT','PATCH','DELETE'].includes(req.method))checkOrigin(req);
      const segments=pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const resource=segments[1],id=segments[2],action=segments[3];
      if(req.method==='GET'&&pathname==='/api/me')return json(res,200,{user:toUser((await (db.prepare('SELECT * FROM users WHERE id=?').get(userId)))),settings:(await (userSettings(db,userId)))});
      if(req.method==='GET'&&resource==='categories')return json(res,200,{categories:(await (db.prepare('SELECT id,name,color,icon FROM categories WHERE user_id=? ORDER BY name COLLATE NOCASE').all(userId)))});
      if(req.method==='POST'&&resource==='categories'){
        const name=text(body.name,'Category name',40,true),color=text(body.color||'#8a9467','Color',7,true),icon=text(body.icon||'circle','Icon',32,true);
        if(!/^#[0-9a-fA-F]{6}$/.test(color))throw new HttpError(400,'Choose a valid color.');
        const cid=uuid();try{(await (db.prepare('INSERT INTO categories(id,user_id,name,color,icon,created_at) VALUES(?,?,?,?,?,?)').run(cid,userId,name,color,icon,nowIso())));}catch(e){if(String(e).includes('UNIQUE'))throw new HttpError(409,'That category name is already in use.');throw e;}
        return json(res,201,{category:{id:cid,name,color,icon}});
      }
      if(['PUT','PATCH'].includes(req.method)&&resource==='categories'&&id){
        const old=(await (db.prepare('SELECT * FROM categories WHERE id=? AND user_id=?').get(id,userId)));if(!old)throw new HttpError(404,'Category not found.');
        const name=text(body.name??old.name,'Category name',40,true),color=text(body.color??old.color,'Color',7,true),icon=text(body.icon??old.icon,'Icon',32,true);if(!/^#[0-9a-fA-F]{6}$/.test(color))throw new HttpError(400,'Choose a valid color.');
        try{(await (db.prepare('UPDATE categories SET name=?,color=?,icon=? WHERE id=? AND user_id=?').run(name,color,icon,id,userId)));}catch(e){if(String(e).includes('UNIQUE'))throw new HttpError(409,'That category name is already in use.');throw e;}
        return json(res,200,{category:{id,name,color,icon}});
      }
      if(req.method==='DELETE'&&resource==='categories'&&id){const old=(await (db.prepare('SELECT id FROM categories WHERE id=? AND user_id=?').get(id,userId)));if(!old)throw new HttpError(404,'Category not found.');(await (db.prepare('DELETE FROM categories WHERE id=? AND user_id=?').run(id,userId)));return json(res,200,{ok:true});}
      if(req.method==='POST'&&pathname==='/api/transactions/search'){
        const stringValue=value=>typeof value==='string'?value:'';
        const filters={type:stringValue(body.type),categoryId:stringValue(body.categoryId),from:stringValue(body.from),to:stringValue(body.to),q:stringValue(body.q).slice(0,100),sort:stringValue(body.sort)};
        (await (processRecurring(db,userId)));return json(res,200,{transactions:(await (sqlTransactionList(db,userId,filters)))});
      }
      if(req.method==='GET'&&resource==='transactions'){
        (await (processRecurring(db,userId)));const filters={type:url.searchParams.get('type'),categoryId:url.searchParams.get('categoryId'),from:url.searchParams.get('from'),to:url.searchParams.get('to'),sort:url.searchParams.get('sort')};return json(res,200,{transactions:(await (sqlTransactionList(db,userId,filters)))});
      }
      if(req.method==='POST'&&resource==='transactions'){
        const v=(await (validateTransaction(db,userId,body)));const tid=uuid();(await (db.prepare(`INSERT INTO transactions(id,user_id,type,amount_cents,category_id,description,purpose,merchant,payment_method,date,notes,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?)`).run(tid,userId,v.type,v.amount,v.categoryId,v.description,v.purpose,v.merchant,v.method,v.date,v.notes,text(body.source||'manual','Source',20),nowIso())));
        if(v.type==='expense')(await (checkBudgetThresholds(db,userId,v.categoryId)));
        return json(res,201,{transaction:(await (sqlTransactionList(db,userId))).find(t=>t.id===tid)});
      }
      if(['PUT','PATCH'].includes(req.method)&&resource==='transactions'&&id){
        const old=(await (db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(id,userId)));if(!old)throw new HttpError(404,'Transaction not found.');const v=(await (validateTransaction(db,userId,body,old)));
        (await (db.prepare(`UPDATE transactions SET type=?,amount_cents=?,category_id=?,description=?,purpose=?,merchant=?,payment_method=?,date=?,notes=? WHERE id=? AND user_id=?`).run(v.type,v.amount,v.categoryId,v.description,v.purpose,v.merchant,v.method,v.date,v.notes,id,userId)));if(v.type==='expense')(await (checkBudgetThresholds(db,userId,v.categoryId)));return json(res,200,{transaction:(await (sqlTransactionList(db,userId))).find(t=>t.id===id)});
      }
      if(req.method==='DELETE'&&resource==='transactions'&&id){const result=(await (db.prepare('DELETE FROM transactions WHERE id=? AND user_id=?').run(id,userId)));if(!result.changes)throw new HttpError(404,'Transaction not found.');return json(res,200,{ok:true});}
      if(req.method==='POST'&&resource==='import'&&id==='commit'){
        if(!Array.isArray(body.rows)||body.rows.length>1000)throw new HttpError(400,'Choose a CSV with up to 1,000 rows.');
        const existing=(await (db.prepare('SELECT type,amount_cents,date,merchant,description,payment_method FROM transactions WHERE user_id=?').all(userId)));
        const inserted=[];let duplicates=0,invalid=0;
        for(const row of body.rows){try{
          const v=(await (validateTransaction(db,userId,row)));const match=existing.some(x=>x.type===v.type&&x.amount_cents===v.amount&&x.date===v.date&&String(x.merchant||'').toLowerCase()===v.merchant.toLowerCase()&&String(x.description||'').toLowerCase()===v.description.toLowerCase()&&x.payment_method===v.method);
          if(match&&!row.acceptDuplicate){duplicates++;continue;}
          const tid=uuid();(await (db.prepare(`INSERT INTO transactions(id,user_id,type,amount_cents,category_id,description,purpose,merchant,payment_method,date,notes,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'csv',?)`).run(tid,userId,v.type,v.amount,v.categoryId,v.description,v.purpose,v.merchant,v.method,v.date,v.notes,nowIso())));inserted.push(tid);existing.push({type:v.type,amount_cents:v.amount,date:v.date,merchant:v.merchant,description:v.description,payment_method:v.method});
        }catch{invalid++;}}
        return json(res,200,{imported:inserted.length,duplicatesSkipped:duplicates,invalidRows:invalid});
      }
      if(req.method==='GET'&&pathname==='/api/dashboard'){(await (checkUpcomingBillAlerts(db,userId)));(await (checkCashReminder(db,userId)));return json(res,200,(await (dashboardData(db,userId))));}
      if(req.method==='GET'&&pathname==='/api/analytics')return json(res,200,(await (analyticsData(db,userId,url.searchParams.get('range')||'month'))));
      if(req.method==='GET'&&pathname==='/api/replay')return json(res,200,(await (replayData(db,userId,url.searchParams.get('month')||utcDay().slice(0,7)))));
      if(req.method==='GET'&&resource==='budgets')return json(res,200,{budgets:await Promise.all((await db.prepare('SELECT * FROM budgets WHERE user_id=? ORDER BY start_date DESC').all(userId)).map(b => formatBudget(db,userId,b)))});
      if(req.method==='POST'&&resource==='budgets'){
        const name=text(body.name,'Budget name',80,true),amount=moneyToCents(body.amount),period=body.period||'monthly';if(!['monthly','weekly'].includes(period))throw new HttpError(400,'Choose a weekly or monthly budget.');
        const categoryId=(await (categoryFor(db,userId,body.categoryId))),startDate=budgetStartFor(period,body.startDate),warn=Number(body.warnPercent??80);if(!Number.isInteger(warn)||warn<1||warn>99)throw new HttpError(400,'Set the alert threshold between 1 and 99 percent.');
        const bid=uuid();(await (db.prepare('INSERT INTO budgets(id,user_id,category_id,name,amount_cents,period,start_date,warn_percent,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(bid,userId,categoryId,name,amount,period,startDate,warn,nowIso())));(await (checkBudgetThresholds(db,userId,categoryId)));return json(res,201,{budget:(await (formatBudget(db,userId,(await (db.prepare('SELECT * FROM budgets WHERE id=?').get(bid))))))});
      }
      if(['PUT','PATCH'].includes(req.method)&&resource==='budgets'&&id){const old=(await (db.prepare('SELECT * FROM budgets WHERE id=? AND user_id=?').get(id,userId)));if(!old)throw new HttpError(404,'Budget not found.');const name=text(body.name??old.name,'Budget name',80,true),amount=body.amount===undefined?old.amount_cents:moneyToCents(body.amount),period=body.period??old.period;if(!['monthly','weekly'].includes(period))throw new HttpError(400,'Choose a weekly or monthly budget.');const categoryId=body.categoryId===undefined?old.category_id:(await (categoryFor(db,userId,body.categoryId))),start=body.startDate?budgetStartFor(period,body.startDate):old.start_date,warn=Number(body.warnPercent??old.warn_percent);if(!Number.isInteger(warn)||warn<1||warn>99)throw new HttpError(400,'Set the alert threshold between 1 and 99 percent.');(await (db.prepare('UPDATE budgets SET name=?,amount_cents=?,period=?,category_id=?,start_date=?,warn_percent=? WHERE id=? AND user_id=?').run(name,amount,period,categoryId,start,warn,id,userId)));return json(res,200,{budget:(await (formatBudget(db,userId,(await (db.prepare('SELECT * FROM budgets WHERE id=?').get(id))))))});}
      if(req.method==='DELETE'&&resource==='budgets'&&id){const out=(await (db.prepare('DELETE FROM budgets WHERE id=? AND user_id=?').run(id,userId)));if(!out.changes)throw new HttpError(404,'Budget not found.');return json(res,200,{ok:true});}
      if(req.method==='GET'&&resource==='bills'){
        (await (checkUpcomingBillAlerts(db,userId)));
        const bills=(await (db.prepare('SELECT b.*,c.name AS category FROM bills b LEFT JOIN categories c ON c.id=b.category_id WHERE b.user_id=? ORDER BY b.completed,b.due_date').all(userId))).map(b=>({id:b.id,title:b.title,amount:centsToAmount(b.amount_cents),dueDate:b.due_date,recurrence:b.recurrence,categoryId:b.category_id,category:b.category||'Bills',notes:b.notes,completed:!!b.completed,lastPaidAt:b.last_paid_at}));return json(res,200,{bills});
      }
      if(req.method==='POST'&&resource==='bills'&&!id){
        const title=text(body.title,'Bill name',100,true),amount=moneyToCents(body.amount,{allowZero:true}),due=validDate(body.dueDate,'Due date'),recurrence=body.recurrence||'none';if(!['none','weekly','monthly','yearly'].includes(recurrence))throw new HttpError(400,'Choose a supported reminder frequency.');const categoryId=(await (categoryFor(db,userId,body.categoryId))),notes=text(body.notes,'Notes',500),bid=uuid();(await (db.prepare('INSERT INTO bills(id,user_id,title,amount_cents,due_date,recurrence,category_id,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(bid,userId,title,amount,due,recurrence,categoryId,notes,nowIso())));return json(res,201,{bill:{id:bid,title,amount:centsToAmount(amount),dueDate:due,recurrence,categoryId,notes,completed:false}});
      }
      if(['PUT','PATCH'].includes(req.method)&&resource==='bills'&&id){const old=(await (db.prepare('SELECT * FROM bills WHERE id=? AND user_id=?').get(id,userId)));if(!old)throw new HttpError(404,'Bill not found.');const title=text(body.title??old.title,'Bill name',100,true),amount=body.amount===undefined?old.amount_cents:moneyToCents(body.amount,{allowZero:true}),due=validDate(body.dueDate??old.due_date,'Due date'),recurrence=body.recurrence??old.recurrence;if(!['none','weekly','monthly','yearly'].includes(recurrence))throw new HttpError(400,'Choose a supported reminder frequency.');const categoryId=body.categoryId===undefined?old.category_id:(await (categoryFor(db,userId,body.categoryId))),notes=text(body.notes??old.notes,'Notes',500);(await (db.prepare('UPDATE bills SET title=?,amount_cents=?,due_date=?,recurrence=?,category_id=?,notes=? WHERE id=? AND user_id=?').run(title,amount,due,recurrence,categoryId,notes,id,userId)));return json(res,200,{ok:true});}
      if(req.method==='POST'&&resource==='bills'&&id&&action==='pay'){const old=(await (db.prepare('SELECT * FROM bills WHERE id=? AND user_id=?').get(id,userId)));if(!old)throw new HttpError(404,'Bill not found.');const paid=utcDay();if(old.recurrence==='none')(await (db.prepare('UPDATE bills SET completed=1,last_paid_at=? WHERE id=? AND user_id=?').run(paid,id,userId)));else{let next=advanceDate(old.due_date,old.recurrence),count=0;while(next<=paid&&count<120){next=advanceDate(next,old.recurrence);count++;}(await (db.prepare('UPDATE bills SET due_date=?,completed=0,last_paid_at=? WHERE id=? AND user_id=?').run(next,paid,id,userId)));}(await (insertNotification(db,userId,'Bill marked paid',`${old.title} has been marked as paid.`,'success',null)));return json(res,200,{ok:true});}
      if(req.method==='DELETE'&&resource==='bills'&&id){const out=(await (db.prepare('DELETE FROM bills WHERE id=? AND user_id=?').run(id,userId)));if(!out.changes)throw new HttpError(404,'Bill not found.');return json(res,200,{ok:true});}
      if(req.method==='GET'&&resource==='recurring'){
        (await (processRecurring(db,userId)));const items=(await (db.prepare('SELECT r.*,c.name AS category FROM recurring_transactions r LEFT JOIN categories c ON c.id=r.category_id WHERE r.user_id=? ORDER BY r.active DESC,r.next_date').all(userId))).map(r=>({id:r.id,type:r.type,amount:centsToAmount(r.amount_cents),categoryId:r.category_id,category:r.category||'Uncategorized',description:r.description,merchant:r.merchant,paymentMethod:r.payment_method,frequency:r.frequency,nextDate:r.next_date,endDate:r.end_date,active:!!r.active}));return json(res,200,{recurring:items});
      }
      if(req.method==='POST'&&resource==='recurring'){
        const type=body.type||'expense';if(!['expense','income'].includes(type))throw new HttpError(400,'Choose income or expense.');const amount=moneyToCents(body.amount),categoryId=(await (categoryFor(db,userId,body.categoryId))),description=text(body.description,'Purpose',120,true),merchant=text(body.merchant,'Merchant',100),method=text(body.paymentMethod||'Cash','Payment method',32,true),frequency=body.frequency||'monthly';if(!['weekly','monthly','yearly'].includes(frequency))throw new HttpError(400,'Choose a supported recurrence.');const next=validDate(body.nextDate,'Next date'),end=body.endDate?validDate(body.endDate,'End date'):null;if(end&&end<next)throw new HttpError(400,'End date must be on or after the next date.');if(!['Cash','UPI','Card','Bank transfer','Wallet','Other'].includes(method))throw new HttpError(400,'Choose a valid payment method.');const rid=uuid();(await (db.prepare('INSERT INTO recurring_transactions(id,user_id,type,amount_cents,category_id,description,merchant,payment_method,frequency,next_date,end_date,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,userId,type,amount,categoryId,description,merchant,method,frequency,next,end,nowIso())));return json(res,201,{id:rid});
      }
      if(req.method==='PUT'&&resource==='recurring'&&id){const old=(await (db.prepare('SELECT * FROM recurring_transactions WHERE id=? AND user_id=?').get(id,userId)));if(!old)throw new HttpError(404,'Recurring transaction not found.');const type=body.type??old.type;if(!['expense','income'].includes(type))throw new HttpError(400,'Choose income or expense.');const amount=body.amount===undefined?old.amount_cents:moneyToCents(body.amount),categoryId=body.categoryId===undefined?old.category_id:(await (categoryFor(db,userId,body.categoryId))),description=text(body.description??old.description,'Purpose',120,true),merchant=text(body.merchant??old.merchant,'Merchant',100),method=text(body.paymentMethod??old.payment_method,'Payment method',32,true),frequency=body.frequency??old.frequency;if(!['weekly','monthly','yearly'].includes(frequency))throw new HttpError(400,'Choose a supported recurrence.');const next=validDate(body.nextDate??old.next_date,'Next date'),end=body.endDate===undefined?old.end_date:(body.endDate?validDate(body.endDate,'End date'):null);if(end&&end<next)throw new HttpError(400,'End date must be on or after the next date.');if(!['Cash','UPI','Card','Bank transfer','Wallet','Other'].includes(method))throw new HttpError(400,'Choose a valid payment method.');(await (db.prepare('UPDATE recurring_transactions SET type=?,amount_cents=?,category_id=?,description=?,merchant=?,payment_method=?,frequency=?,next_date=?,end_date=? WHERE id=? AND user_id=?').run(type,amount,categoryId,description,merchant,method,frequency,next,end,id,userId)));return json(res,200,{ok:true});}
      if(req.method==='PATCH'&&resource==='recurring'&&id){const old=(await (db.prepare('SELECT * FROM recurring_transactions WHERE id=? AND user_id=?').get(id,userId)));if(!old)throw new HttpError(404,'Recurring transaction not found.');const active=body.active===undefined?old.active:(body.active?1:0);(await (db.prepare('UPDATE recurring_transactions SET active=? WHERE id=? AND user_id=?').run(active,id,userId)));return json(res,200,{ok:true});}
      if(req.method==='DELETE'&&resource==='recurring'&&id){const out=(await (db.prepare('DELETE FROM recurring_transactions WHERE id=? AND user_id=?').run(id,userId)));if(!out.changes)throw new HttpError(404,'Recurring transaction not found.');return json(res,200,{ok:true});}
      if(req.method==='GET'&&resource==='goals'){
        const goals=await Promise.all((await db.prepare('SELECT * FROM goals WHERE user_id=? ORDER BY created_at DESC').all(userId)).map(async g=>({id:g.id,name:g.name,target:centsToAmount(g.target_cents),current:centsToAmount(g.current_cents),percent:Math.min(100,Math.round(g.current_cents/g.target_cents*100)),targetDate:g.target_date,description:g.description,contributions:(await db.prepare('SELECT id,amount_cents AS cents,date,note FROM contributions WHERE goal_id=? ORDER BY date DESC LIMIT 8').all(g.id)).map(c=>({id:c.id,amount:centsToAmount(c.cents),date:c.date,note:c.note}))})));return json(res,200,{goals});
      }
      if(req.method==='POST'&&resource==='goals'&&!id){
        const name=text(body.name,'Goal name',80,true),target=moneyToCents(body.target),targetDate=body.targetDate?validDate(body.targetDate,'Target date'):null,description=text(body.description,'Description',300),gid=uuid();(await (db.prepare('INSERT INTO goals(id,user_id,name,target_cents,target_date,description,created_at) VALUES(?,?,?,?,?,?,?)').run(gid,userId,name,target,targetDate,description,nowIso())));return json(res,201,{id:gid});
      }
      if(['PUT','PATCH'].includes(req.method)&&resource==='goals'&&id){const old=(await (db.prepare('SELECT * FROM goals WHERE id=? AND user_id=?').get(id,userId)));if(!old)throw new HttpError(404,'Goal not found.');const name=text(body.name??old.name,'Goal name',80,true),target=body.target===undefined?old.target_cents:moneyToCents(body.target),targetDate=body.targetDate===undefined?old.target_date:(body.targetDate?validDate(body.targetDate,'Target date'):null),description=text(body.description??old.description,'Description',300);(await (db.prepare('UPDATE goals SET name=?,target_cents=?,target_date=?,description=? WHERE id=? AND user_id=?').run(name,target,targetDate,description,id,userId)));return json(res,200,{ok:true});}
      if(req.method==='POST'&&resource==='goals'&&id&&action==='contributions'){
        const goal=(await (db.prepare('SELECT * FROM goals WHERE id=? AND user_id=?').get(id,userId)));if(!goal)throw new HttpError(404,'Goal not found.');const amount=moneyToCents(body.amount),date=validDate(body.date||utcDay(),'Contribution date'),note=text(body.note,'Note',200),cid=uuid();await inTransaction(async tx=>{await tx.prepare('INSERT INTO contributions(id,goal_id,amount_cents,date,note) VALUES(?,?,?,?,?)').run(cid,id,amount,date,note);await tx.prepare('UPDATE goals SET current_cents=current_cents+? WHERE id=? AND user_id=?').run(amount,id,userId);});const updated=(await (db.prepare('SELECT current_cents,target_cents FROM goals WHERE id=?').get(id)));if(updated.current_cents>=updated.target_cents)(await (insertNotification(db,userId,'Savings goal reached',`You reached ${goal.name}.`,'success',`goal:${id}:complete`)));return json(res,201,{ok:true});
      }
      if(req.method==='DELETE'&&resource==='goals'&&id){const out=(await (db.prepare('DELETE FROM goals WHERE id=? AND user_id=?').run(id,userId)));if(!out.changes)throw new HttpError(404,'Goal not found.');return json(res,200,{ok:true});}
      if(req.method==='GET'&&resource==='notifications')return json(res,200,{notifications:(await (db.prepare('SELECT id,title,message,kind,read_at AS readAt,created_at AS createdAt FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId)))});
      if(req.method==='POST'&&resource==='notifications'&&id==='read-all'){(await (db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(nowIso(),userId)));return json(res,200,{ok:true});}
      if(req.method==='POST'&&resource==='notifications'&&id&&action==='read'){const out=(await (db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(nowIso(),id,userId)));if(!out.changes)throw new HttpError(404,'Notification not found.');return json(res,200,{ok:true});}
      if(req.method==='DELETE'&&resource==='notifications'&&id){const out=(await (db.prepare('DELETE FROM notifications WHERE id=? AND user_id=?').run(id,userId)));if(!out.changes)throw new HttpError(404,'Notification not found.');return json(res,200,{ok:true});}
      if(req.method==='GET'&&resource==='settings')return json(res,200,{settings:(await (userSettings(db,userId)))});
      if(req.method==='PUT'&&resource==='settings'){
        const theme=body.theme||'olive';if(!['olive','charcoal','midnight'].includes(theme))throw new HttpError(400,'Choose one of the available themes.');const currency=text(body.currency||'INR','Currency',3,true).toUpperCase();if(!/^[A-Z]{3}$/.test(currency))throw new HttpError(400,'Currency must be a three-letter code.');const dateFormat=body.dateFormat||'DD MMM YYYY';if(!['DD MMM YYYY','YYYY-MM-DD','DD/MM/YYYY'].includes(dateFormat))throw new HttpError(400,'Choose a supported date format.');const privacy=body.privacyMode?1:0,notifications=body.notifications||{};(await (db.prepare(`UPDATE settings SET theme=?,currency=?,date_format=?,privacy_mode=?,notify_budgets=?,notify_bills=?,notify_goals=?,notify_cash=?,motion=?,updated_at=? WHERE user_id=?`).run(theme,currency,dateFormat,privacy,notifications.budgets===false?0:1,notifications.bills===false?0:1,notifications.goals===false?0:1,notifications.cash===false?0:1,body.motion===false?0:1,nowIso(),userId)));return json(res,200,{settings:(await (userSettings(db,userId)))});
      }
      if(req.method==='GET'&&pathname==='/api/export'){
        return json(res,200,{exportedAt:nowIso(),user:toUser((await (db.prepare('SELECT * FROM users WHERE id=?').get(userId)))),settings:(await (userSettings(db,userId))),categories:(await (db.prepare('SELECT name,color,icon FROM categories WHERE user_id=?').all(userId))),transactions:(await (db.prepare('SELECT type,amount_cents,category_id,description,purpose,merchant,payment_method,date,notes,source,created_at FROM transactions WHERE user_id=? ORDER BY date').all(userId))).map(r=>({...r,amount:centsToAmount(r.amount_cents)})),budgets:(await (db.prepare('SELECT name,amount_cents,period,start_date,warn_percent FROM budgets WHERE user_id=?').all(userId))).map(r=>({...r,amount:centsToAmount(r.amount_cents)})),bills:(await (db.prepare('SELECT title,amount_cents,due_date,recurrence,notes,completed,last_paid_at FROM bills WHERE user_id=?').all(userId))).map(r=>({...r,amount:centsToAmount(r.amount_cents)})),goals:(await (db.prepare('SELECT name,target_cents,current_cents,target_date,description FROM goals WHERE user_id=?').all(userId))).map(r=>({...r,target:centsToAmount(r.target_cents),current:centsToAmount(r.current_cents)}))});
      }
      if(req.method==='PUT'&&resource==='account'&&id==='password'){
        const oldPassword=String(body.currentPassword||''),newPassword=String(body.newPassword||'');const user=(await (db.prepare('SELECT * FROM users WHERE id=?').get(userId)));const [,saltHex,hashHex]=user.password_hash.split('$');const derived=Buffer.from(await scrypt(oldPassword,Buffer.from(saltHex,'hex'),64));if(!timingSafeEqual(derived,Buffer.from(hashHex,'hex')))throw new HttpError(401,'Current password did not match.');if(newPassword.length<10||newPassword.length>128||!/[a-z]/.test(newPassword)||!/[A-Z]/.test(newPassword)||!/\d/.test(newPassword))throw new HttpError(400,'Use at least 10 characters with a lowercase letter, uppercase letter, and number.');const salt=randomBytes(16),hash=Buffer.from(await scrypt(newPassword,salt,64));(await (db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(`scrypt$${salt.toString('hex')}$${hash.toString('hex')}`,userId)));(await (db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId,hashToken(cookieValue(req,'spendwise_session')))));return json(res,200,{ok:true});
      }
      if(req.method==='DELETE'&&pathname==='/api/account'){
        const pass=String(body.password||''),user=(await (db.prepare('SELECT * FROM users WHERE id=?').get(userId)));const [,saltHex,hashHex]=user.password_hash.split('$');const derived=Buffer.from(await scrypt(pass,Buffer.from(saltHex,'hex'),64));if(!timingSafeEqual(derived,Buffer.from(hashHex,'hex')))throw new HttpError(401,'Password did not match.');(await (db.prepare('DELETE FROM users WHERE id=?').run(userId)));if(!db.isTurso)try{db.exec('PRAGMA wal_checkpoint(TRUNCATE);')}catch{}clearSessionCookie(res,secureCookie);return json(res,200,{ok:true});
      }
      throw new HttpError(404,'That page or action was not found.','not_found');
    }
    if(req.method!=='GET'&&req.method!=='HEAD')throw new HttpError(404,'Page not found.','not_found');
    let file=path.resolve(publicDir,`.${pathname}`);const publicRoot=path.resolve(publicDir);
    if(file!==publicRoot&&!file.startsWith(publicRoot+path.sep))throw new HttpError(404,'Page not found.','not_found');
    try{const info=await stat(file);if(info.isDirectory())file=path.join(file,'index.html');await stat(file);}catch{file=path.join(publicRoot,'index.html');}
    const ext=path.extname(file).toLowerCase();const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.png':'image/png'};
    const payload=await readFile(file);res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Content-Length':payload.length,'Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'});if(req.method==='HEAD')res.end();else res.end(payload);
  }
  const handle=(req,res)=>route(req,res).catch(error=>{
    if(error instanceof HttpError)return json(res,error.status,{error:{code:error.code,message:error.message}});
    if(String(error?.message||'').includes('UNIQUE constraint failed'))return json(res,409,{error:{code:'conflict',message:'That record already exists.'}});
    console.error('SpendWise request failed:',error?.name||'Error',error?.code||'internal_error');return json(res,500,{error:{code:'internal_error',message:'Something went wrong. Please try again.'}});
  });
  const server=createServer(handle);
  return {server,db,handle};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const {server}=createApp();const port=Number(process.env.PORT||4173);const host=process.env.HOST||'127.0.0.1';
  server.listen(port,host,()=>console.log(`SpendWise is ready at http://${host}:${port}`));
}
