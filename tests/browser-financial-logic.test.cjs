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


  await run('Editing and deleting transactions keeps ledger and balance consistent', async browser => {
    const { page, context } = await freshPage(browser, { budget: 0, openingBalance: 1000, monthlyManual: {}, transactions: [], goals: [], fixedDeposits: [], xp: 0, answered: [] });
    await addTransaction(page, 'expense', 'Test expense', 200);
    await page.reload();
    assert.match(await accountBalanceText(page), /800\.00 GC/);
    let d = await state(page);
    const tx = d.transactions.find(t => t.name === 'Test expense');
    assert.ok(tx, 'expense should exist before editing');

    await go(page, 'records');
    const editDialogs = ['Edited expense', '250', tx.date, tx.category || 'Other'];
    page.on('dialog', async dialog => {
      const value = editDialogs.shift();
      if (value === undefined) await dialog.accept();
      else await dialog.accept(value);
    });
    await page.locator('#alltx [data-edit-tx="' + tx.id + '"]').click();
    await page.reload();
    d = await state(page);
    const edited = d.transactions.find(t => t.id === tx.id);
    assert.equal(edited.name, 'Edited expense');
    assert.equal(edited.amount, 250);
    assert.match(await accountBalanceText(page), /750\.00 GC/);
    assert.match((await page.locator('#alltx').innerText()), /Edited expense/);

    await go(page, 'records');
    await page.locator('#alltx [data-del-tx="' + tx.id + '"]').click();
    await page.reload();
    d = await state(page);
    assert.equal(d.transactions.some(t => t.id === tx.id), false);
    assert.match(await accountBalanceText(page), /1,000\.00 GC/);
    assert.doesNotMatch(await page.locator('#alltx').innerText(), /Edited expense/);
    await context.close();
    return 'expense edited 200→250; balance 800→750; deleting it removed the ledger entry and restored 1,000.00 GC';
  });

  await run('Savings interest accrues and closing a goal reconciles balance and records', async browser => {
    const { page, context } = await freshPage(browser, { budget: 0, openingBalance: 500, monthlyManual: {}, transactions: [], goals: [], fixedDeposits: [], xp: 0, answered: [] });
    await go(page, 'save');
    await page.locator('#goalname').fill('Interest Test Goal');
    await page.locator('#goaltarget').fill('500');
    await page.locator('#goalsaved').fill('100');
    await page.locator('#savegoal').click();
    let d = await state(page);
    let goal = d.goals[0];
    assert.ok(goal, 'goal should be created');
    assert.equal(goal.openingSaved, 100);

    // Put the interest start date two calendar days back to exercise daily compounding deterministically.
    await page.evaluate(({ key, id }) => {
      const x = JSON.parse(localStorage.getItem(key));
      const dt = new Date(); dt.setDate(dt.getDate() - 2);
      const date = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
      const g = x.goals.find(v => v.id === id);
      g.interestStartDate = date;
      localStorage.setItem(key, JSON.stringify(x));
    }, { key: KEY, id: goal.id });
    await page.reload();
    d = await state(page);
    goal = d.goals.find(g => g.id === goal.id);
    const expected = 100 * Math.pow(1 + 0.0088 / 365, 3);
    assert.ok(Math.abs(goal.saved - expected) < 0.00001, 'goal balance should include daily compound interest: expected ' + expected + ', got ' + goal.saved);
    assert.ok(goal.saved > 100, 'interest should be positive');
    assert.match(await page.locator('#allgoals').innerText(), /Estimated interest/);

    const accruedBalance = goal.saved;
    await go(page, 'save');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#allgoals [data-end-goal="' + goal.id + '"]').click();
    await page.reload();
    d = await state(page);
    goal = d.goals.find(g => g.id === goal.id);
    assert.equal(goal.closed, true);
    assert.equal(goal.saved, 0);
    assert.equal(goal.closedBalance, Math.round(accruedBalance * 100) / 100);
    const closure = d.transactions.find(t => t.goalId === goal.id && t.category === 'Fund Closure Withdrawal');
    assert.ok(closure, 'closure should create a linked ledger record');
    assert.equal(closure.type, 'saving_out');
    assert.equal(closure.amount, goal.closedBalance);
    assert.match(await accountBalanceText(page), new RegExp((500 + goal.closedBalance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' GC'));
    const goalText = await page.locator('#allgoals').innerText();
    assert.match(goalText, /Closed/);
    assert.match(goalText, new RegExp(goal.closedBalance.toFixed(2)));
    assert.doesNotMatch(goalText, /Transfer In/);
    assert.doesNotMatch(goalText, /Close Goal/);
    await context.close();
    return 'daily interest accrued; closure locked the goal, stored rounded closed balance, created matching withdrawal ledger entry, and reconciled account balance';
  });


  await run('Editing and deleting a savings transfer recalculates principal, interest, and available balance', async browser => {
    const { page, context } = await freshPage(browser, { budget: 0, openingBalance: 500, monthlyManual: {}, transactions: [], goals: [], fixedDeposits: [], xp: 0, answered: [] });
    await go(page, 'save');
    await page.locator('#goalname').fill('Transfer Edit Interest Test');
    await page.locator('#goaltarget').fill('500');
    await page.locator('#goalsaved').fill('0');
    await page.locator('#savegoal').click();
    let d = await state(page);
    let goal = d.goals.find(g => g.name === 'Transfer Edit Interest Test');
    assert.ok(goal, 'savings goal should be created');

    await go(page, 'home');
    page.once('dialog', dialog => dialog.accept('100'));
    await page.locator('#homegoals [data-add-save="' + goal.id + '"]').click();
    d = await state(page);
    let tx = d.transactions.find(t => t.goalId === goal.id && t.type === 'saving');
    assert.ok(tx, '100 GC savings transfer should be recorded');
    assert.equal(tx.amount, 100);
    assert.match(await accountBalanceText(page), /400\.00 GC/);

    const startDate = await page.evaluate(() => {
      const dt = new Date(); dt.setDate(dt.getDate() - 2);
      return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
    });
    await page.evaluate(({ key, goalId, txId, startDate }) => {
      const x = JSON.parse(localStorage.getItem(key));
      const g = x.goals.find(v => v.id === goalId);
      const t = x.transactions.find(v => v.id === txId);
      g.interestStartDate = startDate;
      t.date = startDate;
      localStorage.setItem(key, JSON.stringify(x));
    }, { key: KEY, goalId: goal.id, txId: tx.id, startDate });
    await page.reload();

    let expected100 = 100 * Math.pow(1 + 0.0088 / 365, 2);
    d = await state(page);
    goal = d.goals.find(g => g.id === goal.id);
    assert.ok(Math.abs(goal.saved - expected100) < 0.00001, '100 GC transfer should earn two days of daily compound interest');
    assert.match(await accountBalanceText(page), /400\.00 GC/);

    await go(page, 'records');
    const prompts = ['Edited savings transfer', '150', startDate, 'Savings'];
    page.on('dialog', async dialog => {
      if (dialog.type() === 'prompt') {
        const value = prompts.shift();
        await dialog.accept(value === undefined ? '' : value);
      } else {
        await dialog.accept();
      }
    });
    await page.locator('#alltx [data-edit-tx="' + tx.id + '"]').click();
    await page.reload();
    d = await state(page);
    tx = d.transactions.find(t => t.id === tx.id);
    goal = d.goals.find(g => g.id === goal.id);
    const expected150 = 150 * Math.pow(1 + 0.0088 / 365, 2);
    assert.equal(tx.amount, 150);
    assert.equal(tx.name, 'Edited savings transfer');
    assert.ok(Math.abs(goal.saved - expected150) < 0.00001, 'interest must recalculate from edited 150 GC principal; expected ' + expected150 + ', got ' + goal.saved);
    assert.ok(goal.saved > expected150 - 0.00001 && goal.saved < expected150 + 0.00001);
    assert.match(await accountBalanceText(page), /350\.00 GC/);
    assert.match(await page.locator('#allgoals').innerText(), /Edited savings transfer|Estimated interest/);

    await go(page, 'records');
    await page.locator('#alltx [data-del-tx="' + tx.id + '"]').click();
    await page.reload();
    d = await state(page);
    goal = d.goals.find(g => g.id === goal.id);
    assert.equal(d.transactions.some(t => t.id === tx.id), false);
    assert.ok(Math.abs(goal.saved) < 0.000001, 'deleting the only transfer should reset fund balance and accrued interest to zero');
    assert.match(await accountBalanceText(page), /500\.00 GC/);
    assert.match(await page.locator('#allgoals').innerText(), /Fund balance 0\.00/);
    await context.close();
    return '100 GC transfer accrued interest; editing to 150 GC recalculated interest and balance (400→350); deleting it cleared fund principal/interest and restored 500 GC';
  });


  await run('Multiple dated savings transfers and partial withdrawal recalculate daily compound interest after edit/delete', async browser => {
    const { page, context } = await freshPage(browser, { budget: 0, openingBalance: 500, monthlyManual: {}, transactions: [], goals: [], fixedDeposits: [], xp: 0, answered: [] });
    await go(page, 'save');
    await page.locator('#goalname').fill('Multi-date Compound Interest Test');
    await page.locator('#goaltarget').fill('1000');
    await page.locator('#goalsaved').fill('0');
    await page.locator('#savegoal').click();
    let d = await state(page);
    let goal = d.goals.find(g => g.name === 'Multi-date Compound Interest Test');
    assert.ok(goal, 'goal should be created');

    async function clickPrompt(selector, amount) {
      page.once('dialog', dialog => dialog.accept(String(amount)));
      await page.locator(selector).click();
    }
    await go(page, 'home');
    await clickPrompt('#homegoals [data-add-save="' + goal.id + '"]', 100);
    await clickPrompt('#homegoals [data-add-save="' + goal.id + '"]', 200);
    await clickPrompt('#homegoals [data-withdraw-save="' + goal.id + '"]', 50);
    d = await state(page);
    let transfers = d.transactions.filter(t => t.goalId === goal.id && t.type === 'saving').sort((a,b)=>a.id.localeCompare(b.id));
    let withdrawal = d.transactions.find(t => t.goalId === goal.id && t.type === 'saving_out');
    assert.equal(transfers.length, 2);
    assert.ok(withdrawal, 'partial withdrawal should be recorded');

    const dates = await page.evaluate(() => {
      function fmt(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
      const d1=new Date(); d1.setDate(d1.getDate()-10);
      const d2=new Date(); d2.setDate(d2.getDate()-8);
      const d3=new Date(); d3.setDate(d3.getDate()-6);
      return { first:fmt(d1), second:fmt(d2), withdrawal:fmt(d3), editSecond:fmt(new Date(d1.getTime()+86400000)) };
    });
    // Give the test a deterministic history: day 1 +100, day 3 +200, day 5 -50.
    await page.evaluate(({ key, goalId, dates }) => {
      const x=JSON.parse(localStorage.getItem(key));
      const txs=x.transactions.filter(t=>t.goalId===goalId);
      const ins=txs.filter(t=>t.type==='saving').sort((a,b)=>a.id.localeCompare(b.id));
      const out=txs.find(t=>t.type==='saving_out');
      ins[0].date=dates.first; ins[1].date=dates.second; out.date=dates.withdrawal;
      const g=x.goals.find(v=>v.id===goalId); g.interestStartDate=dates.first;
      localStorage.setItem(key,JSON.stringify(x));
    }, { key: KEY, goalId: goal.id, dates });
    await page.reload();

    function expectedBalance(start, end, txs) {
      let balance=0;
      const d=new Date(start+'T00:00:00Z'), last=new Date(end+'T00:00:00Z');
      while(d<=last) {
        balance=Math.max(0,balance)*(1+0.0088/365);
        const key=d.toISOString().slice(0,10);
        for(const t of txs.filter(v=>v.date===key)) balance += t.type==='saving'?t.amount:-t.amount;
        d.setUTCDate(d.getUTCDate()+1);
      }
      return Math.max(0,balance);
    }
    const endDate=await page.evaluate(()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')});
    d=await state(page); goal=d.goals.find(g=>g.id===goal.id);
    let txs=d.transactions.filter(t=>t.goalId===goal.id && ['saving','saving_out'].includes(t.type));
    let expected=expectedBalance(dates.first,endDate,txs);
    assert.ok(Math.abs(goal.saved-expected)<0.00001,'initial multi-date balance mismatch: expected '+expected+', got '+goal.saved);
    assert.match(await accountBalanceText(page),/250\.00 GC/);

    // Edit the second transfer's date using the actual transaction editor prompt flow.
    const secondTx=txs.filter(t=>t.type==='saving').find(t=>t.amount===200);
    await go(page,'records');
    const promptValues=['Second transfer rescheduled','200',dates.editSecond,'Savings'];
    page.on('dialog',async dialog=>{
      if(dialog.type()==='prompt') await dialog.accept(promptValues.shift() ?? '');
      else await dialog.accept();
    });
    await page.locator('#alltx [data-edit-tx="'+secondTx.id+'"]').click();
    await page.reload();
    d=await state(page); goal=d.goals.find(g=>g.id===goal.id);
    txs=d.transactions.filter(t=>t.goalId===goal.id && ['saving','saving_out'].includes(t.type));
    expected=expectedBalance(dates.first,endDate,txs);
    assert.equal(txs.find(t=>t.id===secondTx.id).date,dates.editSecond);
    assert.ok(Math.abs(goal.saved-expected)<0.00001,'edited date should recalculate historical interest: expected '+expected+', got '+goal.saved);
    assert.match(await accountBalanceText(page),/250\.00 GC/);

    // Delete the first 100 GC transfer and verify the remaining 200 GC transfer and 50 GC withdrawal.
    await go(page,'records');
    const firstTx=txs.find(t=>t.type==='saving' && t.amount===100);
    await page.locator('#alltx [data-del-tx="'+firstTx.id+'"]').click();
    await page.reload();
    d=await state(page); goal=d.goals.find(g=>g.id===goal.id);
    txs=d.transactions.filter(t=>t.goalId===goal.id && ['saving','saving_out'].includes(t.type));
    expected=expectedBalance(dates.first,endDate,txs);
    assert.equal(d.transactions.some(t=>t.id===firstTx.id),false);
    assert.ok(Math.abs(goal.saved-expected)<0.00001,'after deleting first transfer, interest should recalculate from remaining ledger: expected '+expected+', got '+goal.saved);
    assert.ok(Math.abs(goal.saved)>0,'remaining transfer should leave a positive fund balance after partial withdrawal');
    assert.match(await accountBalanceText(page),/350\.00 GC/);
    assert.match(await page.locator('#allgoals').innerText(),/Fund balance/);
    await context.close();
    return '100→200 GC dated transfers and 50 GC partial withdrawal; date edit recomputed daily compounding; deleting first transfer recalculated goal balance while account balance reconciled 500→250→350 GC';
  });


  await run('Mobile and tablet layouts have no page-level horizontal overflow and key controls remain usable', async browser => {
    const { page, context } = await freshPage(browser, { budget: 700, openingBalance: 500, monthlyManual: {}, transactions: [], goals: [], fixedDeposits: [], xp: 0, answered: [] });
    const results=[];
    for (const width of [360,390,430,768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#homemetrics');
      const home=await page.evaluate(() => ({
        width:innerWidth, documentWidth:document.documentElement.scrollWidth,
        bodyWidth:document.body.scrollWidth,
        app:document.querySelector('.app')?.getBoundingClientRect().width,
        nav:document.querySelector('.main-nav')?.getBoundingClientRect().width,
        metrics:document.querySelector('#homemetrics')?.getBoundingClientRect().width,
        visibleNav:!!document.querySelector('.main-nav .nav-link'),
        balance:!!document.querySelector('#homeactualbalance')
      }));
      assert.ok(home.documentWidth <= width + 1, width+'px home has document horizontal overflow: '+JSON.stringify(home));
      assert.ok(home.bodyWidth <= width + 1, width+'px body has horizontal overflow: '+JSON.stringify(home));
      assert.ok(home.nav <= width + 1, width+'px navigation exceeds viewport');
      assert.ok(home.visibleNav && home.balance, width+'px core home controls should be visible');

      for (const view of ['save','records','fd']) {
        const navLink=page.locator('[data-view="'+view+'"]').first();
        if (await navLink.count()) {
          await navLink.click();
          await page.waitForTimeout(50);
          const check=await page.evaluate(() => ({
            width:innerWidth, documentWidth:document.documentElement.scrollWidth,
            bodyWidth:document.body.scrollWidth,
            active:document.querySelector('.view.active')?.getAttribute('id') || document.querySelector('.view:not([hidden])')?.getAttribute('id'),
            controls:[...document.querySelectorAll('.view.active button,.view.active input,.view.active select,.view.active textarea')]
              .filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName,h:Math.round(e.getBoundingClientRect().height),w:Math.round(e.getBoundingClientRect().width)}))
          }));
          assert.ok(check.documentWidth <= width + 1, width+'px '+view+' view has document overflow: '+JSON.stringify(check));
          assert.ok(check.bodyWidth <= width + 1, width+'px '+view+' view has body overflow: '+JSON.stringify(check));
          assert.ok(check.controls.every(c=>c.h >= 30), width+'px '+view+' view has tiny touch controls: '+JSON.stringify(check.controls.filter(c=>c.h<30)));
        }
      }
      results.push(width+'px viewport: no page-level horizontal overflow; home, savings, transactions, and fixed deposit controls rendered');
    }
    await context.close();
    return results.join('; ');
  });

  if (process.exitCode) process.exit(1);
  console.log('All Money Life browser financial logic tests passed.');
})();
