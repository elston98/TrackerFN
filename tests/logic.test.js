// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');

function account(entries, type = 'Savings') {
  return { id: 'a1', name: 'Acc', type, entries: entries.map((e, i) => ({ id: 'e' + i, seq: i + 1, ...e })) };
}

test('account balance applies set/credit/debit in date order', () => {
  const a = account([
    { date: '2026-03-01', kind: 'credit', amount: 500 },
    { date: '2026-01-01', kind: 'set', amount: 1000 },
    { date: '2026-02-01', kind: 'debit', amount: 200 },
  ]);
  assert.equal(L.accountBalance(a, '2026-01-15'), 1000);
  assert.equal(L.accountBalance(a, '2026-02-01'), 800);
  assert.equal(L.accountBalance(a, '2026-12-31'), 1300);
  assert.deepEqual(L.accountHistory(a).map((e) => e.balance), [1000, 800, 1300]);
});

test('set entry resets balance; same-day entries use creation order', () => {
  const a = account([
    { date: '2026-01-01', kind: 'set', amount: 1000 },
    { date: '2026-02-01', kind: 'credit', amount: 50 },
    { date: '2026-02-01', kind: 'set', amount: 5000 },
    { date: '2026-02-01', kind: 'debit', amount: 100 },
  ]);
  assert.equal(L.accountBalance(a, '2026-02-01'), 4900);
});

test('future-dated entries are excluded from latest balance', () => {
  const a = account([
    { date: '2026-01-01', kind: 'set', amount: 100 },
    { date: '2099-01-01', kind: 'credit', amount: 999 },
  ]);
  assert.equal(L.accountBalance(a, '2026-06-01'), 100);
  assert.equal(L.lastUpdated(a, '2026-06-01'), '2026-01-01');
});

test('loan end date, EMIs remaining and totals', () => {
  const loan = { startDate: '2026-01-15', tenureMonths: 12, emi: 1000, outstanding: 9000, status: 'open' };
  assert.equal(L.loanEndDate(loan), '2027-01-15');
  assert.equal(L.emisRemaining(loan, '2026-07-15'), 6);
  assert.equal(L.addMonths('2026-01-31', 1), '2026-02-28');
  const totals = L.loanTotals([loan, { ...loan, status: 'closed' }]);
  assert.deepEqual(totals, { count: 1, outstanding: 9000, monthlyEmi: 1000 });
});

function sampleState() {
  const s = L.emptyState();
  s.accounts = [account([{ date: '2026-01-01', kind: 'set', amount: 100 }]), { ...account([{ date: '2026-01-01', kind: 'set', amount: 999 }], 'Salary'), id: 'a2' }];
  s.savings = [{ id: 'fd', type: 'Fixed Deposit', name: 'FD', currentValue: 300, invested: 250 }];
  s.milestones = [
    { id: 'm1', name: 'Low goal', target: 1000, priority: 'Low', allocations: {} },
    { id: 'm2', name: 'High goal', target: 250, priority: 'High', targetDate: '2027-01-01', allocations: {} },
  ];
  return s;
}

test('allocation sources include savings + savings-type accounts only', () => {
  const s = sampleState();
  const keys = L.allocationSources(s, '2026-06-01').map((x) => x.key).sort();
  assert.deepEqual(keys, ['acc:a1', 'inv:fd']);
});

test('auto-allocate funds higher priority first and never exceeds sources', () => {
  const s = sampleState();
  s.milestones = L.autoAllocate(s, '2026-06-01');
  const m2 = s.milestones.find((m) => m.id === 'm2');
  const m1 = s.milestones.find((m) => m.id === 'm1');
  assert.equal(L.milestoneAllocated(m2), 250);
  assert.equal(L.milestoneAllocated(m1), 150); // remaining of 400 pool
  const sum = L.summary(s, '2026-06-01');
  assert.equal(sum.allocatable, 400);
  assert.equal(sum.unallocated, 0);
  for (const src of L.sourceSummary(s, '2026-06-01')) assert.ok(!src.overAllocated);
});

test('milestone stats and over-allocation detection', () => {
  const s = sampleState();
  s.milestones[1].allocations = { 'inv:fd': 500 };
  const src = L.sourceSummary(s, '2026-06-01').find((x) => x.key === 'inv:fd');
  assert.ok(src.overAllocated);
  const st = L.milestoneStats({ target: 1200, targetDate: '2027-01-01', allocations: { x: 600 } }, '2026-07-01');
  assert.equal(st.progress, 50);
  assert.equal(st.monthsLeft, 6);
  assert.equal(st.monthlyNeeded, 100);
});

test('pruneAllocations drops allocations for deleted sources', () => {
  const s = sampleState();
  s.milestones[0].allocations = { 'inv:fd': 100, 'inv:gone': 50 };
  L.pruneAllocations(s);
  assert.deepEqual(s.milestones[0].allocations, { 'inv:fd': 100 });
});

test('summary net worth = accounts + savings - open loans', () => {
  const s = sampleState();
  s.loans = [{ id: 'l', status: 'open', outstanding: 400, emi: 10 }];
  const sum = L.summary(s, '2026-06-01');
  assert.equal(sum.netWorth, 100 + 999 + 300 - 400);
});

test('life insurance: annual premium and active cover totals', () => {
  assert.equal(L.annualPremium({ premium: 1000, premiumFrequency: 'Monthly' }), 12000);
  assert.equal(L.annualPremium({ premium: 5000, premiumFrequency: 'Half-yearly' }), 10000);
  assert.equal(L.annualPremium({ premium: 90000, premiumFrequency: 'Single' }), 0);
  const policies = [
    { sumInsured: 10000000, premium: 15000, premiumFrequency: 'Yearly', endDate: '2050-01-01' },
    { sumInsured: 500000, premium: 2000, premiumFrequency: 'Monthly', endDate: '2020-01-01' }, // expired
  ];
  assert.deepEqual(L.insuranceTotals(policies, '2026-06-01'), { count: 1, sumInsured: 10000000, annualPremium: 15000 });
  assert.ok(!L.SAVINGS_TYPES.includes('Life Insurance'));
});

test('life insurance is excluded from net worth and allocation pool', () => {
  const s = sampleState();
  const before = L.summary(s, '2026-06-01');
  s.insurance = [{ id: 'p1', policyType: 'Term Life', name: 'Term', sumInsured: 10000000, premium: 12000, premiumFrequency: 'Yearly' }];
  const after = L.summary(s, '2026-06-01');
  assert.deepEqual(after, before);
  assert.ok(!L.allocationSources(s, '2026-06-01').some((x) => x.key.endsWith('p1')));
});
