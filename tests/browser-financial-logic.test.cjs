const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const BASE = process.env.MONEY_LIFE_TEST_URL || 'http://127.0.0.1:4173/index.html';
const KEY = 'moneylife_v1';
const INVEST_KEY = 'moneylife_virtual_invest_v1';
const CHALLENGE_KEY = 'moneylife_budget_challenge_v1';

async function freshPage(browser, state = null, extra = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', error => { throw error; });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ state, extra, KEY, INVEST_KEY, CHALLENGE_KEY }) => {
    localStorage.clear();
    if (state !== null) localStorage.setItem(KEY, JSON.stringify(state));
    if (extra.invest) localStorage.setItem(INVEST_KEY, JSON.stringify(extra.invest));
    if (extra.challenge) localStorage.setItem(CHALLENGE_KEY, JSON.stringify(extra.challenge));
  }, { state, extra, KEY, INVEST_KEY, CHALLENGE_KEY });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#homemetrics');
  return { context, page };
}
async function state(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
}
async function accountBalanceText(page) {
  return (await page.locator('#homeactualbalance').innerText()).trim();
}
async function go(page, view) {
  await page.locator('[data-view="' + view + '"]').first().click();
}
async function addTransaction(page, type, name, amount) {
  await go(page, 'records');
  await page.locator('#txtype').selectOption(type);
  await page.locator('#txname').fill(name);
  await page.locator('#txamount').fill(String(amount));
  await page.locator('#txdate').fill(await page.evaluate(() => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }));
  if (type === 'income') await page.locator('#txcat').selectOption({ label: 'Income' });
  await page.locator('#addtx').click();
}
async function run(name, fn) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let context;
  try {
    const result = await fn(browser);
    console.log('PASS | ' + name + (result ? ' | ' + result : ''));
  } catch (e) {
    console.error('FAIL | ' + name + ' | ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

(async () => {
  await run('Reset All clears financial and game state', async browser => {
    const { page, context } = await freshPage(browser, {
      budget: 700, openingBalance: 123, monthlyManual: { '2026-10': { income: 50 } },
      transactions: [{ id: 'x', type: 'income', name: 'Test', amount: 50, date: '2026-10-12' }],
      goals: [], fixedDeposits: [], xp: 30, answered: ['q1']
    }, { invest: { cash: 1, holdings: {}, history: [], prices: {}, day: 9, marketHistory: [] },
         challenge: { round: 1, unexpected: 0, saving: 25, want: 20, started: true, done: false, eventName: '', eventTip: '', eventDelta: 0 } });
    page.once('dialog', d => d.accept());
    await page.locator('#resetallhome').click();
    await page.waitForFunction(key => {
      const x = JSON.parse(localStorage.getItem(key) || 'null');
      return x && x.budget === 0 && x.openingBalance === 0 && x.transactions.length === 0;
    }, KEY);
    const d = await state(page);
    assert.equal(d.budget, 0);
    assert.equal(d.openingBalance, 0);
    assert.equal(d.transactions.length, 0);
    assert.equal(d.goals.length, 0);
    assert.equal(d.fixedDeposits.length, 0);
    assert.equal(await page.evaluate(k => localStorage.getItem(k), INVEST_KEY), null);
    const challenge = await page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), CHALLENGE_KEY);
    assert.ok(challenge, 'budget challenge should return to its default state');
    assert.equal(challenge.started, false);
    assert.equal(challenge.done, false);
    assert.equal(challenge.round, 0);
    await page.reload();
    assert.match(await accountBalanceText(page), /0\.00 GC/);
    await context.close();
    return 'budget=0, balance=0, transactions/goals/deposits cleared and challenge progress reset after reload';
  });

  await run('Changing planned budget does not change account balance', async browser => {
    const { page, context } = await freshPage(browser, { budget: 0, openingBalance: 250, monthlyManual: {}, transactions: [], goals: [], fixedDeposits: [], xp: 0, answered: [] });
    assert.match(await accountBalanceText(page), /250\.00 GC/);
    page.once('dialog', d => d.accept('700'));
    await page.locator('#editbudgethome').click();
    await page.reload();
    const d = await state(page);
    assert.equal(d.budget, 700);
    assert.match(await accountBalanceText(page), /250\.00 GC/);
    await context.close();
    return 'budget=700; balance remained 250.00 GC after save and reload';
  });

  await run('Income 1000 and expense 200 reconcile to balance 800', async browser => {
    const { page, context } = await freshPage(browser);
    await addTransaction(page, 'income', 'Test income', 1000);
    await page.reload();
    assert.match(await accountBalanceText(page), /1,000\.00 GC/);
    await addTransaction(page, 'expense', 'Test expense', 200);
    await page.reload();
    assert.match(await accountBalanceText(page), /800\.00 GC/);
    const d = await state(page);
    assert.equal(d.transactions.length, 2);
    assert.equal(d.transactions.filter(t => t.type === 'income').reduce((a,t) => a+t.amount,0), 1000);
    assert.equal(d.transactions.filter(t => t.type === 'expense').reduce((a,t) => a+t.amount,0), 200);
    await context.close();
    return 'verified 1,000 income - 200 expense = 800.00 GC, including persistence';
  });

  await run('Savings transfer reduces available balance and credits goal', async browser => {
    const { page, context } = await freshPage(browser, { budget: 0, openingBalance: 500, monthlyManual: {}, transactions: [], goals: [], fixedDeposits: [], xp: 0, answered: [] });
    await go(page, 'save');
    await page.locator('#goalname').fill('Automation Savings');
    await page.locator('#goaltarget').fill('300');
    await page.locator('#goalsaved').fill('0');
    await page.locator('#savegoal').click();
    await page.reload();
    const created = (await state(page)).goals[0];
    assert.ok(created, 'goal should persist after reload');
    await go(page, 'save');
    const transferButton = page.locator('#allgoals [data-add-save="' + created.id + '"]').first();
    page.once('dialog', d => d.accept('100'));
    await transferButton.click();
    await page.reload();
    const d = await state(page);
    assert.equal(d.transactions.filter(t => t.type === 'saving').reduce((a,t) => a+t.amount,0), 100);
    assert.match(await accountBalanceText(page), /400\.00 GC/);
    assert.equal(d.goals[0].closed, false);
    await context.close();
    return '100.00 GC transfer recorded; balance=400.00 GC and goal/transaction persisted';
  });

  await run('Premature fixed-deposit cancellation returns principal only', async browser => {
    const { page, context } = await freshPage(browser, { budget: 0, openingBalance: 500, monthlyManual: {}, transactions: [], goals: [], fixedDeposits: [], xp: 0, answered: [] });
    await go(page, 'fixeddeposit');
    await page.locator('#fdamount').fill('100');
    await page.locator('#fdterm').selectOption('3');
    await page.locator('#fdopen').click();
    await page.reload();
    assert.match(await accountBalanceText(page), /400\.00 GC/);
    const deposit = (await state(page)).fixedDeposits[0];
    assert.ok(deposit && !deposit.withdrawn);
    await go(page, 'fixeddeposit');
    page.once('dialog', d => d.accept());
    await page.locator('[data-fd-cancel="' + deposit.id + '"]').click();
    await page.reload();
    const d = await state(page);
    assert.equal(d.fixedDeposits[0].interest, 0);
    assert.equal(d.fixedDeposits[0].cancelled, true);
    assert.match(await accountBalanceText(page), /500\.00 GC/);
    await context.close();
    return '100.00 GC principal returned; interest=0; balance restored to 500.00 GC';
  });

  await run('Maturity withdrawal credits principal plus expected interest', async browser => {
    const { page, context } = await freshPage(browser, { budget: 0, openingBalance: 500, monthlyManual: {}, transactions: [], goals: [], fixedDeposits: [], xp: 0, answered: [] });
    await go(page, 'fixeddeposit');
    await page.locator('#fdamount').fill('100');
    await page.locator('#fdterm').selectOption('3');
    await page.locator('#fdopen').click();
    let d = await state(page);
    assert.ok(d.fixedDeposits[0]);
    await page.evaluate(({ key, id }) => {
      const x = JSON.parse(localStorage.getItem(key));
      const dt = new Date(); dt.setDate(dt.getDate() - 1);
      const date = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
      x.fixedDeposits.find(f => f.id === id).maturityDate = date;
      localStorage.setItem(key, JSON.stringify(x));
    }, { key: KEY, id: d.fixedDeposits[0].id });
    await page.reload();
    await go(page, 'fixeddeposit');
    page.once('dialog', d => d.accept());
    await page.locator('[data-fd-withdraw="' + d.fixedDeposits[0].id + '"]').click();
    await page.reload();
    d = await state(page);
    assert.equal(d.fixedDeposits[0].withdrawn, true);
    assert.equal(d.fixedDeposits[0].interest, 0.25);
    assert.match(await accountBalanceText(page), /500\.25 GC/);
    await context.close();
    return '100.00 GC principal + 0.25 GC interest = 500.25 GC total account balance';
  });

  await run('Future-dated backup is rejected without changing existing data', async browser => {
    const { page, context } = await freshPage(browser, { budget: 50, openingBalance: 200, monthlyManual: {}, transactions: [], goals: [], fixedDeposits: [], xp: 0, answered: [] });
    const before = await page.evaluate(key => localStorage.getItem(key), KEY);
    const futureDate = await page.evaluate(() => {
      const d = new Date(); d.setDate(d.getDate() + 1);
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    });
    const backup = { budget: 999, openingBalance: 999, monthlyManual: {}, transactions: [{ id: 'future-tx', type: 'income', name: 'Future income', amount: 10, date: futureDate, category: 'Income' }], goals: [], fixedDeposits: [], xp: 0, answered: [] };
    const dialogPromise = page.waitForEvent('dialog');
    await page.locator('#importfile').setInputFiles({ name: 'future-transaction.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    const dialog = await dialogPromise;
    const alertText = dialog.message();
    await dialog.accept();
    assert.match(alertText, /future-dated transactions are not allowed/i);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), KEY), before);
    await page.reload();
    assert.equal((await state(page)).budget, 50);
    assert.match(await accountBalanceText(page), /200\.00 GC/);
    await context.close();
    return 'future-date backup rejected; original budget=50 and balance=200.00 GC unchanged after reload';
  });

  if (process.exitCode) process.exit(1);
  console.log('All Money Life browser financial logic tests passed.');
})();
