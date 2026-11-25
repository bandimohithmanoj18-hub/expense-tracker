import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/index.mjs';
import { openDatabase, openTursoDatabase } from '../src/server/db.mjs';

async function start(db = openDatabase(':memory:')) {
  const app = createApp({ db });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return { ...app, base };
}
async function stop(app) {
  await new Promise(resolve => app.server.close(resolve));
  await app.db.close();
}
async function call(app, route, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${app.base}${route}`, { method, headers: { ...(body ? { 'content-type':'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await response.json(); } catch {}
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function register(app, email='a@example.com') {
  const result = await call(app,'/api/register',{method:'POST',body:{name:'Aanya Sharma',email,password:'StrongPass123'}});
  assert.equal(result.response.status,201,result.data.error?.message);
  return { user:result.data.user, cookie:result.cookie };
}
async function categoryId(app,cookie,name='Food & dining') {
  const {data}=await call(app,'/api/categories',{cookie});
  return data.categories.find(c=>c.name===name).id;
}
function tx(categoryId,overrides={}) {
  return {type:'expense',amount:'250.50',categoryId,description:'Lunch',purpose:'Lunch',merchant:'Cafe Green',paymentMethod:'UPI',date:new Date().toISOString().slice(0,10),notes:'',...overrides};
}

test('registers, saves transactions, computes dashboard data, and isolates accounts', async t => {
  const app=await start();t.after(()=>stop(app));
  const first=await register(app);const category=await categoryId(app,first.cookie);
  const created=await call(app,'/api/transactions',{method:'POST',cookie:first.cookie,body:tx(category)});
  assert.equal(created.response.status,201,created.data.error?.message);
  assert.equal(created.data.transaction.amount,'250.50');
  assert.equal(created.data.transaction.source,'manual');
  const list=await call(app,'/api/transactions/search',{method:'POST',cookie:first.cookie,body:{q:'Cafe'}});assert.equal(list.data.transactions.length,1);assert.equal(list.response.headers.get('cache-control'),'no-store');
  const dashboard=await call(app,'/api/dashboard',{cookie:first.cookie});assert.equal(dashboard.data.expenses,'250.50');
  const invalid=await call(app,'/api/transactions',{method:'POST',cookie:first.cookie,body:tx(category,{amount:'1.001'})});assert.equal(invalid.response.status,400);
  const second=await register(app,'b@example.com');
  const isolated=await call(app,'/api/transactions/search',{method:'POST',cookie:second.cookie,body:{q:'Cafe'}});assert.equal(isolated.data.transactions.length,0);
  const anonymous=await call(app,'/api/transactions');assert.equal(anonymous.response.status,401);
});

test('runs the account, transaction, budget, and goal flows through the Turso adapter', async t => {
  const app = await start(await openTursoDatabase({ url: 'file::memory:' }));
  t.after(() => stop(app));
  const account = await register(app, 'turso@example.com');
  const category = await categoryId(app, account.cookie);
  const created = await call(app, '/api/transactions', { method: 'POST', cookie: account.cookie, body: tx(category) });
  assert.equal(created.response.status, 201, created.data.error?.message);
  const dashboard = await call(app, '/api/dashboard', { cookie: account.cookie });
  assert.equal(dashboard.data.expenses, '250.50');
  assert.equal(Array.isArray(dashboard.data.budgets), true);
  const budget = await call(app, '/api/budgets', { method: 'POST', cookie: account.cookie, body: { name: 'Dining', amount: '500', period: 'monthly', categoryId: category } });
  assert.equal(budget.response.status, 201, budget.data.error?.message);
  const goal = await call(app, '/api/goals', { method: 'POST', cookie: account.cookie, body: { name: 'Buffer', target: '500' } });
  const contribution = await call(app, `/api/goals/${goal.data.id}/contributions`, { method: 'POST', cookie: account.cookie, body: { amount: '100' } });
  assert.equal(contribution.response.status, 201, contribution.data.error?.message);
  const goals = await call(app, '/api/goals', { cookie: account.cookie });
  assert.equal(goals.data.goals[0].current, '100.00');
  const removed = await call(app, '/api/account', { method: 'DELETE', cookie: account.cookie, body: { password: 'StrongPass123' } });
  assert.equal(removed.response.status, 200, removed.data.error?.message);
  const signedOut = await call(app, '/api/me', { cookie: account.cookie });
  assert.equal(signedOut.response.status, 401);
});

test('creates budgets, bills, goals, and handles CSV duplicate warnings', async t => {
  const app=await start();t.after(()=>stop(app));const account=await register(app),category=await categoryId(app,account.cookie);
  const transaction=tx(category);await call(app,'/api/transactions',{method:'POST',cookie:account.cookie,body:transaction});
  const budget=await call(app,'/api/budgets',{method:'POST',cookie:account.cookie,body:{name:'Dining',amount:'500',period:'monthly',categoryId:category,warnPercent:80}});assert.equal(budget.response.status,201);
  assert.equal(budget.data.budget.spent,'250.50');assert.equal(budget.data.budget.percent,50);
  const editedBudget=await call(app,`/api/budgets/${budget.data.budget.id}`,{method:'PUT',cookie:account.cookie,body:{name:'Dining and coffee',amount:'600',warnPercent:75}});assert.equal(editedBudget.data.budget.name,'Dining and coffee');
  const bill=await call(app,'/api/bills',{method:'POST',cookie:account.cookie,body:{title:'Internet',amount:'999',dueDate:new Date().toISOString().slice(0,10),recurrence:'monthly',categoryId:category}});assert.equal(bill.response.status,201);
  const paid=await call(app,`/api/bills/${bill.data.bill.id}/pay`,{method:'POST',cookie:account.cookie,body:{}});assert.equal(paid.response.status,200);
  const nextBills=await call(app,'/api/bills',{cookie:account.cookie});assert.equal(nextBills.data.bills[0].lastPaidAt,new Date().toISOString().slice(0,10));
  const goal=await call(app,'/api/goals',{method:'POST',cookie:account.cookie,body:{name:'Emergency fund',target:'2000'}});assert.equal(goal.response.status,201);
  const goalId=goal.data.id;await call(app,`/api/goals/${goalId}/contributions`,{method:'POST',cookie:account.cookie,body:{amount:'125.25',date:new Date().toISOString().slice(0,10)}});
  await call(app,`/api/goals/${goalId}`,{method:'PUT',cookie:account.cookie,body:{name:'Rainy day fund',target:'2500'}});
  const goals=await call(app,'/api/goals',{cookie:account.cookie});assert.equal(goals.data.goals[0].current,'125.25');assert.equal(goals.data.goals[0].name,'Rainy day fund');
  const imported=await call(app,'/api/import/commit',{method:'POST',cookie:account.cookie,body:{rows:[transaction]}});assert.equal(imported.data.duplicatesSkipped,1);assert.equal(imported.data.imported,0);
  const accepted=await call(app,'/api/import/commit',{method:'POST',cookie:account.cookie,body:{rows:[{...transaction,acceptDuplicate:true}]}});assert.equal(accepted.data.imported,1);
});

test('processes a due recurring transaction once and persists records and sessions across database reopen', async t => {
  const directory=await mkdtemp(path.join(tmpdir(),'spendwise-test-'));const dbPath=path.join(directory,'finance.sqlite');
  let app=await start(openDatabase(dbPath));t.after(async()=>{await stop(app);await rm(directory,{recursive:true,force:true});});const account=await register(app),category=await categoryId(app,account.cookie);
  const next=new Date(Date.now()-2*86_400_000).toISOString().slice(0,10);
  const schedule=await call(app,'/api/recurring',{method:'POST',cookie:account.cookie,body:{type:'income',amount:'50000',categoryId:category,description:'Salary',paymentMethod:'Bank transfer',frequency:'monthly',nextDate:next}});assert.equal(schedule.response.status,201,schedule.data.error?.message);
  const transactions=await call(app,'/api/transactions',{cookie:account.cookie});assert.equal(transactions.data.transactions.length,1);assert.equal(transactions.data.transactions[0].source,'recurring');assert.equal(transactions.data.transactions[0].paymentMethod,'Bank transfer');
  const edited=await call(app,`/api/recurring/${schedule.data.id}`,{method:'PUT',cookie:account.cookie,body:{description:'Monthly salary',amount:'52000',type:'income',paymentMethod:'Bank transfer',frequency:'monthly',nextDate:new Date(Date.now()+10*86_400_000).toISOString().slice(0,10)}});assert.equal(edited.response.status,200,edited.data.error?.message);
  await call(app,'/api/transactions',{cookie:account.cookie});const again=await call(app,'/api/transactions',{cookie:account.cookie});assert.equal(again.data.transactions.length,1);
  await stop(app);app=await start(openDatabase(dbPath));
  const resumed=await call(app,'/api/me',{cookie:account.cookie});assert.equal(resumed.response.status,200);assert.equal(resumed.data.user.email,'a@example.com');
  const persisted=await call(app,'/api/transactions',{cookie:account.cookie});assert.equal(persisted.data.transactions.length,1);assert.equal(persisted.data.transactions[0].description,'Salary');
});

test('serves the branded app shell and keeps settings persistent', async t => {
  const app=await start();t.after(()=>stop(app));const account=await register(app);
  const shell=await fetch(`${app.base}/`);assert.equal(shell.status,200);assert.match(await shell.text(),/SpendWise/);
  const manifestResponse=await fetch(`${app.base}/manifest.webmanifest`);assert.equal(manifestResponse.status,200);const manifest=await manifestResponse.json();assert.equal(manifest.id,'/');assert.equal(manifest.start_url,'/#/dashboard');assert.equal(manifest.display,'standalone');assert.ok(manifest.icons.some(icon=>icon.sizes==='192x192'));assert.ok(manifest.icons.some(icon=>icon.sizes==='512x512'));
  for(const [file,size] of [['spendwise-192.png',192],['spendwise-512.png',512],['apple-touch-icon.png',180]]){const icon=await fetch(`${app.base}/icons/${file}`);assert.equal(icon.status,200);assert.match(icon.headers.get('content-type'),/image\/png/);const bytes=Buffer.from(await icon.arrayBuffer());assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);}
  const serviceWorker=await fetch(`${app.base}/sw.js`);assert.equal(serviceWorker.status,200);assert.match(await serviceWorker.text(),/spendwise-shell-v3/);
  const profile=await call(app,'/api/me',{cookie:account.cookie});assert.equal(profile.response.headers.get('cache-control'),'no-store');assert.equal(profile.response.headers.get('x-frame-options'),'DENY');assert.equal(profile.response.headers.get('x-content-type-options'),'nosniff');
  const blocked=await fetch(`${app.base}/api/settings`,{method:'PUT',headers:{'content-type':'application/json',cookie:account.cookie,origin:'https://attacker.invalid'},body:JSON.stringify({theme:'olive'})});assert.equal(blocked.status,403);
  const saved=await call(app,'/api/settings',{method:'PUT',cookie:account.cookie,body:{theme:'midnight',currency:'INR',privacyMode:true,notifications:{budgets:false}}});assert.equal(saved.data.settings.theme,'midnight');assert.equal(saved.data.settings.privacyMode,true);
  const loaded=await call(app,'/api/settings',{cookie:account.cookie});assert.equal(loaded.data.settings.theme,'midnight');assert.equal(loaded.data.settings.notifications.budgets,false);
});

test('creates deduplicated bill and cash check-in notifications', async t => {
  const app=await start();t.after(()=>stop(app));const account=await register(app),category=await categoryId(app,account.cookie);
  await call(app,'/api/dashboard',{cookie:account.cookie});await call(app,'/api/dashboard',{cookie:account.cookie});
  let items=(await call(app,'/api/notifications',{cookie:account.cookie})).data.notifications;
  assert.equal(items.filter(n=>n.title==='Quick cash check-in').length,1);
  const due=new Date(Date.now()+2*86_400_000).toISOString().slice(0,10);
  await call(app,'/api/bills',{method:'POST',cookie:account.cookie,body:{title:'Water bill',amount:'200',dueDate:due,recurrence:'none',categoryId:category}});
  await call(app,'/api/bills',{cookie:account.cookie});await call(app,'/api/bills',{cookie:account.cookie});
  items=(await call(app,'/api/notifications',{cookie:account.cookie})).data.notifications;
  assert.equal(items.filter(n=>n.title==='Bill due soon').length,1);
  const settings=await call(app,'/api/settings',{method:'PUT',cookie:account.cookie,body:{theme:'olive',currency:'INR',notifications:{cash:false}}});
  assert.equal(settings.data.settings.notifications.cash,false);
});

test('requires the current password to delete an account and clears its records', async t => {
  const app=await start();t.after(()=>stop(app));const account=await register(app),category=await categoryId(app,account.cookie);
  assert.equal(app.db.prepare('PRAGMA secure_delete').get().secure_delete,1);
  await call(app,'/api/transactions',{method:'POST',cookie:account.cookie,body:tx(category)});
  const rejected=await call(app,'/api/account',{method:'DELETE',cookie:account.cookie,body:{password:'WrongPass123'}});assert.equal(rejected.response.status,401);
  const deleted=await call(app,'/api/account',{method:'DELETE',cookie:account.cookie,body:{password:'StrongPass123'}});assert.equal(deleted.response.status,200);
  const after=await call(app,'/api/me',{cookie:account.cookie});assert.equal(after.response.status,401);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM users').get().count,0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count,0);
});

test('signs in with the stored password hash and revokes a session on logout', async t => {
  const app=await start();t.after(()=>stop(app));await register(app);
  const rejected=await call(app,'/api/login',{method:'POST',body:{email:'a@example.com',password:'WrongPass123'}});assert.equal(rejected.response.status,401);
  const signedIn=await call(app,'/api/login',{method:'POST',body:{email:'a@example.com',password:'StrongPass123'}});assert.equal(signedIn.response.status,200);assert.ok(signedIn.cookie);
  const logout=await call(app,'/api/logout',{method:'POST',cookie:signedIn.cookie,body:{}});assert.equal(logout.response.status,200);
  const after=await call(app,'/api/me',{cookie:signedIn.cookie});assert.equal(after.response.status,401);
});
