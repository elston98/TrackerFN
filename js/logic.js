/*
 * Pure calculation helpers for TrackerFN.
 * No DOM access here so the logic can be unit-tested with Node.
 */
(function (root) {
  'use strict';

  const ACCOUNT_TYPES = ['Savings', 'Salary', 'Current', 'Other'];
  const SAVINGS_TYPES = [
    'Mutual Fund',
    'Fixed Deposit',
    'Recurring Deposit',
    'Provident Fund',
    'Other',
  ];
  // Life insurance is protection, not an asset: tracked by sum insured and
  // premium, and excluded from net worth and milestone allocation.
  const INSURANCE_TYPES = ['Term Life', 'Endowment', 'Money Back', 'ULIP', 'Whole Life', 'Other'];
  const PREMIUM_FREQUENCIES = { Monthly: 12, Quarterly: 4, 'Half-yearly': 2, Yearly: 1, Single: 0 };
  const LOAN_TYPES = ['Home Loan', 'Credit Card EMI', 'Personal Loan', 'Car Loan', 'Other'];
  const PRIORITIES = ['High', 'Medium', 'Low'];

  function todayISO(d) {
    const dt = d || new Date();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${dt.getFullYear()}-${m}-${day}`;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function emptyState() {
    return {
      version: 1,
      settings: { currency: 'INR' },
      accounts: [],
      savings: [],
      insurance: [],
      loans: [],
      milestones: [],
    };
  }

  /* ---------------- Accounts ---------------- */

  // Entries are applied in date order (ties broken by creation sequence).
  // kind: 'set' (balance snapshot), 'credit' (+amount), 'debit' (-amount)
  function sortedEntries(account) {
    return [...(account.entries || [])].sort((a, b) =>
      a.date === b.date ? num(a.seq) - num(b.seq) : a.date < b.date ? -1 : 1
    );
  }

  function applyEntry(balance, entry) {
    const amt = num(entry.amount);
    if (entry.kind === 'set') return amt;
    if (entry.kind === 'debit') return balance - amt;
    return balance + amt;
  }

  // Returns entries (sorted) annotated with running balance.
  function accountHistory(account) {
    let bal = 0;
    return sortedEntries(account).map((e) => {
      bal = applyEntry(bal, e);
      return { ...e, balance: bal };
    });
  }

  // Balance as of a date (inclusive). Defaults to today, so future-dated
  // entries are treated as scheduled and do not affect the latest balance.
  function accountBalance(account, asOf) {
    const cutoff = asOf || todayISO();
    let bal = 0;
    for (const e of sortedEntries(account)) {
      if (e.date > cutoff) break;
      bal = applyEntry(bal, e);
    }
    return bal;
  }

  function lastUpdated(account, asOf) {
    const cutoff = asOf || todayISO();
    const past = sortedEntries(account).filter((e) => e.date <= cutoff);
    return past.length ? past[past.length - 1].date : null;
  }

  function nextSeq(account) {
    return (account.entries || []).reduce((m, e) => Math.max(m, num(e.seq)), 0) + 1;
  }

  /* ---------------- Savings ---------------- */

  function savingsGain(inv) {
    return num(inv.currentValue) - num(inv.invested);
  }

  function savingsByType(savings) {
    const out = {};
    for (const t of SAVINGS_TYPES) out[t] = { count: 0, invested: 0, value: 0 };
    for (const s of savings) {
      const bucket = out[s.type] || (out[s.type] = { count: 0, invested: 0, value: 0 });
      bucket.count += 1;
      bucket.invested += num(s.invested);
      bucket.value += num(s.currentValue);
    }
    return out;
  }

  /* ---------------- Life insurance ---------------- */

  function annualPremium(policy) {
    const perYear = PREMIUM_FREQUENCIES[policy.premiumFrequency];
    return num(policy.premium) * (perYear == null ? 1 : perYear);
  }

  function policyActive(policy, asOf) {
    return !policy.endDate || policy.endDate >= (asOf || todayISO());
  }

  function insuranceTotals(policies, asOf) {
    const active = (policies || []).filter((p) => policyActive(p, asOf));
    return {
      count: active.length,
      sumInsured: active.reduce((s, p) => s + num(p.sumInsured), 0),
      annualPremium: active.reduce((s, p) => s + annualPremium(p), 0),
    };
  }

  /* ---------------- Loans / EMIs ---------------- */

  function monthsBetween(fromISO, toISO) {
    if (!fromISO || !toISO) return 0;
    const [fy, fm, fd] = fromISO.split('-').map(Number);
    const [ty, tm, td] = toISO.split('-').map(Number);
    let months = (ty - fy) * 12 + (tm - fm);
    if (td < fd) months -= 1;
    return months;
  }

  function addMonths(iso, months) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1 + num(months), 1);
    const lastDay = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    dt.setDate(Math.min(d, lastDay));
    return todayISO(dt);
  }

  function loanEndDate(loan) {
    if (loan.startDate && num(loan.tenureMonths) > 0) {
      return addMonths(loan.startDate, num(loan.tenureMonths));
    }
    return '';
  }

  function emisRemaining(loan, asOf) {
    const end = loanEndDate(loan);
    if (!end) return null;
    return Math.max(0, monthsBetween(asOf || todayISO(), end));
  }

  function openLoans(loans) {
    return loans.filter((l) => l.status !== 'closed');
  }

  function loanTotals(loans) {
    const open = openLoans(loans);
    return {
      count: open.length,
      outstanding: open.reduce((s, l) => s + num(l.outstanding), 0),
      monthlyEmi: open.reduce((s, l) => s + num(l.emi), 0),
    };
  }

  /* ---------------- Milestones & allocation ---------------- */

  // A "source" is something whose balance can be earmarked for goals:
  // every savings instrument plus every account of type "Savings".
  function allocationSources(state, asOf) {
    const sources = [];
    for (const s of state.savings) {
      sources.push({
        key: 'inv:' + s.id,
        label: s.name,
        group: s.type,
        value: num(s.currentValue),
      });
    }
    for (const a of state.accounts) {
      if (a.type !== 'Savings') continue;
      sources.push({
        key: 'acc:' + a.id,
        label: a.name,
        group: 'Savings Account',
        value: accountBalance(a, asOf),
      });
    }
    return sources;
  }

  function allocatedFromSource(state, key, excludeMilestoneId) {
    let total = 0;
    for (const m of state.milestones) {
      if (m.id === excludeMilestoneId) continue;
      total += num((m.allocations || {})[key]);
    }
    return total;
  }

  function sourceSummary(state, asOf) {
    return allocationSources(state, asOf).map((src) => {
      const allocated = allocatedFromSource(state, src.key);
      return {
        ...src,
        allocated,
        free: src.value - allocated,
        overAllocated: allocated > src.value + 0.005,
      };
    });
  }

  function milestoneAllocated(m) {
    return Object.values(m.allocations || {}).reduce((s, v) => s + num(v), 0);
  }

  function milestoneStats(m, asOf) {
    const today = asOf || todayISO();
    const target = num(m.target);
    const allocated = milestoneAllocated(m);
    const remaining = Math.max(0, target - allocated);
    const progress = target > 0 ? Math.min(100, (allocated / target) * 100) : 0;
    let monthsLeft = null;
    let monthlyNeeded = null;
    if (m.targetDate) {
      monthsLeft = Math.max(0, monthsBetween(today, m.targetDate));
      monthlyNeeded = remaining > 0 ? remaining / Math.max(1, monthsLeft) : 0;
    }
    const overdue = !!m.targetDate && m.targetDate < today && remaining > 0;
    return { target, allocated, remaining, progress, monthsLeft, monthlyNeeded, achieved: remaining <= 0 && target > 0, overdue };
  }

  function priorityRank(p) {
    const i = PRIORITIES.indexOf(p);
    return i === -1 ? PRIORITIES.length : i;
  }

  // Distributes currently unallocated money across milestones that still
  // need funds: highest priority first, then nearest target date.
  // Returns a new milestones array; does not mutate input.
  function autoAllocate(state, asOf) {
    const milestones = state.milestones.map((m) => ({ ...m, allocations: { ...(m.allocations || {}) } }));
    const free = {};
    for (const s of sourceSummary(state, asOf)) free[s.key] = Math.max(0, s.free);
    const order = [...milestones].sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr) return pr;
      const ad = a.targetDate || '9999-12-31';
      const bd = b.targetDate || '9999-12-31';
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });
    for (const m of order) {
      let need = num(m.target) - milestoneAllocated(m);
      for (const key of Object.keys(free)) {
        if (need <= 0) break;
        const take = Math.min(need, free[key]);
        if (take <= 0) continue;
        m.allocations[key] = num(m.allocations[key]) + take;
        free[key] -= take;
        need -= take;
      }
    }
    return milestones;
  }

  // Removes allocations pointing at a source that no longer exists.
  function pruneAllocations(state) {
    const valid = new Set(allocationSources(state).map((s) => s.key));
    for (const m of state.milestones) {
      for (const key of Object.keys(m.allocations || {})) {
        if (!valid.has(key) || num(m.allocations[key]) <= 0) delete m.allocations[key];
      }
    }
  }

  /* ---------------- Summary ---------------- */

  function summary(state, asOf) {
    const accountsTotal = state.accounts.reduce((s, a) => s + accountBalance(a, asOf), 0);
    const savingsTotal = state.savings.reduce((s, i) => s + num(i.currentValue), 0);
    const loans = loanTotals(state.loans);
    const sources = sourceSummary(state, asOf);
    const allocatable = sources.reduce((s, x) => s + x.value, 0);
    const allocated = sources.reduce((s, x) => s + x.allocated, 0);
    return {
      accountsTotal,
      savingsTotal,
      loanOutstanding: loans.outstanding,
      monthlyEmi: loans.monthlyEmi,
      openLoanCount: loans.count,
      netWorth: accountsTotal + savingsTotal - loans.outstanding,
      allocatable,
      allocated,
      unallocated: allocatable - allocated,
    };
  }

  const api = {
    ACCOUNT_TYPES,
    SAVINGS_TYPES,
    INSURANCE_TYPES,
    PREMIUM_FREQUENCIES,
    LOAN_TYPES,
    PRIORITIES,
    todayISO,
    uid,
    num,
    emptyState,
    accountHistory,
    accountBalance,
    lastUpdated,
    nextSeq,
    savingsGain,
    savingsByType,
    annualPremium,
    policyActive,
    insuranceTotals,
    monthsBetween,
    addMonths,
    loanEndDate,
    emisRemaining,
    openLoans,
    loanTotals,
    allocationSources,
    allocatedFromSource,
    sourceSummary,
    milestoneAllocated,
    milestoneStats,
    autoAllocate,
    pruneAllocations,
    summary,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof window !== 'undefined' ? window : globalThis);
