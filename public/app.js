const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { user: null, settings: null, categories: [], page: 'dashboard', txPage: 1, txFilters: {}, importRows: [], importHeaders: [] };
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
});
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; });
const pages = {
  dashboard: ['Overview', 'A quiet view of where you are.'], transactions: ['Transactions', 'Every rupee, thoughtfully accounted for.'],
  budgets: ['Budgets', 'Give every part of your money a plan.'], bills: ['Bills & reminders', 'Know what is coming, before it arrives.'],
  recurring: ['Recurring payments', 'Stay ahead of regular money in and out.'], goals: ['Savings goals', 'Make room for the things that matter.'],
  analytics: ['Analytics', 'Patterns drawn from your own records.'], replay: ['Financial replay', 'Walk back through your month, one moment at a time.'],
  import: ['Import transactions', 'Bring in a statement CSV and review it before saving.'], settings: ['Settings', 'Shape SpendWise around the way you manage money.']
};
const navCommands = Object.keys(pages).map(id => ({ id, label: pages[id][0], hint: 'Open page' }));

function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function money(value, { hide = false } = {}) {
  if (hide || state.settings?.privacyMode) return '••••';
  const amount = Number(value || 0);
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: state.settings?.currency || 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0);
}
function dateLabel(value, opts = {}) {
  if (!value) return '—';
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const format = state.settings?.dateFormat || 'DD MMM YYYY';
  return new Intl.DateTimeFormat('en-IN', format === 'YYYY-MM-DD' ? { year:'numeric',month:'2-digit',day:'2-digit', ...opts } : format === 'DD/MM/YYYY' ? { day:'2-digit',month:'2-digit',year:'numeric', ...opts } : { day:'numeric',month:'short',year:'numeric', ...opts }).format(date);
}
function monthText(value = new Date().toISOString().slice(0, 7)) { return new Intl.DateTimeFormat('en-IN',{month:'long',year:'numeric'}).format(new Date(`${value}-01T00:00:00`)); }
function num(value) { return Number(value || 0); }
function amountInput(value) { return value == null ? '' : Number(value).toFixed(2); }
function localToday() { const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function toast(message, kind = 'success') {
  const node = document.createElement('div'); node.className = `toast toast-${kind}`; node.setAttribute('role','status'); node.textContent = message;
  $('#toast-region').append(node); setTimeout(() => { node.classList.add('toast-out'); setTimeout(() => node.remove(), 250); }, 3400);
}
async function api(url, options = {}) {
  const response = await fetch(url, { credentials:'same-origin', ...options, headers:{ ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(options.headers || {}) }, body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    if (response.status === 401 && state.user) { state.user = null; showAuth(); }
    throw new Error(data?.error?.message || 'Something went wrong. Please try again.');
  }
  return data;
}
function showAuth() {
  $('#app-shell').hidden = true; $('#auth-screen').hidden = false;
  $('#auth-form').reset(); $('#auth-error').textContent = '';
  document.title = 'SpendWise | Sign in';
}
function showApp() {
  $('#auth-screen').hidden = true; $('#app-shell').hidden = false;
  $('#profile-name').textContent = state.user.name; $('#profile-email').textContent = state.user.email;
  $('#profile-avatar').textContent = (state.user.name || 'S').trim().charAt(0).toUpperCase();
  applyTheme();
}
function applyTheme() {
  document.body.dataset.theme = state.settings?.theme || 'olive';
  document.body.classList.toggle('reduced-motion', state.settings?.motion === false);
  $('#app-shell').classList.toggle('privacy-on', !!state.settings?.privacyMode);
  document.documentElement.style.colorScheme = state.settings?.theme === 'olive' ? 'dark' : 'dark';
  const themeColors={olive:'#11120f',charcoal:'#191a1d',midnight:'#090b12'};
  $('meta[name="theme-color"]').content=themeColors[state.settings?.theme]||themeColors.olive;
}
async function boot() {
  try {
    const current = await api('/api/me'); state.user = current.user; state.settings = current.settings;
    const cats = await api('/api/categories'); state.categories = cats.categories;
    showApp(); if (!location.hash) location.hash = '#/dashboard'; await renderRoute();
  } catch { showAuth(); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function categoryOptions(selected = '') {
  return `<option value="">${selected === '' ? 'Choose a category' : 'Uncategorized'}</option>` + state.categories.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === selected ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}
function pageHeader(title, subtitle, actions = '') { return `<div class="page-heading"><div><div class="eyebrow">SPENDWISE / ${escapeHtml(title.toUpperCase())}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div><div class="heading-actions">${actions}</div></div>`; }
function button(label, action, cls = 'button button-secondary', extra = '') { return `<button type="button" class="${cls}" data-action="${action}" ${extra}>${label}</button>`; }
function emptyState(icon, title, body, action = '', label = '') { return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">${icon}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p>${action ? `<button class="button button-secondary" type="button" data-action="${action}">${escapeHtml(label)}</button>` : ''}</div>`; }
function amountClass(type) { return type === 'income' ? 'amount-positive' : 'amount-negative'; }
function txRow(t, compact = false) {
  const icon = t.type === 'income' ? '↙' : (t.category || '?').charAt(0).toUpperCase();
  return `<div class="transaction-row ${compact ? 'transaction-row-compact' : ''}">
    <span class="category-mark" style="--category-color:${escapeHtml(t.categoryColor || '#8a9467')}">${escapeHtml(icon)}</span>
    <div class="transaction-main"><strong>${escapeHtml(t.merchant || t.description || t.purpose)}</strong><span>${escapeHtml(t.category)} <i>·</i> ${escapeHtml(t.paymentMethod)}${t.source === 'recurring' ? ' · Recurring' : ''}</span></div>
    <time datetime="${escapeHtml(t.date)}">${dateLabel(t.date, { year:undefined })}</time>
    <strong class="transaction-amount ${amountClass(t.type)} money-value">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</strong>
    ${compact ? '' : `<span class="row-actions"><button class="text-button" data-action="edit-tx" data-id="${escapeHtml(t.id)}" aria-label="Edit transaction">Edit</button><button class="text-button text-danger" data-action="delete-tx" data-id="${escapeHtml(t.id)}" aria-label="Delete transaction">Delete</button></span>`}
  </div>`;
}
function trendSvg(months) {
  const width=680,height=220,pad=26;const vals=months.flatMap(m=>[num(m.income),num(m.expenses)]);const max=Math.max(1,...vals)*1.15;
  const px=i=>pad+(months.length<=1?0:i*(width-pad*2)/(months.length-1));const py=v=>height-pad-(v/max)*(height-pad*2);
  const line=key=>months.map((m,i)=>`${i?'L':'M'} ${px(i).toFixed(1)} ${py(num(m[key])).toFixed(1)}`).join(' ');
  const labels=months.map((m,i)=>`<text x="${px(i)}" y="${height-3}" text-anchor="middle">${escapeHtml(new Intl.DateTimeFormat('en-IN',{month:'short'}).format(new Date(`${m.month}-01T00:00:00`)))}</text>`).join('');
  return `<svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Income and expense trend over recent months"><line class="chart-grid" x1="${pad}" y1="${py(max*.75)}" x2="${width-pad}" y2="${py(max*.75)}"/><line class="chart-grid" x1="${pad}" y1="${py(max*.4)}" x2="${width-pad}" y2="${py(max*.4)}"/><path class="chart-line chart-income" d="${line('income')}"/><path class="chart-line chart-expense" d="${line('expenses')}"/>${months.map((m,i)=>`<circle class="chart-dot chart-dot-income" cx="${px(i)}" cy="${py(num(m.income))}" r="3.5"><title>${escapeHtml(m.month)} income ${money(m.income)}</title></circle><circle class="chart-dot chart-dot-expense" cx="${px(i)}" cy="${py(num(m.expenses))}" r="3.5"><title>${escapeHtml(m.month)} expenses ${money(m.expenses)}</title></circle>`).join('')}${labels}</svg>`;
}
function categoryBars(categories, maxItems = 5) {
  if (!categories.length) return emptyState('◌','Nothing to chart yet','Record a few expenses and your category mix will appear here.');
  const max=Math.max(...categories.slice(0,maxItems).map(c=>num(c.amount)),1);
  return `<div class="category-bars">${categories.slice(0,maxItems).map(c=>`<div class="category-bar-row"><div class="bar-label"><span><i style="--category-color:${escapeHtml(c.color)}"></i>${escapeHtml(c.name)}</span><strong class="money-value">${money(c.amount)}</strong></div><div class="bar-track"><span style="--bar-width:${Math.max(3,num(c.amount)/max*100)}%;--category-color:${escapeHtml(c.color)}"></span></div></div>`).join('')}</div>`;
}
function budgetCard(b) {
  const status=b.percent>=100?'over':b.percent>=b.warnPercent?'near':'normal';
  return `<article class="budget-card"><div class="budget-card-top"><div><span class="eyebrow">${escapeHtml(b.period.toUpperCase())} PLAN</span><h3>${escapeHtml(b.name)}</h3><span class="muted-copy">${escapeHtml(b.category)}</span></div><div class="budget-actions"><button class="icon-button quiet-button" data-action="edit-budget" data-id="${escapeHtml(b.id)}" aria-label="Edit budget">✎</button><button class="icon-button quiet-button" data-action="delete-budget" data-id="${escapeHtml(b.id)}" aria-label="Delete budget">×</button></div></div><div class="budget-values"><strong class="money-value">${money(b.spent)}</strong><span>of <b class="money-value">${money(b.amount)}</b></span><span class="budget-percent ${status}">${b.percent}%</span></div><div class="progress-track ${status}"><span style="--progress:${Math.min(100,b.percent)}%"></span></div><div class="budget-bottom"><span>${b.percent>=100?'Limit exceeded':`${money(b.remaining)} remaining`}</span><span>Alert at ${b.warnPercent}%</span></div></article>`;
}
async function renderRoute() {
  if (!state.user) return;
  const requested = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  if (requested === 'not-found' || !pages[requested]) { renderNotFound(); return; }
  state.page=requested; $('#page-crumb').textContent=pages[requested][0]; document.title=`SpendWise | ${pages[requested][0]}`;
  $$('[data-page]').forEach(a=>{const active=a.dataset.page===requested;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  $('#mobile-more').classList.toggle('active',!['dashboard','transactions','budgets'].includes(requested));
  closeMobileNav(); const content=$('#page-content');content.setAttribute('aria-busy','true');
  if(!content.innerHTML.trim())content.innerHTML='<div class="page-loading"><span></span><span></span><span></span></div>';
  try {
    const content=await pageContent(requested); if(state.page!==requested)return;
    setPageContent(content);
  } catch(error) { if(state.page!==requested)return;setPageContent(`${pageHeader(pages[requested][0],'')}<div class="error-panel"><span>!</span><strong>We could not load this view.</strong><p>${escapeHtml(error.message)}</p><button class="button button-secondary" data-action="retry-page">Try again</button></div>`); }
}
function setPageContent(html) {
  const target=$('#page-content'),update=()=>{target.innerHTML=html;target.removeAttribute('aria-busy');};
  const motionAllowed=state.settings?.motion!==false&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(typeof document.startViewTransition==='function'&&motionAllowed&&target.children.length){
    try{document.startViewTransition(update).finished.catch(()=>{});return;}catch{}
  }
  update();
}
function renderNotFound() {
  state.page='not-found';$('#page-crumb').textContent='Not found';document.title='SpendWise | Page not found';
  setPageContent(`<div class="not-found"><span class="eyebrow">PAGE NOT FOUND</span><div class="not-found-number">404</div><h1>This page wandered off.</h1><p>Let’s take you back to your financial overview.</p><a href="#/dashboard" class="button button-primary">Back to overview</a></div>`);
}
async function pageContent(page) {
  if(page==='dashboard')return dashboardPage(await api('/api/dashboard'));
  if(page==='transactions')return transactionsPage(await api('/api/transactions/search',{method:'POST',body:state.txFilters}));
  if(page==='budgets')return budgetsPage(await api('/api/budgets'));
  if(page==='bills')return billsPage(await api('/api/bills'));
  if(page==='recurring')return recurringPage(await api('/api/recurring'));
  if(page==='goals')return goalsPage(await api('/api/goals'));
  if(page==='analytics')return analyticsPage(await api(`/api/analytics?range=${state.analyticsRange||'month'}`));
  if(page==='replay')return replayPage(await api(`/api/replay?month=${state.replayMonth||localToday().slice(0,7)}`));
  if(page==='import')return importPage();
  if(page==='settings')return settingsPage();
  return '';
}
function dashboardPage(data) {
  const monthLabel=monthText(data.period.start.slice(0,7));
  $('#notification-dot').hidden=!(data.unread>0);
  const budget=data.budgets[0];
  return `${pageHeader('Overview',`Your financial picture for ${monthLabel}.`,`${button('<span>＋</span> Add transaction','quick-add','button button-primary')} ${button('◉ Hide amounts','privacy-toggle','button button-quiet')}`)}
    <section class="welcome-strip"><div><span class="eyebrow">YOUR RECORDED POSITION</span><h2>A little more clarity, <em>every day.</em></h2><p>Here’s what your records say for ${escapeHtml(monthLabel)}.</p></div><div class="welcome-mark" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div></section>
    <section class="summary-grid" aria-label="Financial summary">
      <article class="summary-card summary-balance"><div class="summary-label">Recorded balance <span class="info-dot" title="Income minus expenses you have recorded, across all time.">i</span></div><strong class="summary-number money-value">${money(data.balance)}</strong><span class="summary-foot"><i class="status-dot"></i> Based on your saved transactions</span><span class="card-watermark">↗</span></article>
      <article class="summary-card"><div class="summary-label">Income <span class="period-tag">THIS MONTH</span></div><strong class="summary-number money-value">${money(data.income)}</strong><span class="summary-foot">Recorded income</span><span class="summary-icon income-icon">↙</span></article>
      <article class="summary-card"><div class="summary-label">Expenses <span class="period-tag">THIS MONTH</span></div><strong class="summary-number money-value">${money(data.expenses)}</strong><span class="summary-foot">Recorded outflow</span><span class="summary-icon expense-icon">↗</span></article>
      <article class="summary-card"><div class="summary-label">Net savings <span class="period-tag">THIS MONTH</span></div><strong class="summary-number money-value">${money(data.net)}</strong><span class="summary-foot">Income less expenses</span><span class="summary-icon savings-icon">◎</span></article>
    </section>
    <div class="dashboard-grid">
      <section class="panel trend-panel"><div class="panel-heading"><div><span class="eyebrow">MONEY IN / OUT</span><h2>Your money flow</h2></div><a href="#/analytics" class="quiet-link">See analytics <span>↗</span></a></div>
        <div class="flow-summary"><div><span class="flow-swatch income-swatch"></span><span>Income</span><strong class="money-value">${money(data.income)}</strong></div><span class="flow-arrow">→</span><div><span class="flow-swatch expense-swatch"></span><span>Expenses</span><strong class="money-value">${money(data.expenses)}</strong></div><span class="flow-arrow">→</span><div><span class="flow-swatch savings-swatch"></span><span>Net</span><strong class="money-value">${money(data.net)}</strong></div></div>
        ${data.budgets.length?`<div class="dashboard-budget-focus"><div><span class="eyebrow">BUDGET PULSE</span><strong>${escapeHtml(budget?.name||'Your budgets')}</strong></div><span>${budget?`${budget.percent}% used · ${money(budget.remaining)} left`:'Set up your first budget'}</span>${budget?`<div class="progress-track ${budget.percent>=budget.warnPercent?'near':''}"><span style="--progress:${Math.min(100,budget.percent)}%"></span></div>`:''}</div>`:''}
      </section>
      <section class="panel pulse-panel"><div class="panel-heading"><div><span class="eyebrow">SPENDING PULSE</span><h2>At a glance</h2></div><span class="pulse-orbit">◉</span></div><div class="pulse-total"><strong class="money-value">${money(data.expenses)}</strong><span>spent this month</span></div><div class="pulse-meter"><span class="pulse-meter-track"><i style="--meter:${Math.min(100, (num(data.expenses)/(num(data.income)||1))*100)}%"></i></span><span>${num(data.income)>0?`${Math.round(num(data.expenses)/num(data.income)*100)}% of recorded income`:'Add income to compare'}</span></div><a href="#/analytics" class="quiet-link">Explore your spending <span>→</span></a></section>
      <section class="panel transactions-panel"><div class="panel-heading"><div><span class="eyebrow">LATEST ACTIVITY</span><h2>Recent transactions</h2></div><a href="#/transactions" class="quiet-link">View all <span>↗</span></a></div>${data.recent.length?`<div class="transaction-list">${data.recent.slice(0,5).map(t=>txRow(t,true)).join('')}</div>`:emptyState('↕','No transactions yet','Record your first expense or income to start seeing your money clearly.','quick-add','Add a transaction')}</section>
      <section class="panel commitments-panel"><div class="panel-heading"><div><span class="eyebrow">LOOKING AHEAD</span><h2>Upcoming bills</h2></div><a href="#/bills" class="quiet-link">All bills <span>↗</span></a></div>${data.bills.length?`<div class="bill-list">${data.bills.slice(0,4).map(billRow).join('')}</div>`:emptyState('▤','Nothing due soon','Add a bill reminder and it will appear here.','new-bill','Add a reminder')}</section>
      <section class="panel goals-panel"><div class="panel-heading"><div><span class="eyebrow">YOUR FUTURE PLANS</span><h2>Savings goals</h2></div><a href="#/goals" class="quiet-link">All goals <span>↗</span></a></div>${data.goals.length?`<div class="goal-list">${data.goals.slice(0,3).map(goalRow).join('')}</div>`:emptyState('◎','Give a goal a name','Save toward a trip, a new laptop, or whatever matters to you.','new-goal','Create a goal')}</section>
      <section class="insights-panel"><div class="panel-heading"><div><span class="eyebrow">A NOTE FROM YOUR NUMBERS</span><h2>Financial insights</h2></div><span class="insight-spark">✳</span></div><div class="insight-list">${data.insights.length?data.insights.map((i,n)=>`<div class="insight-item"><span class="insight-index">0${n+1}</span><div><strong>${escapeHtml(i.title)}</strong><p>${escapeHtml(i.text)}</p></div></div>`).join(''):emptyState('✳','More history, better insight','Your observations will grow as you add more financial records.')}</div></section>
    </div><p class="recorded-note">Recorded balance is calculated from transactions saved in SpendWise. It is not a bank balance.</p>`;
}
function billRow(b) { const days=Math.ceil((Date.parse(`${b.dueDate}T00:00:00Z`)-Date.parse(`${localToday()}T00:00:00Z`))/86400000);return `<div class="bill-row"><span class="bill-date"><strong>${new Date(`${b.dueDate}T00:00:00`).getDate()}</strong><small>${new Intl.DateTimeFormat('en-IN',{month:'short'}).format(new Date(`${b.dueDate}T00:00:00`))}</small></span><span class="bill-copy"><strong>${escapeHtml(b.title)}</strong><small>${days<0?'Overdue':days===0?'Due today':`In ${days} days`} · ${escapeHtml(b.recurrence==='none'?'One time':b.recurrence)}</small></span><strong class="bill-amount money-value">${money(b.amount)}</strong></div>`; }
function goalRow(g) { return `<div class="goal-row"><div class="goal-row-top"><span class="goal-glyph">◎</span><span class="goal-name"><strong>${escapeHtml(g.name)}</strong><small>${g.targetDate?`Target ${dateLabel(g.targetDate)}`:'No target date'}</small></span><strong class="goal-percent">${g.percent}%</strong></div><div class="progress-track"><span style="--progress:${g.percent}%"></span></div><div class="goal-row-foot"><span class="money-value">${money(g.current)} saved</span><span class="money-value">${money(g.target)} goal</span></div></div>`; }

async function transactionsPage(data) {
  const all=data.transactions;const perPage=20;const pagesCount=Math.max(1,Math.ceil(all.length/perPage));state.txPage=Math.min(state.txPage,pagesCount);const visible=all.slice((state.txPage-1)*perPage,state.txPage*perPage);
  return `${pageHeader('Transactions','Your complete record of money in and out.',button('<span>＋</span> Add transaction','quick-add','button button-primary'))}
    <section class="panel transactions-page-panel"><div class="filter-bar"><label class="search-field"><span>⌕</span><input id="tx-search" type="search" value="${escapeHtml(state.txFilters.q||'')}" placeholder="Search merchant or purpose" aria-label="Search transactions"></label><select id="tx-type" aria-label="Transaction type"><option value="">All activity</option><option value="expense" ${state.txFilters.type==='expense'?'selected':''}>Expenses</option><option value="income" ${state.txFilters.type==='income'?'selected':''}>Income</option></select><select id="tx-category" aria-label="Filter by category"><option value="">All categories</option>${state.categories.map(c=>`<option value="${escapeHtml(c.id)}" ${state.txFilters.categoryId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select><select id="tx-sort" aria-label="Sort transactions"><option value="newest">Newest first</option><option value="oldest" ${state.txFilters.sort==='oldest'?'selected':''}>Oldest first</option><option value="amount_desc" ${state.txFilters.sort==='amount_desc'?'selected':''}>Highest amount</option><option value="amount_asc" ${state.txFilters.sort==='amount_asc'?'selected':''}>Lowest amount</option></select><button class="button button-quiet" type="button" data-action="export-transactions">Export CSV</button></div>
      <div class="date-filter-row"><label>From <input id="tx-from" type="date" value="${escapeHtml(state.txFilters.from||'')}"></label><label>To <input id="tx-to" type="date" value="${escapeHtml(state.txFilters.to||'')}"></label><span class="result-count">${all.length} record${all.length===1?'':'s'}</span></div>
      ${visible.length?`<div class="transaction-list transaction-list-table">${visible.map(t=>txRow(t)).join('')}</div><div class="pagination"><span>Showing ${all.length?((state.txPage-1)*perPage+1):0}–${Math.min(all.length,state.txPage*perPage)} of ${all.length}</span><div><button class="icon-button" data-action="tx-page" data-step="-1" ${state.txPage<=1?'disabled':''} aria-label="Previous page">‹</button><span>${state.txPage} / ${pagesCount}</span><button class="icon-button" data-action="tx-page" data-step="1" ${state.txPage>=pagesCount?'disabled':''} aria-label="Next page">›</button></div></div>`:emptyState('↕','No matching transactions','Try adjusting your filters or record a transaction.','quick-add','Add a transaction')}
    </section>`;
}
function budgetsPage(data) {
  const active=data.budgets;
  return `${pageHeader('Budgets','Set a limit that feels supportive, not restrictive.',button('<span>＋</span> New budget','new-budget','button button-primary'))}<div class="budget-intro"><span class="budget-orbit">◴</span><p>A budget is a guide. SpendWise tracks activity from the start of each current week or month, using only transactions you have recorded.</p></div>${active.length?`<div class="budget-grid">${active.map(budgetCard).join('')}</div>`:emptyState('◴','Start with one simple budget','Pick an amount for a category or for all of your spending.','new-budget','Create your first budget')}`;
}
function billsPage(data) {
  const bills=data.bills;
  return `${pageHeader('Bills & reminders','A gentle nudge for the dates you do not want to miss.',button('<span>＋</span> Add reminder','new-bill','button button-primary'))}<div class="calendar-strip"><div class="calendar-heading"><span class="eyebrow">YOUR COMMITMENTS</span><h2>${monthText()}</h2></div><p>Upcoming bill dates are listed in order. Mark a recurring bill paid to move its next due date forward.</p></div>${bills.length?`<section class="panel bill-page-list"><div class="panel-heading"><div><span class="eyebrow">BILL CALENDAR</span><h2>All reminders</h2></div><span class="count-pill">${bills.filter(b=>!b.completed).length} open</span></div><div class="bill-list bill-list-full">${bills.map(b=>`${billRow(b)}<span class="bill-actions">${b.completed?'<span class="paid-label">Paid</span>':`<button class="text-button" data-action="pay-bill" data-id="${escapeHtml(b.id)}">${b.recurrence==='none'?'Mark paid':'Paid · advance'}</button>`}<button class="text-button" data-action="edit-bill" data-id="${escapeHtml(b.id)}">Edit</button><button class="text-button text-danger" data-action="delete-bill" data-id="${escapeHtml(b.id)}">Delete</button></span>`).join('')}</div></section>`:emptyState('▤','No reminders on the calendar','Add rent, a utility bill, or a payment you want to keep in view.','new-bill','Add a bill reminder')}`;
}
function recurringPage(data) {
  return `${pageHeader('Recurring payments','A schedule for regular income and expenses.',button('<span>＋</span> Add recurring','new-recurring','button button-primary'))}<div class="info-banner"><span>⟳</span><p>When a scheduled transaction is due, SpendWise records it once the app is opened and updates its next date. Review your schedule to keep entries current.</p></div>${data.recurring.length?`<section class="panel"><div class="recurring-list">${data.recurring.map(r=>`<div class="recurring-row"><span class="recurring-icon ${r.type==='income'?'income':''}">⟳</span><div class="recurring-copy"><strong>${escapeHtml(r.description)}</strong><span>${escapeHtml(r.category)} · ${escapeHtml(r.frequency)} · Next ${dateLabel(r.nextDate)}</span></div><strong class="money-value ${amountClass(r.type)}">${r.type==='income'?'+':'−'}${money(r.amount)}</strong><span class="recurring-state ${r.active?'':'paused'}">${r.active?'Active':'Paused'}</span><div class="row-actions"><button class="text-button" data-action="edit-recurring" data-id="${escapeHtml(r.id)}">Edit</button><button class="text-button" data-action="toggle-recurring" data-id="${escapeHtml(r.id)}" data-active="${r.active}">${r.active?'Pause':'Resume'}</button><button class="text-button text-danger" data-action="delete-recurring" data-id="${escapeHtml(r.id)}">Delete</button></div></div>`).join('')}</div></section>`:emptyState('⟳','Set a schedule once','Add salary, rent, or a subscription and let SpendWise keep the next date in view.','new-recurring','Create a recurring entry')}`;
}
function goalsPage(data) {
  return `${pageHeader('Savings goals','Put a little aside for something you are looking forward to.',button('<span>＋</span> New goal','new-goal','button button-primary'))}${data.goals.length?`<div class="goal-grid">${data.goals.map(g=>`<article class="goal-card"><div class="goal-card-head"><span class="goal-large-glyph">◎</span><div class="budget-actions"><button class="icon-button" data-action="edit-goal" data-id="${escapeHtml(g.id)}" aria-label="Edit goal">✎</button><button class="icon-button" data-action="delete-goal" data-id="${escapeHtml(g.id)}" aria-label="Delete goal">×</button></div></div><h2>${escapeHtml(g.name)}</h2><p>${escapeHtml(g.description||'One thoughtful step at a time.')}</p><div class="goal-card-amount"><strong class="money-value">${money(g.current)}</strong><span>of <b class="money-value">${money(g.target)}</b></span></div><div class="progress-track"><span style="--progress:${g.percent}%"></span></div><div class="goal-row-foot"><span>${g.percent}% there</span><span>${g.targetDate?`By ${dateLabel(g.targetDate)}`:'No target date'}</span></div><button class="button button-secondary button-full" data-action="add-contribution" data-id="${escapeHtml(g.id)}" data-name="${escapeHtml(g.name)}">＋ Add contribution</button></article>`).join('')}</div>`:emptyState('◎','A goal makes saving feel real','Name something you would like to save toward. You can contribute any amount along the way.','new-goal','Create a savings goal')}`;
}
function analyticsPage(data) {
  return `${pageHeader('Analytics','Your financial patterns, explained with your own history.',`<select id="analytics-range" aria-label="Analytics range"><option value="month" ${data.range==='month'?'selected':''}>Last 2 months</option><option value="year" ${data.range==='year'?'selected':''}>This year</option><option value="all" ${data.range==='all'?'selected':''}>All history</option></select> ${button('Export report','export-report','button button-secondary')}`)}
    ${data.hasData?`<div class="analytics-summary"><article class="metric-card"><span>Recorded expenses</span><strong class="money-value">${money(data.expenseTotal)}</strong></article><article class="metric-card"><span>Daily average on active days</span><strong class="money-value">${money(data.averageDaily)}</strong></article><article class="metric-card"><span>Transactions in range</span><strong>${data.transactionCount}</strong></article></div><div class="analytics-grid"><section class="panel analytics-trend"><div class="panel-heading"><div><span class="eyebrow">RECENT MOVEMENT</span><h2>Income and expenses</h2></div><div class="chart-legend"><span><i class="income-swatch"></i>Income</span><span><i class="expense-swatch"></i>Expenses</span></div></div>${data.months.length?trendSvg(data.months):emptyState('▥','Not enough records yet','Add transactions across a few dates to reveal a trend.')}</section><section class="panel analytics-cats"><div class="panel-heading"><div><span class="eyebrow">WHERE IT GOES</span><h2>Spending by category</h2></div></div>${categoryBars(data.categories,8)}</section><section class="panel daily-panel"><div class="panel-heading"><div><span class="eyebrow">DAILY SPENDING</span><h2>Recent active days</h2></div></div>${data.daily.length?`<div class="daily-list">${data.daily.slice(-10).reverse().map(d=>`<div><time>${dateLabel(d.date)}</time><span class="daily-bar"><i style="--daily:${Math.max(4,num(d.amount)/(Math.max(...data.daily.map(x=>num(x.amount)),1))*100)}%"></i></span><strong class="money-value">${money(d.amount)}</strong></div>`).join('')}</div>`:emptyState('⌁','No daily pattern yet','Your daily spending will show as you record expenses.')}</section></div><p class="recorded-note">Averages use days that contain at least one recorded expense. These are observations from your records, not forecasts.</p>`:emptyState('▥','Your financial pulse needs a little history','Add income and expenses to build reports and insights from your own records.','quick-add','Record a transaction')}`;
}
function replayPage(data) {
  return `${pageHeader('Financial replay','Follow your month as it unfolded.',`<label class="month-picker">Month <input id="replay-month" type="month" value="${escapeHtml(data.month)}"></label>`)}${data.events.length?`<div class="replay-summary"><div><span class="eyebrow">MONTH-END NET</span><strong class="money-value">${money(data.net)}</strong></div><div><span>Income</span><strong class="money-value amount-positive">${money(data.income)}</strong></div><div><span>Expenses</span><strong class="money-value amount-negative">${money(data.expenses)}</strong></div><div><span>Events</span><strong>${data.events.length}</strong></div></div><section class="panel replay-panel"><div class="panel-heading"><div><span class="eyebrow">${escapeHtml(monthText(data.month).toUpperCase())}</span><h2>Your money, day by day</h2></div><button class="button button-secondary" data-action="replay-play">▷ Play timeline</button></div><div class="replay-timeline">${data.events.map((e,i)=>`<article class="replay-event" style="--event-index:${i}"><span class="timeline-dot ${e.type}"></span><time>${dateLabel(e.date)}</time><div class="replay-event-card"><span class="replay-kind">${e.type==='income'?'INCOME':'EXPENSE'} · ${escapeHtml(e.category)}</span><strong>${escapeHtml(e.merchant||e.description)}</strong><small>${escapeHtml(e.purpose||e.description)} · ${escapeHtml(e.paymentMethod)}</small></div><strong class="money-value ${amountClass(e.type)}">${e.type==='income'?'+':'−'}${money(e.amount)}</strong></article>`).join('')}</div><div class="replay-end"><span>That was ${escapeHtml(monthText(data.month))}</span><strong>Net recorded movement <b class="money-value">${money(data.net)}</b></strong></div></section><p class="recorded-note">The timeline shows saved transactions in date order. Month-end net is income less expenses within this month.</p>`:emptyState('▷','This month is still a blank page','Choose another month or add a transaction to start your replay.','quick-add','Add transaction')}`;
}
function importPage() {
  return `${pageHeader('Import transactions','Bring in a bank or wallet CSV, then review every row before it is saved.')}
    <div class="import-layout"><section class="panel import-main"><div class="import-step"><span>01</span><div><strong>Choose a CSV file</strong><p>Review your CSV in SpendWise before saving. The app does not connect to your bank.</p></div></div><label class="upload-zone" for="csv-file"><span class="upload-icon">⇧</span><strong>Drop a CSV here or browse</strong><small>Maximum 1,000 rows · CSV only</small><input id="csv-file" type="file" accept=".csv,text/csv"></label><div id="import-mapping"></div><div id="import-preview"></div></section><aside class="panel import-side"><span class="eyebrow">BEFORE YOU IMPORT</span><h2>Take a quick look.</h2><ul><li>Use a CSV exported from your bank or wallet.</li><li>Map the columns that contain amount, date, and description.</li><li>Review detected duplicates and invalid rows before saving.</li><li>Imported rows appear as ordinary transactions and can be edited.</li></ul><div class="import-private"><span>⌑</span><p>Statements are not sent to a third-party service. This application does not connect to your bank.</p></div></aside></div>`;
}
async function settingsPage() {
  const settings=state.settings;
  return `${pageHeader('Settings','A few thoughtful preferences for your financial space.')}
    <section class="panel settings-section install-app-section"><div class="settings-title"><span class="eyebrow">PHONE APP</span><h2>Take SpendWise with you</h2><p>Add it to your Home Screen for a full-screen app experience. Sign in to the same account to keep your records in sync.</p></div><button type="button" class="button button-secondary" data-action="install-app">Install SpendWise</button></section>
    <div class="settings-layout"><div class="settings-main"><section class="panel settings-section"><div class="settings-title"><span class="eyebrow">APPEARANCE</span><h2>Choose a mood</h2><p>Your theme is saved to this account and follows you between sessions on this device.</p></div><div class="theme-options">${[['olive','Olive & brass','Quiet luxury'],['charcoal','Charcoal & silver','Modern precision'],['midnight','Midnight & lime','Digital energy']].map(([id,name,desc])=>`<button class="theme-option theme-preview-${id} ${settings.theme===id?'selected':''}" data-action="set-theme" data-theme="${id}" aria-pressed="${settings.theme===id}"><span class="theme-dots"><i></i><i></i><i></i></span><span><strong>${name}</strong><small>${desc}</small></span><span class="theme-check">✓</span></button>`).join('')}</div><div class="settings-inline"><label class="toggle-setting"><span><strong>Privacy mode</strong><small>Blur money amounts across the app</small></span><input type="checkbox" id="privacy-setting" ${settings.privacyMode?'checked':''}><i></i></label><label class="toggle-setting"><span><strong>Reduced motion</strong><small>Keep transitions gentle and brief</small></span><input type="checkbox" id="motion-setting" ${!settings.motion?'checked':''}><i></i></label></div></section>
    <section class="panel settings-section"><div class="settings-title"><span class="eyebrow">FINANCIAL PREFERENCES</span><h2>Make it yours</h2></div><form id="preferences-form" class="settings-form"><label>Currency<select name="currency"><option value="INR" ${settings.currency==='INR'?'selected':''}>INR · Indian Rupee (₹)</option><option value="USD" ${settings.currency==='USD'?'selected':''}>USD · US Dollar ($)</option><option value="EUR" ${settings.currency==='EUR'?'selected':''}>EUR · Euro (€)</option><option value="GBP" ${settings.currency==='GBP'?'selected':''}>GBP · British Pound (£)</option></select></label><label>Date format<select name="dateFormat"><option ${settings.dateFormat==='DD MMM YYYY'?'selected':''}>DD MMM YYYY</option><option ${settings.dateFormat==='DD/MM/YYYY'?'selected':''}>DD/MM/YYYY</option><option ${settings.dateFormat==='YYYY-MM-DD'?'selected':''}>YYYY-MM-DD</option></select></label><button class="button button-secondary" type="submit">Save preferences</button></form></section>
    <section class="panel settings-section"><div class="settings-title"><span class="eyebrow">NOTIFICATIONS</span><h2>Only the useful nudges</h2><p>These updates are shown inside SpendWise.</p></div><div class="settings-inline"><label class="toggle-setting"><span><strong>Budget alerts</strong><small>When a budget approaches or passes its limit</small></span><input type="checkbox" id="notify-budgets" ${settings.notifications.budgets?'checked':''}><i></i></label><label class="toggle-setting"><span><strong>Bill reminders</strong><small>Upcoming due dates</small></span><input type="checkbox" id="notify-bills" ${settings.notifications.bills?'checked':''}><i></i></label><label class="toggle-setting"><span><strong>Savings milestones</strong><small>When a goal reaches its target</small></span><input type="checkbox" id="notify-goals" ${settings.notifications.goals?'checked':''}><i></i></label><label class="toggle-setting"><span><strong>Daily cash check-in</strong><small>A single reminder if no cash expense is recorded today</small></span><input type="checkbox" id="notify-cash" ${settings.notifications.cash?'checked':''}><i></i></label></div><button class="button button-secondary" data-action="save-notifications">Save notification preferences</button></section>
    <section class="panel settings-section"><div class="settings-title"><span class="eyebrow">YOUR DATA</span><h2>Keep a copy, or start fresh</h2><p>Hosted SpendWise stores records in its connected Turso database; local runs use SQLite. SpendWise does not encrypt local SQLite files. Export a copy any time; deleting the account permanently removes its records from the active database.</p></div><div class="settings-actions"><button class="button button-secondary" data-action="export-data">⇩ Export all data</button><button class="button button-danger-outline" data-action="delete-account">Delete account</button></div></section>
    <section class="panel settings-section"><div class="settings-title"><span class="eyebrow">ACCOUNT SECURITY</span><h2>Change password</h2></div><form id="password-form" class="settings-form password-form"><label>Current password<input type="password" name="currentPassword" autocomplete="current-password" required></label><label>New password<input type="password" name="newPassword" autocomplete="new-password" minlength="10" required></label><button class="button button-secondary" type="submit">Update password</button></form><button class="text-button settings-logout" data-action="logout">Sign out of SpendWise</button></section>
    <section class="panel settings-section"><div class="settings-title"><span class="eyebrow">CATEGORIES</span><h2>Your spending vocabulary</h2><p>Rename or recolor a category. Deleting one leaves its old transactions uncategorized.</p></div><div class="category-settings">${state.categories.map(c=>`<div class="category-setting-row"><span class="category-dot" style="--category-color:${escapeHtml(c.color)}"></span><strong>${escapeHtml(c.name)}</strong><button class="text-button" data-action="edit-category" data-id="${escapeHtml(c.id)}">Edit</button><button class="text-button text-danger" data-action="delete-category" data-id="${escapeHtml(c.id)}">Delete</button></div>`).join('')}<button class="button button-quiet" data-action="new-category">＋ Add a category</button></div></section></div>
    <aside class="settings-aside"><div class="account-card"><span class="avatar avatar-large">${escapeHtml((state.user.name||'S')[0].toUpperCase())}</span><span class="eyebrow">YOUR ACCOUNT</span><h2>${escapeHtml(state.user.name)}</h2><p>${escapeHtml(state.user.email)}</p><span class="account-local"><i></i> SpendWise account</span></div><div class="settings-note"><span>⌑</span><p>Hosted SpendWise saves records to its connected Turso database; local runs use SQLite.</p></div><div class="settings-note"><span>◈</span><p>Transactions are not imported automatically from banks or payment apps. Add them manually, import a CSV, or schedule recurring entries.</p></div></aside></div>`;
}

function openModal(title,kicker,content,onSubmit) {
  $('#modal-title').textContent=title;$('#modal-kicker').textContent=kicker;$('#modal-content').innerHTML=content;
  const dialog=$('#modal');if(!dialog.open)dialog.showModal();
  const form=$('#modal-content form');if(form&&onSubmit)form.onsubmit=async e=>{e.preventDefault();const submit=$('button[type="submit"]',form);submit.disabled=true;try{await onSubmit(new FormData(form),form);}catch(err){modalError(err.message);}finally{if(submit.isConnected)submit.disabled=false;}};
  setTimeout(()=>$('input:not([type=hidden]),select,textarea',$('#modal-content'))?.focus(),50);
}
function closeModal(){if($('#modal').open)$('#modal').close();}
function modalError(message){let el=$('.form-error',$('#modal-content'));if(!el){el=document.createElement('p');el.className='form-error';el.setAttribute('role','alert');$('#modal-content').prepend(el);}el.textContent=message;}
function formField(label,name,value='',type='text',extra=''){return `<label>${escapeHtml(label)}<input name="${escapeHtml(name)}" type="${type}" value="${escapeHtml(value)}" ${extra}></label>`;}
async function installSpendWise() {
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (installed) { toast('SpendWise is already installed'); return; }
  if (deferredInstallPrompt) {
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === 'accepted') toast('SpendWise installed');
    return;
  }
  const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const steps = isAppleMobile
    ? '<li>Open SpendWise in Safari and tap Share.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Turn on <strong>Open as Web App</strong>, then tap <strong>Add</strong>.</li>'
    : '<li>Open SpendWise in Chrome on your phone.</li><li>Open the browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li><li>Confirm to add SpendWise to your Home Screen.</li>';
  openModal('Install SpendWise', 'PHONE APP', `<div class="install-guide"><p class="modal-context">Add SpendWise to your Home Screen for an app-like experience.</p><ol class="install-steps">${steps}</ol><p class="modal-context">Sign in to the same account. An internet connection is needed to load and save financial records.</p></div>`);
}
function transactionForm(tx = {}) {
  const isIncome=tx.type==='income';const content=`<form class="form-stack modal-form"><div class="form-row"><label>Type<select name="type"><option value="expense" ${!isIncome?'selected':''}>Expense</option><option value="income" ${isIncome?'selected':''}>Income</option></select></label>${formField('Amount','amount',amountInput(tx.amount),'number','min="0.01" step="0.01" inputmode="decimal" required')}</div>${formField('What was it for?','description',tx.description||tx.purpose,'text','maxlength="120" required placeholder="e.g. Lunch with a friend"')}<div class="form-row"><label>Category<select name="categoryId">${categoryOptions(tx.categoryId||'')}</select></label><label>Payment method<select name="paymentMethod">${['Cash','UPI','Card','Bank transfer','Wallet','Other'].map(m=>`<option ${tx.paymentMethod===m?'selected':''}>${m}</option>`).join('')}</select></label></div><div class="form-row">${formField('Date','date',tx.date||localToday(),'date','required')}${formField('Merchant (optional)','merchant',tx.merchant||'','text','maxlength="100" placeholder="Where was it?"')}</div><label>Note (optional)<textarea name="notes" rows="2" maxlength="500" placeholder="Anything you want to remember">${escapeHtml(tx.notes||'')}</textarea></label><p class="form-error" role="alert"></p><button class="button button-primary button-full" type="submit">${tx.id?'Save changes':'Save transaction'}</button></form>`;
  openModal(tx.id?'Edit transaction':'Quick capture','TRANSACTION',content,async form=>{
    const val=Object.fromEntries(form.entries());val.purpose=val.description;
    await api(tx.id?`/api/transactions/${tx.id}`:'/api/transactions',{method:tx.id?'PUT':'POST',body:val});closeModal();toast(tx.id?'Transaction updated':'Transaction saved');await refreshAfterMutation();
  });
}
function quickActions() {
  openModal('What would you like to add?','QUICK CAPTURE',`<div class="quick-action-grid"><button data-action="modal-expense"><span>↗</span><strong>Expense</strong><small>Cash or digital</small></button><button data-action="modal-income"><span>↙</span><strong>Income</strong><small>Salary or other</small></button><button data-action="modal-budget"><span>◴</span><strong>Budget</strong><small>Plan a limit</small></button><button data-action="modal-bill"><span>▤</span><strong>Bill reminder</strong><small>Keep a date close</small></button><button data-action="modal-goal"><span>◎</span><strong>Savings goal</strong><small>Save for something</small></button><button data-action="modal-recurring"><span>⟳</span><strong>Recurring entry</strong><small>Set a schedule</small></button></div>`);
}
function budgetModal(old = {}) {
  const content=`<form class="form-stack modal-form">${formField('Budget name','name',old.name||'','text','maxlength="80" required placeholder="e.g. Weekday lunches"')}<div class="form-row"><label>Limit<select name="period"><option value="monthly" ${old.period!=='weekly'?'selected':''}>Monthly</option><option value="weekly" ${old.period==='weekly'?'selected':''}>Weekly</option></select></label>${formField('Amount','amount',amountInput(old.amount),'number','min="0.01" step="0.01" required')}</div><label>Category<select name="categoryId"><option value="">All categories</option>${state.categories.map(c=>`<option value="${escapeHtml(c.id)}" ${old.categoryId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select></label><label>Alert me when spending reaches <span class="input-suffix"><input name="warnPercent" type="number" min="1" max="99" value="${old.warnPercent||80}" required><span>%</span></span></label><p class="form-error" role="alert"></p><button class="button button-primary button-full" type="submit">${old.id?'Save budget':'Create budget'}</button></form>`;
  openModal(old.id?'Edit budget':'Create a budget','BUDGET PLAN',content,async f=>{const v=Object.fromEntries(f.entries());await api(old.id?`/api/budgets/${old.id}`:'/api/budgets',{method:old.id?'PUT':'POST',body:v});closeModal();toast(old.id?'Budget updated':'Budget created');await refreshAfterMutation();});
}
function billModal(old={}) {
  const content=`<form class="form-stack modal-form">${formField('Bill or reminder name','title',old.title||'','text','maxlength="100" required placeholder="e.g. Electricity"')}<div class="form-row">${formField('Amount','amount',amountInput(old.amount??'0'),'number','min="0" step="0.01" required')}${formField('Due date','dueDate',old.dueDate||localToday(),'date','required')}</div><label>Frequency<select name="recurrence">${[['none','One time'],['weekly','Weekly'],['monthly','Monthly'],['yearly','Yearly']].map(([v,l])=>`<option value="${v}" ${old.recurrence===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Category<select name="categoryId">${categoryOptions(old.categoryId||'')}</select></label><label>Note (optional)<textarea name="notes" rows="2" maxlength="500">${escapeHtml(old.notes||'')}</textarea></label><p class="form-error" role="alert"></p><button class="button button-primary button-full" type="submit">${old.id?'Save reminder':'Create reminder'}</button></form>`;
  openModal(old.id?'Edit bill reminder':'Add bill reminder','BILLS & REMINDERS',content,async f=>{const v=Object.fromEntries(f.entries());await api(old.id?`/api/bills/${old.id}`:'/api/bills',{method:old.id?'PUT':'POST',body:v});closeModal();toast(old.id?'Reminder updated':'Reminder added');await refreshAfterMutation();});
}
function goalModal(old={}){const content=`<form class="form-stack modal-form">${formField('What are you saving for?','name',old.name||'','text','maxlength="80" required placeholder="e.g. A mountain weekend"')}<div class="form-row">${formField('Target amount','target',old.target||'','number','min="0.01" step="0.01" required')}${formField('Target date (optional)','targetDate',old.targetDate||'','date')}</div><label>Why it matters (optional)<textarea name="description" maxlength="300" rows="2" placeholder="A little context for your future self">${escapeHtml(old.description||'')}</textarea></label><p class="form-error" role="alert"></p><button class="button button-primary button-full" type="submit">${old.id?'Save changes':'Create savings goal'}</button></form>`;openModal(old.id?'Edit your goal':'Make a little room for it','SAVINGS GOAL',content,async f=>{await api(old.id?`/api/goals/${old.id}`:'/api/goals',{method:old.id?'PUT':'POST',body:Object.fromEntries(f.entries())});closeModal();toast(old.id?'Goal updated':'Savings goal created');await refreshAfterMutation();});}
function contributionModal(id,name){const content=`<form class="form-stack modal-form"><p class="modal-context">Add to <strong>${escapeHtml(name)}</strong>. Your contribution will appear in its history.</p>${formField('Amount','amount','','number','min="0.01" step="0.01" required')}${formField('Date','date',localToday(),'date','required')}<label>Note (optional)<input name="note" maxlength="200" placeholder="A little extra this month"></label><p class="form-error" role="alert"></p><button class="button button-primary button-full" type="submit">Add contribution</button></form>`;openModal('Add to your goal','SAVINGS CONTRIBUTION',content,async f=>{await api(`/api/goals/${id}/contributions`,{method:'POST',body:Object.fromEntries(f.entries())});closeModal();toast('Contribution added');await refreshAfterMutation();});}
function recurringModal(old={}){const content=`<form class="form-stack modal-form"><div class="form-row"><label>Type<select name="type"><option value="expense" ${old.type!=='income'?'selected':''}>Expense</option><option value="income" ${old.type==='income'?'selected':''}>Income</option></select></label>${formField('Amount','amount',old.amount||'','number','min="0.01" step="0.01" required')}</div>${formField('Purpose','description',old.description||'','text','maxlength="120" required placeholder="e.g. Monthly rent"')}<div class="form-row"><label>Category<select name="categoryId">${categoryOptions(old.categoryId||'')}</select></label><label>Payment method<select name="paymentMethod">${['Cash','UPI','Card','Bank transfer','Wallet','Other'].map(m=>`<option ${old.paymentMethod===m?'selected':''}>${m}</option>`).join('')}</select></label></div><div class="form-row"><label>Frequency<select name="frequency">${[['monthly','Monthly'],['weekly','Weekly'],['yearly','Yearly']].map(([v,l])=>`<option value="${v}" ${old.frequency===v?'selected':''}>${l}</option>`).join('')}</select></label>${formField('Next date','nextDate',old.nextDate||localToday(),'date','required')}</div>${formField('End date (optional)','endDate',old.endDate||'','date')}<p class="form-error" role="alert"></p><button class="button button-primary button-full" type="submit">${old.id?'Save schedule':'Create schedule'}</button></form>`;openModal(old.id?'Edit recurring transaction':'Schedule a transaction','RECURRING ENTRY',content,async f=>{await api(old.id?`/api/recurring/${old.id}`:'/api/recurring',{method:old.id?'PUT':'POST',body:Object.fromEntries(f.entries())});closeModal();toast(old.id?'Schedule updated':'Recurring schedule created');await refreshAfterMutation();});}
function categoryModal(old={}){const content=`<form class="form-stack modal-form">${formField('Category name','name',old.name||'','text','maxlength="40" required')}${formField('Color','color',old.color||'#8a9467','color','required')}<label>Icon name<input name="icon" value="${escapeHtml(old.icon||'circle')}" maxlength="32" placeholder="e.g. leaf, train, book"></label><p class="form-error" role="alert"></p><button class="button button-primary button-full" type="submit">${old.id?'Save category':'Create category'}</button></form>`;openModal(old.id?'Edit category':'Add a category','CATEGORY',content,async f=>{await api(old.id?`/api/categories/${old.id}`:'/api/categories',{method:old.id?'PUT':'POST',body:Object.fromEntries(f.entries())});state.categories=(await api('/api/categories')).categories;closeModal();toast(old.id?'Category updated':'Category created');await renderRoute();});}
function confirmModal(title,message,confirmLabel,onConfirm,danger=false){const content=`<div class="confirm-body"><p>${escapeHtml(message)}</p><div class="confirm-actions"><button type="button" class="button button-quiet modal-cancel">Cancel</button><button type="button" class="button ${danger?'button-danger':'button-primary'}" id="confirm-action">${escapeHtml(confirmLabel)}</button></div></div>`;openModal(title,'PLEASE CONFIRM',content);$('#confirm-action').onclick=async()=>{const btn=$('#confirm-action');btn.disabled=true;try{await onConfirm();closeModal();}catch(e){modalError(e.message);btn.disabled=false;}};$('.modal-cancel').onclick=closeModal;}
async function refreshAfterMutation(){state.categories=(await api('/api/categories')).categories;await renderRoute();}

function exportCsv() {
  api('/api/transactions').then(({transactions})=>{
    const headers=['date','type','amount','category','description','merchant','paymentMethod','notes'];const quote=v=>`"${String(v??'').replaceAll('"','""')}"`;
    const csv=[headers.join(','),...transactions.map(t=>[t.date,t.type,t.amount,t.category,t.description,t.merchant,t.paymentMethod,t.notes].map(quote).join(','))].join('\r\n');downloadBlob(csv,'text/csv;charset=utf-8',`spendwise-transactions-${new Date().toISOString().slice(0,10)}.csv`);
  }).catch(e=>toast(e.message,'error'));
}
function downloadBlob(content,type,name){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function exportReport(){api(`/api/analytics?range=${state.analyticsRange||'month'}`).then(data=>{const rows=[['Month','Income','Expenses'],...data.months.map(m=>[m.month,m.income,m.expenses]),[],['Category','Amount'],...data.categories.map(c=>[c.name,c.amount])];const csv=rows.map(r=>r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\r\n');downloadBlob(csv,'text/csv;charset=utf-8',`spendwise-report-${new Date().toISOString().slice(0,10)}.csv`);}).catch(e=>toast(e.message,'error'));}
async function exportData(){try{const data=await api('/api/export');downloadBlob(JSON.stringify(data,null,2),'application/json',`spendwise-backup-${new Date().toISOString().slice(0,10)}.json`);toast('Your data export is ready');}catch(e){toast(e.message,'error');}}

function parseCsv(source) {
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<source.length;i++){const ch=source[i];if(quoted){if(ch==='"'&&source[i+1]==='"'){cell+='"';i++;}else if(ch==='"')quoted=false;else cell+=ch;}else if(ch==='"')quoted=true;else if(ch===','){row.push(cell);cell='';}else if(ch==='\n'){row.push(cell.replace(/\r$/,''));if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}else cell+=ch;}
  if(cell||row.length){row.push(cell.replace(/\r$/,''));if(row.some(x=>x.trim()))rows.push(row);}
  if(rows.length<2)throw new Error('This CSV needs a header row and at least one transaction row.');
  return {headers:rows[0].map(h=>h.trim()),rows:rows.slice(1,1001)};
}
function importPagePreview() {
  if(!state.importRows.length)return '';
  const fields=[['date','Date'],['amount','Amount'],['description','Purpose'],['merchant','Merchant'],['type','Type'],['paymentMethod','Payment method']];
  return `<div class="mapping-panel"><div class="import-step"><span>02</span><div><strong>Map your columns</strong><p>Pick the column that contains each kind of information.</p></div></div><div class="mapping-grid">${fields.map(([field,label])=>`<label>${label}<select data-map="${field}"><option value="">${field==='merchant'||field==='type'||field==='paymentMethod'?'Not included':'Select a column'}</option>${state.importHeaders.map(h=>`<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join('')}</select></label>`).join('')}<label>Assign category<select data-map="categoryId"><option value="">Uncategorized</option>${state.categories.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}</select></label></div><button class="button button-secondary" data-action="build-import-preview">Review rows</button></div><div id="import-review"></div>`;
}
async function buildImportPreview() {
  const mapping=Object.fromEntries($$('[data-map]').map(el=>[el.dataset.map,el.value]));if(!mapping.amount||!mapping.date||!mapping.description){toast('Map amount, date, and purpose to continue.','error');return;}
  const existing=(await api('/api/transactions')).transactions;
  state.importRows=state.importRows.map(raw=>{
    const get=k=>raw[mapping[k]]??'';const rawAmount=String(get('amount')).replace(/[₹$€£,\s]/g,'');const parsed=Number(rawAmount);const inferredType=(mapping.type&&get('type')?String(get('type')).toLowerCase().includes('income')?'income':'expense':parsed<0?'expense':'expense');
    let date=String(get('date')).trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){const d=new Date(date);date=Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10);}
    const amount=Math.abs(parsed).toFixed(2),description=String(get('description')).trim(),merchant=String(get('merchant')).trim(),type=parsed<0&&!mapping.type?'expense':inferredType;
    const row={amount,type,description,purpose:description,merchant,paymentMethod:mapPayment(get('paymentMethod')),date,categoryId:mapping.categoryId||'',notes:'',raw};
    const dupe=existing.some(t=>t.type===type&&num(t.amount).toFixed(2)===Number(amount).toFixed(2)&&t.date===date&&(t.merchant||'').toLowerCase()===merchant.toLowerCase()&&t.description.toLowerCase()===description.toLowerCase()&&t.paymentMethod===row.paymentMethod);
    row.duplicate=dupe;row.valid=Number.isFinite(parsed)&&parsed>0&&!!description&&/^\d{4}-\d{2}-\d{2}$/.test(date);row.acceptDuplicate=false;return row;
  });
  $('#import-review').innerHTML=`<div class="import-step"><span>03</span><div><strong>Review before saving</strong><p>${state.importRows.filter(r=>r.valid).length} rows ready · ${state.importRows.filter(r=>!r.valid).length} need attention</p></div></div><div class="import-review-list">${state.importRows.slice(0,1000).map((r,i)=>`<div class="import-review-row ${r.valid?'':'invalid'}"><span class="import-row-number">${i+1}</span><span><strong>${escapeHtml(r.description||'Missing purpose')}</strong><small>${escapeHtml(r.date||'Invalid date')} · ${escapeHtml(r.paymentMethod)}${r.duplicate?' · Possible duplicate':''}</small></span><strong>${escapeHtml(r.amount)}</strong>${r.duplicate?`<label class="duplicate-check"><input type="checkbox" data-duplicate-index="${i}"> Import anyway</label>`:r.valid?'<span class="valid-tag">Ready</span>':'<span class="invalid-tag">Check row</span>'}</div>`).join('')}</div><button class="button button-primary" data-action="commit-import">Import valid rows</button>`;
}
function mapPayment(value){const v=String(value||'').toLowerCase();if(v.includes('upi'))return 'UPI';if(v.includes('card')||v.includes('credit')||v.includes('debit'))return 'Card';if(v.includes('bank')||v.includes('transfer'))return 'Bank transfer';if(v.includes('wallet'))return 'Wallet';if(v.includes('cash'))return 'Cash';return 'Other';}

async function openNotifications() {
  try{const {notifications}=await api('/api/notifications');$('#notification-dot').hidden=!notifications.some(n=>!n.readAt);$('#notifications-content').innerHTML=notifications.length?`<div class="notification-list">${notifications.map(n=>`<article class="notification-item ${n.readAt?'read':''}"><span class="notification-glyph ${escapeHtml(n.kind)}">${n.kind==='warning'?'!':n.kind==='success'?'✓':'◉'}</span><div><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.message)}</p><time>${new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(n.createdAt))}</time></div><div class="notification-actions">${!n.readAt?`<button class="text-button" data-action="read-notification" data-id="${escapeHtml(n.id)}">Read</button>`:''}<button class="text-button text-danger" data-action="delete-notification" data-id="${escapeHtml(n.id)}">Dismiss</button></div></article>`).join('')}</div>`:emptyState('♧','All caught up','Useful updates will appear here.');if(!$('#notifications-dialog').open)$('#notifications-dialog').showModal();}catch(e){toast(e.message,'error');}
}

function openCommandPalette(){const d=$('#command-dialog');$('#command-input').value='';renderCommandResults('');if(!d.open)d.showModal();$('#command-input').focus();}
let commandSearchTimer;
function renderCommandResults(query){const q=query.trim().toLowerCase();const commands=[...navCommands,{id:'add-expense',label:'Add an expense',hint:'Quick capture'},{id:'add-income',label:'Add income',hint:'Quick capture'},{id:'add-budget',label:'Create a budget',hint:'Quick capture'},{id:'add-goal',label:'Create a savings goal',hint:'Quick capture'},{id:'add-reminder',label:'Add a bill reminder',hint:'Quick capture'}].filter(x=>`${x.label} ${x.hint}`.toLowerCase().includes(q));$('#command-results').innerHTML=commands.length?commands.map((x,i)=>`<button class="command-result ${i===0?'selected':''}" data-command="${x.id}"><span class="command-result-icon">${x.id in pages?'↗':'＋'}</span><span><strong>${escapeHtml(x.label)}</strong><small>${escapeHtml(x.hint)}</small></span><kbd>↵</kbd></button>`).join(''):`<div class="command-empty">No matching pages or actions. Searching saved transactions…</div>`;clearTimeout(commandSearchTimer);if(q.length<2)return;commandSearchTimer=setTimeout(async()=>{try{const {transactions}=await api('/api/transactions/search',{method:'POST',body:{q}});if($('#command-input').value.trim().toLowerCase()!==q)return;const hits=transactions.slice(0,5);if(!hits.length)return;$('#command-results').insertAdjacentHTML('beforeend',`<div class="command-section">TRANSACTIONS</div>${hits.map(t=>`<button class="command-result" data-command-transaction="${escapeHtml(t.id)}" data-query="${escapeHtml(t.merchant||t.description)}"><span class="command-result-icon">${t.type==='income'?'↙':'↗'}</span><span><strong>${escapeHtml(t.merchant||t.description)}</strong><small>${escapeHtml(t.category)} · ${dateLabel(t.date)} · ${money(t.amount)}</small></span><kbd>↵</kbd></button>`).join('')}`);}catch{}},180);}

async function handleAction(action,el) {
  const id=el.dataset.id;
  if(action==='install-app')return installSpendWise();
  if(action==='quick-add')return quickActions();
  if(action==='modal-expense')return transactionForm({type:'expense'});
  if(action==='modal-income')return transactionForm({type:'income'});
  if(action==='modal-budget')return budgetModal();
  if(action==='modal-bill')return billModal();
  if(action==='modal-goal')return goalModal();
  if(action==='modal-recurring')return recurringModal();
  if(action==='new-budget')return budgetModal();if(action==='new-bill')return billModal();if(action==='new-goal')return goalModal();if(action==='new-recurring')return recurringModal();if(action==='new-category')return categoryModal();
  if(action==='quick-add-tx')return transactionForm();if(action==='edit-tx'){const {transactions}=await api('/api/transactions');const tx=transactions.find(t=>t.id===id);if(tx)transactionForm(tx);return;}
  if(action==='edit-budget'){const {budgets}=await api('/api/budgets');const budget=budgets.find(b=>b.id===id);if(budget)budgetModal(budget);return;}
  if(action==='delete-tx')return confirmModal('Delete transaction?','This removes the transaction from your reports and recorded balance. This cannot be undone.','Delete transaction',async()=>{await api(`/api/transactions/${id}`,{method:'DELETE'});toast('Transaction deleted');await refreshAfterMutation();},true);
  if(action==='delete-budget')return confirmModal('Delete this budget?','The budget will be removed. Transactions remain in your history.','Delete budget',async()=>{await api(`/api/budgets/${id}`,{method:'DELETE'});toast('Budget deleted');await refreshAfterMutation();},true);
  if(action==='delete-bill')return confirmModal('Delete this reminder?','This removes the bill reminder from your calendar.','Delete reminder',async()=>{await api(`/api/bills/${id}`,{method:'DELETE'});toast('Reminder deleted');await refreshAfterMutation();},true);
  if(action==='edit-bill'){const {bills}=await api('/api/bills');const bill=bills.find(b=>b.id===id);if(bill)billModal(bill);return;}
  if(action==='pay-bill'){await api(`/api/bills/${id}/pay`,{method:'POST',body:{}});toast('Bill marked as paid');return refreshAfterMutation();}
  if(action==='delete-goal')return confirmModal('Remove this savings goal?','The goal and its contribution history will be deleted.','Delete goal',async()=>{await api(`/api/goals/${id}`,{method:'DELETE'});toast('Goal removed');await refreshAfterMutation();},true);
  if(action==='add-contribution')return contributionModal(id,el.dataset.name);
  if(action==='edit-goal'){const {goals}=await api('/api/goals');const goal=goals.find(g=>g.id===id);if(goal)goalModal(goal);return;}
  if(action==='edit-recurring'){const {recurring}=await api('/api/recurring');const item=recurring.find(r=>r.id===id);if(item)recurringModal(item);return;}
  if(action==='toggle-recurring'){await api(`/api/recurring/${id}`,{method:'PATCH',body:{active:el.dataset.active!=='true'}});toast(el.dataset.active==='true'?'Schedule paused':'Schedule resumed');return refreshAfterMutation();}
  if(action==='delete-recurring')return confirmModal('Delete this schedule?','Future entries will stop. Transactions already recorded remain in history.','Delete schedule',async()=>{await api(`/api/recurring/${id}`,{method:'DELETE'});toast('Schedule deleted');await refreshAfterMutation();},true);
  if(action==='set-theme'){state.settings={...state.settings,theme:el.dataset.theme};applyTheme();try{await saveSettings();$$('.theme-option').forEach(x=>{x.classList.toggle('selected',x===el);x.setAttribute('aria-pressed',x===el?'true':'false');});}catch(e){toast(e.message,'error');}return;}
  if(action==='privacy-toggle'){state.settings.privacyMode=!state.settings.privacyMode;applyTheme();try{await saveSettings();toast(state.settings.privacyMode?'Privacy mode on':'Privacy mode off');if(state.page==='dashboard')await renderRoute();}catch(e){toast(e.message,'error');}return;}
  if(action==='save-notifications'){state.settings.notifications={budgets:$('#notify-budgets').checked,bills:$('#notify-bills').checked,goals:$('#notify-goals').checked,cash:$('#notify-cash').checked};try{await saveSettings();toast('Notification preferences saved');}catch(e){toast(e.message,'error');}return;}
  if(action==='export-transactions')return exportCsv();if(action==='export-report')return exportReport();if(action==='export-data')return exportData();
  if(action==='read-notification'){await api(`/api/notifications/${id}/read`,{method:'POST',body:{}});return openNotifications();}
  if(action==='delete-notification'){await api(`/api/notifications/${id}`,{method:'DELETE'});toast('Notification dismissed');return openNotifications();}
  if(action==='mark-all-read'){await api('/api/notifications/read-all',{method:'POST',body:{}});toast('Notifications marked read');$('#notifications-dialog').close();$('#notification-dot').hidden=true;return;}
  if(action==='tx-page'){state.txPage+=Number(el.dataset.step);return renderRoute();}
  if(action==='retry-page')return renderRoute();if(action==='replay-play')return playReplay();
  if(action==='edit-category'){const {categories}=await api('/api/categories');const c=categories.find(x=>x.id===id);if(c)categoryModal(c);return;}
  if(action==='delete-category')return confirmModal('Delete this category?','Transactions using it will remain, but will show as uncategorized.','Delete category',async()=>{await api(`/api/categories/${id}`,{method:'DELETE'});state.categories=(await api('/api/categories')).categories;toast('Category deleted');await renderRoute();},true);
  if(action==='delete-account')return deleteAccount();
  if(action==='logout'){await api('/api/logout',{method:'POST',body:{}});state.user=null;showAuth();return;}
  if(action==='build-import-preview')return buildImportPreview();
  if(action==='commit-import'){
    const rows=state.importRows.filter(r=>r.valid).map((r,i)=>({...r,acceptDuplicate:!!$(`[data-duplicate-index="${state.importRows.indexOf(r)}"]`)?.checked}));
    if(!rows.length){toast('There are no valid rows to import.','error');return;}
    const result=await api('/api/import/commit',{method:'POST',body:{rows}});state.importRows=[];toast(`${result.imported} imported · ${result.duplicatesSkipped} duplicates skipped${result.invalidRows?` · ${result.invalidRows} invalid`:''}`);return renderRoute();
  }
}
async function saveSettings(){const body={theme:state.settings.theme,currency:state.settings.currency,dateFormat:state.settings.dateFormat,privacyMode:state.settings.privacyMode,motion:state.settings.motion,notifications:state.settings.notifications};const result=await api('/api/settings',{method:'PUT',body});state.settings=result.settings;applyTheme();}
async function deleteAccount(){const content=`<form class="form-stack modal-form"><p class="danger-copy">This permanently deletes your SpendWise account and all of its financial records from the active account database.</p><label>Confirm with your current password<input name="password" type="password" autocomplete="current-password" required></label><p class="form-error" role="alert"></p><div class="confirm-actions"><button type="button" class="button button-quiet modal-cancel">Cancel</button><button class="button button-danger" type="submit">Delete my account</button></div></form>`;openModal('Delete your account','PERMANENT ACTION',content,async f=>{await api('/api/account',{method:'DELETE',body:Object.fromEntries(f.entries())});closeModal();state.user=null;showAuth();toast('Account deleted');});$('.modal-cancel').onclick=closeModal;}
async function playReplay(){const events=$$('.replay-event');for(const e of events){e.classList.add('replay-highlight');await new Promise(r=>setTimeout(r,360));e.classList.remove('replay-highlight');}}

$('#auth-switch').addEventListener('click',()=>{
  const registering=$('#auth-name-wrap').hidden;$('#auth-name-wrap').hidden=!registering;
  $('#auth-mode-label').textContent=registering?'CREATE YOUR ACCOUNT':'WELCOME BACK';$('#auth-title').textContent=registering?'A more thoughtful way to track your money.':'A clearer view of your money.';
  $('#auth-subtitle').textContent=registering?'Your records stay private in your local SpendWise account.':'Sign in to continue to your private financial space.';
  $('#auth-submit').innerHTML=registering?'Create account <span aria-hidden="true">→</span>':'Sign in <span aria-hidden="true">→</span>';
  $('#auth-switch-copy').textContent=registering?'Already have an account?':'New to SpendWise?';$('#auth-switch').textContent=registering?'Sign in':'Create account';
  $('#auth-form [name=password]').autocomplete=registering?'new-password':'current-password';$('#auth-error').textContent='';
});
$('#auth-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,registering=!$('#auth-name-wrap').hidden;const submit=$('#auth-submit');submit.disabled=true;$('#auth-error').textContent='';
  try{const data=Object.fromEntries(new FormData(form).entries());const result=await api(registering?'/api/register':'/api/login',{method:'POST',body:data});state.user=result.user;state.settings=result.settings;state.categories=(await api('/api/categories')).categories;showApp();location.hash='#/dashboard';await renderRoute();}catch(error){$('#auth-error').textContent=error.message;}finally{submit.disabled=false;}
});
window.addEventListener('hashchange',()=>renderRoute());
$('#page-content').addEventListener('click',async e=>{
  const actionEl=e.target.closest('[data-action]');if(!actionEl)return;
  try{await handleAction(actionEl.dataset.action,actionEl);}catch(error){if($('#modal').open)modalError(error.message);else toast(error.message,'error');}
});
$('#page-content').addEventListener('change',async e=>{
  const t=e.target;
  if(t.id==='tx-type'||t.id==='tx-category'||t.id==='tx-sort'||t.id==='tx-from'||t.id==='tx-to'){
    state.txFilters={...state.txFilters,type:$('#tx-type').value,categoryId:$('#tx-category').value,sort:$('#tx-sort').value,from:$('#tx-from').value,to:$('#tx-to').value};state.txPage=1;await renderRoute();
  }
  if(t.id==='analytics-range'){state.analyticsRange=t.value;await renderRoute();}
  if(t.id==='replay-month'){state.replayMonth=t.value;await renderRoute();}
  if(t.id==='csv-file'&&t.files?.[0]){try{if(t.files[0].size>1_000_000)throw new Error('Choose a CSV smaller than 1 MB.');const parsed=parseCsv(await t.files[0].text());state.importHeaders=parsed.headers;state.importRows=parsed.rows.map(row=>Object.fromEntries(parsed.headers.map((h,i)=>[h,row[i]||''])));$('#import-mapping').innerHTML=importPagePreview();$('#import-preview').innerHTML='';}catch(err){toast(err.message,'error');}}
  if(t.matches('[data-duplicate-index]'))state.importRows[Number(t.dataset.duplicateIndex)].acceptDuplicate=t.checked;
  if(t.id==='privacy-setting'){state.settings.privacyMode=t.checked;applyTheme();try{await saveSettings();}catch(err){toast(err.message,'error');}}
  if(t.id==='motion-setting'){state.settings.motion=!t.checked;applyTheme();try{await saveSettings();}catch(err){toast(err.message,'error');}}
  if(t.id==='notify-budgets'||t.id==='notify-bills'||t.id==='notify-goals'||t.id==='notify-cash'){};
});
let searchTimer;
$('#page-content').addEventListener('input',e=>{
  if(e.target.id==='tx-search'){clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{state.txFilters={...state.txFilters,q:e.target.value};state.txPage=1;await renderRoute();const input=$('#tx-search');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length);}},250);}
});
$('#page-content').addEventListener('submit',async e=>{
  const form=e.target;
  if(form.id==='preferences-form'){e.preventDefault();const data=Object.fromEntries(new FormData(form));state.settings.currency=data.currency;state.settings.dateFormat=data.dateFormat;try{await saveSettings();toast('Preferences saved');await renderRoute();}catch(err){toast(err.message,'error');}}
  if(form.id==='password-form'){e.preventDefault();const data=Object.fromEntries(new FormData(form));const submit=$('button[type=submit]',form);submit.disabled=true;try{await api('/api/account/password',{method:'PUT',body:data});form.reset();toast('Password updated');}catch(err){toast(err.message,'error');}finally{submit.disabled=false;}}
});
$('#quick-add').addEventListener('click',quickActions);
$('#notifications-open').addEventListener('click',openNotifications);
$('#mark-all-read').addEventListener('click',()=>handleAction('mark-all-read',$('#mark-all-read')));
$('#command-open').addEventListener('click',openCommandPalette);
$('#command-input').addEventListener('input',e=>renderCommandResults(e.target.value));
$('#command-dialog').addEventListener('click',e=>{const btn=e.target.closest('[data-command],[data-command-transaction]');if(!btn)return;$('#command-dialog').close();if(btn.dataset.commandTransaction){state.txFilters={...state.txFilters,q:btn.dataset.query||''};state.txPage=1;location.hash='#/transactions';return;}const command=btn.dataset.command;if(pages[command])location.hash=`#/${command}`;else if(command==='add-expense')transactionForm({type:'expense'});else if(command==='add-income')transactionForm({type:'income'});else if(command==='add-budget')budgetModal();else if(command==='add-goal')goalModal();else if(command==='add-reminder')billModal();});
$('#command-dialog').addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const items=$$('.command-result');if(!items.length)return;const index=items.findIndex(x=>x.classList.contains('selected'));const next=(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items.forEach((x,i)=>x.classList.toggle('selected',i===next));items[next].scrollIntoView({block:'nearest'});}if(e.key==='Enter'&&e.target.id==='command-input'){e.preventDefault();$('.command-result.selected')?.click();}});
$('#modal').addEventListener('click',e=>{if(e.target.matches('.modal-close')||e.target===$('#modal'))closeModal();});
$('#modal').addEventListener('click',e=>{const btn=e.target.closest('[data-action]');if(btn&&['modal-expense','modal-income','modal-budget','modal-bill','modal-goal','modal-recurring'].includes(btn.dataset.action))handleAction(btn.dataset.action,btn);});
$('#notifications-dialog').addEventListener('click',e=>{if(e.target.matches('.modal-close')||e.target===$('#notifications-dialog'))$('#notifications-dialog').close();const action=e.target.closest('[data-action]');if(action)handleAction(action.dataset.action,action).catch(err=>toast(err.message,'error'));});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openCommandPalette();}if(e.key==='Escape')closeMobileNav();});
$('#mobile-menu').addEventListener('click',()=>toggleMobileNav());
$('#mobile-more').addEventListener('click',()=>toggleMobileNav());
$('#mobile-nav-backdrop').addEventListener('click',closeMobileNav);
function toggleMobileNav(){setMobileNav(!$('#sidebar').classList.contains('mobile-open'));}
let sidebarSpringFrame=0;
function stopSidebarSpring(){if(sidebarSpringFrame){cancelAnimationFrame(sidebarSpringFrame);sidebarSpringFrame=0;}}
function setMobileNav(open,keepDrag=false){const sidebar=$('#sidebar');stopSidebarSpring();if(!keepDrag)sidebar.classList.remove('drawer-dragging');sidebar.classList.toggle('mobile-open',open);$('#mobile-menu').setAttribute('aria-expanded',String(open));$('#mobile-more').setAttribute('aria-expanded',String(open));$('#mobile-nav-backdrop').hidden=!open;if(!keepDrag)sidebar.style.removeProperty('transform');}
function closeMobileNav(){setMobileNav(false);}
$('#sidebar').addEventListener('click',e=>{if(e.target.closest('a[href^="#/"]'))closeMobileNav();});
let sidebarGesture=null,suppressSidebarClickUntil=0;
function sidebarTranslateX(){const transform=getComputedStyle($('#sidebar')).transform;if(transform==='none')return 0;const values=transform.match(/matrix(?:3d)?\(([^)]+)\)/);if(!values)return $('#sidebar').classList.contains('mobile-open')?0:-$('#sidebar').getBoundingClientRect().width;const parts=values[1].split(',').map(Number);return parts.length===16?parts[12]:parts[4];}
function startSidebarGesture(event){
  const sidebar=$('#sidebar');if(!event.isPrimary||innerWidth>900||event.button>0||$('#modal').open||$('#command-dialog').open||$('#notifications-dialog').open)return;
  const open=sidebar.classList.contains('mobile-open'),interactive=event.target.closest('a,button,input,select,textarea,dialog,.mobile-tabbar');
  const edgeStart=!open&&event.clientX<=22&&!interactive,drawerStart=open&&sidebar.contains(event.target)&&!interactive;
  if(!edgeStart&&!drawerStart)return;
  stopSidebarSpring();const offset=sidebarTranslateX();sidebarGesture={id:event.pointerId,startX:event.clientX,lastX:event.clientX,lastTime:event.timeStamp,velocity:0,offset,startOffset:offset,moved:false,wasOpen:open};
  sidebar.classList.add('drawer-dragging');sidebar.style.transform=`translateX(${offset}px)`;$('#mobile-nav-backdrop').hidden=false;
  $('#mobile-menu').setAttribute('aria-expanded','true');$('#mobile-more').setAttribute('aria-expanded','true');
  try{sidebar.setPointerCapture(event.pointerId);}catch{}
}
function moveSidebarGesture(event){
  if(!sidebarGesture||sidebarGesture.id!==event.pointerId)return;
  const gesture=sidebarGesture,sidebar=$('#sidebar'),width=sidebar.getBoundingClientRect().width,delta=event.clientX-gesture.startX;
  if(Math.abs(delta)>7){gesture.moved=true;if(event.cancelable)event.preventDefault();}
  gesture.offset=Math.max(-width,Math.min(0,gesture.startOffset+delta));sidebar.style.transform=`translateX(${gesture.offset}px)`;
  const elapsed=Math.max(1,event.timeStamp-gesture.lastTime),speed=(event.clientX-gesture.lastX)/elapsed;gesture.velocity=gesture.velocity*.55+speed*.45;gesture.lastX=event.clientX;gesture.lastTime=event.timeStamp;
}
function finishSidebarGesture(event,cancelled=false){
  if(!sidebarGesture||sidebarGesture.id!==event.pointerId)return;
  const gesture=sidebarGesture;sidebarGesture=null;
  const open=cancelled?gesture.wasOpen:Math.abs(gesture.velocity)>.55?gesture.velocity>0:gesture.offset>-$('#sidebar').getBoundingClientRect().width*.42;
  if(gesture.moved)suppressSidebarClickUntil=performance.now()+350;
  setMobileNav(open,true);settleSidebar(open,cancelled?0:gesture.velocity*1000);
}
function settleSidebar(open,initialVelocity=0){
  const sidebar=$('#sidebar'),width=sidebar.getBoundingClientRect().width,target=open?0:-width*1.02;
  const motionAllowed=state.settings?.motion!==false&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!motionAllowed){sidebar.classList.remove('drawer-dragging');sidebar.style.removeProperty('transform');return;}
  let x=sidebarTranslateX(),velocity=Math.max(-1800,Math.min(1800,initialVelocity)),last=performance.now();
  const mass=1,tension=300,friction=34;
  const tick=now=>{
    const elapsed=Math.min(.032,Math.max(.001,(now-last)/1000)),steps=Math.ceil(elapsed/.01),step=elapsed/steps;last=now;
    for(let i=0;i<steps;i++){const acceleration=(-tension*(x-target)-friction*velocity)/mass;velocity+=acceleration*step;x+=velocity*step;}
    x=Math.max(-width*1.1,Math.min(10,x));sidebar.style.transform=`translateX(${x}px)`;
    if(Math.abs(x-target)<.5&&Math.abs(velocity)<6){sidebarSpringFrame=0;sidebar.classList.remove('drawer-dragging');sidebar.style.removeProperty('transform');return;}
    sidebarSpringFrame=requestAnimationFrame(tick);
  };
  sidebarSpringFrame=requestAnimationFrame(tick);
}
document.addEventListener('pointerdown',startSidebarGesture);
document.addEventListener('pointermove',moveSidebarGesture,{passive:false});
document.addEventListener('pointerup',event=>finishSidebarGesture(event));
document.addEventListener('pointercancel',event=>finishSidebarGesture(event,true));
document.addEventListener('click',event=>{if(performance.now()<suppressSidebarClickUntil){event.preventDefault();event.stopImmediatePropagation();suppressSidebarClickUntil=0;}},true);
boot();
