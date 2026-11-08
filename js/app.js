/* TrackerFN – UI layer. All data lives in localStorage. */
(function () {
  'use strict';

  const L = window.Logic;
  const STORAGE_KEY = 'trackerfn:v1';
  const CHART_COLORS = ['#3a5bd9', '#1f9d63', '#c98a0a', '#9b4dca', '#d6453d', '#0f9bb5', '#e0699f', '#6b8e23'];

  let state = load();
  let currentTab = 'dashboard';

  /* ================= Persistence ================= */

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) {
      console.warn('Could not read saved data', e);
    }
    return L.emptyState();
  }

  function normalize(data) {
    const base = L.emptyState();
    const s = { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) } };
    for (const k of ['accounts', 'savings', 'loans', 'milestones']) if (!Array.isArray(s[k])) s[k] = [];
    s.accounts.forEach((a) => { if (!Array.isArray(a.entries)) a.entries = []; });
    s.milestones.forEach((m) => { if (!m.allocations || typeof m.allocations !== 'object') m.allocations = {}; });
    return s;
  }

  function save() {
    L.pruneAllocations(state);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      alert('Could not save data: ' + e.message);
    }
    render();
  }

  /* ================= Helpers ================= */

  const $ = (sel, el = document) => el.querySelector(sel);

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(n, opts = {}) {
    const cur = state.settings.currency || 'INR';
    const locale = cur === 'INR' ? 'en-IN' : undefined;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: cur,
      maximumFractionDigits: opts.decimals ?? 0,
      minimumFractionDigits: 0,
    }).format(L.num(n));
  }

  function signedMoney(n) {
    const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : '';
    return `<span class="${cls}">${n > 0 ? '+' : ''}${money(n)}</span>`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function find(list, id) {
    return state[list].find((x) => x.id === id);
  }

  function sourceLabel(key) {
    const src = L.allocationSources(state).find((s) => s.key === key);
    return src ? `${src.label} (${src.group})` : 'Removed source';
  }

  /* ================= Modal / forms ================= */

  const modal = $('#modal');
  let modalSubmitHandler = null;

  function openModal({ title, body, submitLabel = 'Save', onSubmit, onOpen }) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    $('#modalError').textContent = '';
    $('#modalSubmit').textContent = submitLabel;
    modalSubmitHandler = onSubmit;
    modal.showModal();
    if (onOpen) onOpen($('#modalBody'));
    const first = $('#modalBody input, #modalBody select, #modalBody textarea');
    if (first) first.focus();
  }

  function closeModal() {
    modal.close();
    modalSubmitHandler = null;
  }

  $('#modalForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!modalSubmitHandler) return closeModal();
    const err = modalSubmitHandler($('#modalBody'));
    if (err) {
      $('#modalError').textContent = err;
      return;
    }
    closeModal();
    save();
  });

  function fieldHTML(f, value) {
    const v = value ?? f.default ?? '';
    const req = f.required ? 'required' : '';
    let input;
    if (f.type === 'select') {
      input = `<select name="${f.name}" ${req}>${f.options
        .map((o) => {
          const [val, label] = Array.isArray(o) ? o : [o, o];
          return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
        })
        .join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea name="${f.name}" rows="2" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
    } else {
      const extra = f.type === 'number' ? `step="${f.step || 'any'}" ${f.min != null ? `min="${f.min}"` : ''}` : '';
      input = `<input type="${f.type || 'text'}" name="${f.name}" value="${esc(v)}" ${req} ${extra} placeholder="${esc(f.placeholder || '')}" />`;
    }
    return `<div class="field ${f.full ? 'full' : ''}"><label>${esc(f.label)}${f.required ? ' *' : ''}</label>${input}${
      f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''
    }</div>`;
  }

  function openForm({ title, fields, values = {}, submitLabel, onSubmit }) {
    openModal({
      title,
      submitLabel,
      body: `<div class="form-grid">${fields.map((f) => fieldHTML(f, values[f.name])).join('')}</div>`,
      onSubmit: (body) => {
        const out = {};
        for (const f of fields) {
          const el = body.querySelector(`[name="${f.name}"]`);
          let val = el.value.trim();
          if (f.type === 'number') val = val === '' ? '' : Number(val);
          out[f.name] = val;
        }
        return onSubmit(out);
      },
    });
  }

  /* ================= Rendering ================= */

  const view = $('#view');

  function render() {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
    $('#currency').value = state.settings.currency;
    const renderers = { dashboard: renderDashboard, accounts: renderAccounts, savings: renderSavings, loans: renderLoans, milestones: renderMilestones };
    view.innerHTML = renderers[currentTab]();
  }

  function kpi(label, value, sub, cls = '') {
    return `<div class="card kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }

  /* ---------- Dashboard ---------- */

  function renderDashboard() {
    const s = L.summary(state);
    const isEmpty = !state.accounts.length && !state.savings.length && !state.loans.length && !state.milestones.length;

    let html = `<div class="section-head"><h1>Dashboard</h1><span class="muted small">As of ${fmtDate(L.todayISO())}</span></div>`;

    if (isEmpty) {
      html += `<div class="card empty">
        <h2>Welcome to TrackerFN</h2>
        <p>Add your bank accounts, savings, loans and goals to get started — or explore with sample data.</p>
        <p><button class="primary" data-action="go" data-tab="accounts">Add an account</button>
        <button data-action="load-sample">Load sample data</button></p>
      </div>`;
      return html;
    }

    html += `<div class="grid kpis">
      ${kpi('Net worth', money(s.netWorth), 'Accounts + savings − loans', s.netWorth < 0 ? 'neg' : '')}
      ${kpi('Account balance', money(s.accountsTotal), `${state.accounts.length} account(s)`)}
      ${kpi('Savings & investments', money(s.savingsTotal), `${state.savings.length} instrument(s)`)}
      ${kpi('Loan outstanding', money(s.loanOutstanding), `EMI ${money(s.monthlyEmi)}/month · ${s.openLoanCount} open`, s.loanOutstanding ? 'neg' : '')}
      ${kpi('Unallocated savings', money(s.unallocated), `${money(s.allocated)} earmarked for goals`, s.unallocated < 0 ? 'neg' : '')}
    </div>`;

    // Accounts + milestones
    html += `<div class="grid two" style="margin-top:16px">`;
    html += `<div class="card"><div class="section-head"><h2>Accounts – latest balance</h2><button class="sm" data-action="go" data-tab="accounts">Manage</button></div>`;
    if (state.accounts.length) {
      html += `<div class="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Updated</th><th class="right">Balance</th></tr></thead><tbody>`;
      for (const a of state.accounts) {
        html += `<tr><td>${esc(a.name)}<div class="muted small">${esc(a.bank || '')}</div></td><td><span class="badge">${esc(a.type)}</span></td>
          <td class="small muted nowrap">${fmtDate(L.lastUpdated(a))}</td><td class="right"><b>${money(L.accountBalance(a))}</b></td></tr>`;
      }
      html += `</tbody><tfoot><tr><td colspan="3">Total</td><td class="right">${money(s.accountsTotal)}</td></tr></tfoot></table></div>`;
    } else html += `<div class="empty">No accounts yet.</div>`;
    html += `</div>`;

    html += `<div class="card"><div class="section-head"><h2>Milestones</h2><button class="sm" data-action="go" data-tab="milestones">Manage</button></div>`;
    if (state.milestones.length) {
      for (const m of state.milestones) {
        const st = L.milestoneStats(m);
        html += `<div style="margin-bottom:14px">
          <div class="item-head"><b>${esc(m.name)}</b><span class="small muted">${money(st.allocated)} / ${money(st.target)}</span></div>
          <div class="progress ${st.achieved ? 'good' : st.overdue ? 'warn' : ''}"><div style="width:${st.progress.toFixed(1)}%"></div></div>
          <div class="small muted">${st.progress.toFixed(0)}% · ${m.targetDate ? 'by ' + fmtDate(m.targetDate) : 'no target date'}${
          st.achieved ? ' · <span class="pos">Funded</span>' : ''
        }</div></div>`;
      }
      html += allocationBar(s);
    } else html += `<div class="empty">No milestones yet.</div>`;
    html += `</div></div>`;

    // Savings by type + loans
    html += `<div class="grid two" style="margin-top:16px">`;
    const byType = L.savingsByType(state.savings);
    html += `<div class="card"><div class="section-head"><h2>Savings by type</h2><button class="sm" data-action="go" data-tab="savings">Manage</button></div>
      <div class="table-wrap"><table><thead><tr><th>Type</th><th class="right">Invested</th><th class="right">Current value</th></tr></thead><tbody>`;
    for (const [type, b] of Object.entries(byType)) {
      html += `<tr><td>${esc(type)} <span class="muted small">(${b.count})</span></td><td class="right">${money(b.invested)}</td><td class="right"><b>${money(b.value)}</b></td></tr>`;
    }
    html += `</tbody><tfoot><tr><td>Total</td><td class="right">${money(state.savings.reduce((x, i) => x + L.num(i.invested), 0))}</td><td class="right">${money(s.savingsTotal)}</td></tr></tfoot></table></div></div>`;

    const open = L.openLoans(state.loans);
    html += `<div class="card"><div class="section-head"><h2>Open loans &amp; EMIs</h2><button class="sm" data-action="go" data-tab="loans">Manage</button></div>`;
    if (open.length) {
      html += `<div class="table-wrap"><table><thead><tr><th>Loan</th><th class="right">EMI</th><th class="right">Outstanding</th><th class="right">EMIs left</th></tr></thead><tbody>`;
      for (const l of open) {
        const left = L.emisRemaining(l);
        html += `<tr><td>${esc(l.name)}<div class="muted small">${esc(l.type)}</div></td><td class="right">${money(l.emi)}</td><td class="right">${money(l.outstanding)}</td><td class="right">${left ?? '—'}</td></tr>`;
      }
      html += `</tbody><tfoot><tr><td>Total</td><td class="right">${money(s.monthlyEmi)}</td><td class="right">${money(s.loanOutstanding)}</td><td></td></tr></tfoot></table></div>`;
    } else html += `<div class="empty">No open loans or EMIs. 🎉</div>`;
    html += `</div></div>`;

    return html;
  }

  function allocationBar(s) {
    if (s.allocatable <= 0) return '';
    const base = Math.max(s.allocatable, s.allocated);
    let bars = '';
    let legend = '';
    state.milestones.forEach((m, i) => {
      const amt = L.milestoneAllocated(m);
      if (amt <= 0) return;
      const c = CHART_COLORS[i % CHART_COLORS.length];
      bars += `<div style="width:${((amt / base) * 100).toFixed(2)}%;background:${c}" title="${esc(m.name)}: ${money(amt)}"></div>`;
      legend += `<span><i style="background:${c}"></i>${esc(m.name)} ${money(amt)}</span>`;
    });
    if (s.unallocated > 0) legend += `<span><i style="background:var(--border)"></i>Unallocated ${money(s.unallocated)}</span>`;
    return `<h3 style="margin-top:18px">Savings allocation</h3><div class="stack-bar">${bars}</div><div class="legend">${legend}</div>`;
  }

  /* ---------- Accounts ---------- */

  function renderAccounts() {
    let html = `<div class="section-head"><div><h1>Accounts</h1><div class="muted small">Track balances by date. Latest balance = all updates up to today.</div></div>
      <button class="primary" data-action="add-account">+ Add account</button></div>`;
    if (!state.accounts.length) return html + `<div class="empty">No accounts yet. Add a savings or salary account to start tracking.</div>`;

    const today = L.todayISO();
    html += `<div class="grid cards">`;
    for (const a of state.accounts) {
      const hist = L.accountHistory(a);
      const future = hist.filter((e) => e.date > today).length;
      html += `<div class="card">
        <div class="item-head"><div><h3>${esc(a.name)}</h3><div class="muted small">${esc(a.bank || '')}</div></div><span class="badge">${esc(a.type)}</span></div>
        <div class="item-balance">${money(L.accountBalance(a))}</div>
        <div class="muted small">Last updated ${fmtDate(L.lastUpdated(a))}${future ? ` · ${future} future-dated entr${future > 1 ? 'ies' : 'y'}` : ''}</div>
        <div class="item-actions">
          <button class="sm primary" data-action="add-entry" data-id="${a.id}">Update balance</button>
          <button class="sm" data-action="edit-account" data-id="${a.id}">Edit</button>
          <button class="sm danger" data-action="delete-account" data-id="${a.id}">Delete</button>
        </div>
        <details class="history"><summary>History (${hist.length})</summary>
          <div class="table-wrap"><table><thead><tr><th>Date</th><th>Change</th><th class="right">Balance</th><th></th></tr></thead><tbody>
          ${hist
            .slice()
            .reverse()
            .map(
              (e) => `<tr class="${e.date > today ? 'future' : ''}"><td class="nowrap">${fmtDate(e.date)}${e.note ? `<div class="muted small">${esc(e.note)}</div>` : ''}</td>
              <td>${e.kind === 'set' ? `Set to ${money(e.amount)}` : signedMoney(e.kind === 'debit' ? -L.num(e.amount) : L.num(e.amount))}</td>
              <td class="right">${money(e.balance)}</td>
              <td class="actions"><button class="link sm" data-action="delete-entry" data-id="${a.id}" data-entry="${e.id}" title="Delete entry">✕</button></td></tr>`
            )
            .join('')}
          </tbody></table></div>
        </details>
      </div>`;
    }
    return html + `</div>`;
  }

  const accountFields = (isNew) => [
    { name: 'name', label: 'Account name', required: true, placeholder: 'e.g. HDFC Savings' },
    { name: 'type', label: 'Type', type: 'select', options: L.ACCOUNT_TYPES },
    { name: 'bank', label: 'Bank / notes', placeholder: 'optional' },
    ...(isNew
      ? [
          { name: 'opening', label: 'Opening balance', type: 'number', default: 0 },
          { name: 'date', label: 'As of date', type: 'date', default: L.todayISO() },
        ]
      : []),
  ];

  function addAccount() {
    openForm({
      title: 'Add account',
      fields: accountFields(true),
      onSubmit: (v) => {
        if (!v.name) return 'Name is required';
        const acc = { id: L.uid(), name: v.name, type: v.type, bank: v.bank, entries: [] };
        acc.entries.push({ id: L.uid(), seq: 1, date: v.date || L.todayISO(), kind: 'set', amount: L.num(v.opening), note: 'Opening balance' });
        state.accounts.push(acc);
      },
    });
  }

  function editAccount(id) {
    const a = find('accounts', id);
    openForm({
      title: 'Edit account',
      fields: accountFields(false),
      values: a,
      onSubmit: (v) => {
        if (!v.name) return 'Name is required';
        Object.assign(a, { name: v.name, type: v.type, bank: v.bank });
      },
    });
  }

  function addEntry(id) {
    const a = find('accounts', id);
    openForm({
      title: `Update balance – ${a.name}`,
      submitLabel: 'Add entry',
      fields: [
        { name: 'date', label: 'Date', type: 'date', required: true, default: L.todayISO() },
        { name: 'kind', label: 'Change type', type: 'select', options: [['credit', 'Credit (+ deposit)'], ['debit', 'Debit (− withdrawal)'], ['set', 'Set balance to']] },
        { name: 'amount', label: 'Amount', type: 'number', required: true, min: 0 },
        { name: 'note', label: 'Note', placeholder: 'e.g. Salary for Oct' },
      ],
      onSubmit: (v) => {
        if (!v.date) return 'Date is required';
        if (v.amount === '' || v.amount < 0) return 'Enter a valid amount';
        a.entries.push({ id: L.uid(), seq: L.nextSeq(a), date: v.date, kind: v.kind, amount: L.num(v.amount), note: v.note });
      },
    });
  }

  /* ---------- Savings ---------- */

  function renderSavings() {
    const byType = L.savingsByType(state.savings);
    const total = state.savings.reduce((x, i) => x + L.num(i.currentValue), 0);
    const invested = state.savings.reduce((x, i) => x + L.num(i.invested), 0);
    const allocBySource = Object.fromEntries(L.sourceSummary(state).map((s) => [s.key, s]));

    let html = `<div class="section-head"><div><h1>Savings &amp; Investments</h1><div class="muted small">Total value ${money(total)} · invested ${money(invested)} · gain ${signedMoney(total - invested)}</div></div>
      <button class="primary" data-action="add-savings">+ Add savings</button></div>`;

    html += `<div class="grid kpis">${L.SAVINGS_TYPES.map((t) => kpi(t, money(byType[t].value), `${byType[t].count} holding(s)`)).join('')}</div>`;

    for (const type of L.SAVINGS_TYPES) {
      const items = state.savings.filter((s) => s.type === type);
      html += `<div class="section-head"><h2 style="margin:0">${esc(type)}</h2><button class="sm" data-action="add-savings" data-type="${esc(type)}">+ Add ${esc(type)}</button></div>`;
      if (!items.length) {
        html += `<div class="empty small">No ${esc(type)} added.</div>`;
        continue;
      }
      html += `<div class="card table-wrap"><table><thead><tr><th>Name</th><th class="right">Invested</th><th class="right">Current value</th><th class="right">Gain</th>
        <th class="right">Rate</th><th class="right">Monthly</th><th>Maturity</th><th class="right">For goals</th><th></th></tr></thead><tbody>`;
      for (const s of items) {
        const src = allocBySource['inv:' + s.id];
        html += `<tr><td><b>${esc(s.name)}</b><div class="muted small">${esc(s.provider || '')}${s.updatedOn ? ' · value as of ' + fmtDate(s.updatedOn) : ''}</div></td>
          <td class="right">${money(s.invested)}</td><td class="right"><b>${money(s.currentValue)}</b></td><td class="right">${signedMoney(L.savingsGain(s))}</td>
          <td class="right">${s.rate !== '' && s.rate != null ? esc(s.rate) + '%' : '—'}</td>
          <td class="right">${L.num(s.monthly) ? money(s.monthly) : '—'}</td>
          <td class="nowrap">${fmtDate(s.maturityDate)}</td>
          <td class="right">${src && src.allocated ? `<span class="${src.overAllocated ? 'neg' : ''}">${money(src.allocated)}</span>` : '—'}</td>
          <td class="actions"><button class="sm" data-action="update-value" data-id="${s.id}">Update value</button>
            <button class="sm" data-action="edit-savings" data-id="${s.id}">Edit</button>
            <button class="sm danger" data-action="delete-savings" data-id="${s.id}">✕</button></td></tr>`;
      }
      html += `</tbody></table></div>`;
    }
    return html;
  }

  const savingsFields = [
    { name: 'type', label: 'Type', type: 'select', options: L.SAVINGS_TYPES },
    { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Axis Bluechip SIP' },
    { name: 'provider', label: 'Provider / bank', placeholder: 'optional' },
    { name: 'invested', label: 'Amount invested', type: 'number', min: 0, default: 0 },
    { name: 'currentValue', label: 'Current value', type: 'number', min: 0, required: true },
    { name: 'updatedOn', label: 'Value as of', type: 'date', default: L.todayISO() },
    { name: 'rate', label: 'Interest / return (% p.a.)', type: 'number', placeholder: 'optional' },
    { name: 'monthly', label: 'Monthly contribution', type: 'number', min: 0, hint: 'SIP / RD instalment / premium / PF contribution' },
    { name: 'startDate', label: 'Start date', type: 'date' },
    { name: 'maturityDate', label: 'Maturity date', type: 'date' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];

  function savingsForm(existing, presetType) {
    openForm({
      title: existing ? 'Edit savings' : 'Add savings',
      fields: savingsFields,
      values: existing || { type: presetType || L.SAVINGS_TYPES[0] },
      onSubmit: (v) => {
        if (!v.name) return 'Name is required';
        if (v.currentValue === '') v.currentValue = v.invested || 0;
        if (existing) Object.assign(existing, v);
        else state.savings.push({ id: L.uid(), ...v });
      },
    });
  }

  function updateValue(id) {
    const s = find('savings', id);
    openForm({
      title: `Update value – ${s.name}`,
      fields: [
        { name: 'currentValue', label: 'Current value', type: 'number', required: true, min: 0 },
        { name: 'invested', label: 'Total invested', type: 'number', min: 0 },
        { name: 'updatedOn', label: 'As of', type: 'date', default: L.todayISO() },
      ],
      values: { currentValue: s.currentValue, invested: s.invested, updatedOn: L.todayISO() },
      onSubmit: (v) => {
        if (v.currentValue === '') return 'Enter the current value';
        Object.assign(s, v);
      },
    });
  }

  /* ---------- Loans ---------- */

  function renderLoans() {
    const totals = L.loanTotals(state.loans);
    const open = L.openLoans(state.loans);
    const closed = state.loans.filter((l) => l.status === 'closed');

    let html = `<div class="section-head"><div><h1>Loans &amp; EMIs</h1><div class="muted small">Home loans, credit-card EMIs and other borrowings.</div></div>
      <div><button class="primary" data-action="add-loan" data-type="Home Loan">+ Home loan</button>
      <button class="primary" data-action="add-loan" data-type="Credit Card EMI">+ Credit card EMI</button>
      <button data-action="add-loan">+ Other</button></div></div>`;

    html += `<div class="grid kpis">
      ${kpi('Open loans', totals.count)}
      ${kpi('Total outstanding', money(totals.outstanding), '', totals.outstanding ? 'neg' : '')}
      ${kpi('Monthly EMI outgo', money(totals.monthlyEmi))}
      ${kpi('Home loans', money(open.filter((l) => l.type === 'Home Loan').reduce((x, l) => x + L.num(l.outstanding), 0)), `${open.filter((l) => l.type === 'Home Loan').length} open`)}
      ${kpi('Credit card EMIs', money(open.filter((l) => l.type === 'Credit Card EMI').reduce((x, l) => x + L.num(l.outstanding), 0)), `${open.filter((l) => l.type === 'Credit Card EMI').length} open`)}
    </div>`;

    html += `<div class="section-head"><h2 style="margin:0">Open</h2></div>`;
    if (open.length) {
      html += `<div class="card table-wrap"><table><thead><tr><th>Loan</th><th>Type</th><th class="right">Principal</th><th class="right">Outstanding</th>
        <th class="right">EMI</th><th class="right">Rate</th><th>Start</th><th>Ends</th><th class="right">EMIs left</th><th></th></tr></thead><tbody>`;
      for (const l of open) {
        const left = L.emisRemaining(l);
        const paid = L.num(l.principal) > 0 ? Math.min(100, (1 - L.num(l.outstanding) / L.num(l.principal)) * 100) : null;
        html += `<tr><td><b>${esc(l.name)}</b><div class="muted small">${esc(l.lender || '')}</div>
            ${paid != null ? `<div class="progress good" style="margin:4px 0 0;height:5px"><div style="width:${paid.toFixed(1)}%"></div></div><div class="muted small">${paid.toFixed(0)}% repaid</div>` : ''}</td>
          <td><span class="badge ${l.type === 'Credit Card EMI' ? 'warn' : ''}">${esc(l.type)}</span></td>
          <td class="right">${money(l.principal)}</td><td class="right"><b>${money(l.outstanding)}</b></td><td class="right">${money(l.emi)}</td>
          <td class="right">${l.rate !== '' && l.rate != null ? esc(l.rate) + '%' : '—'}</td>
          <td class="nowrap">${fmtDate(l.startDate)}</td><td class="nowrap">${fmtDate(L.loanEndDate(l))}</td>
          <td class="right">${left ?? '—'}${left === 0 ? ' <span class="badge good">due to close</span>' : ''}</td>
          <td class="actions"><button class="sm" data-action="edit-loan" data-id="${l.id}">Edit</button>
            <button class="sm danger" data-action="close-loan" data-id="${l.id}">Close</button></td></tr>`;
      }
      html += `</tbody><tfoot><tr><td colspan="3">Total</td><td class="right">${money(totals.outstanding)}</td><td class="right">${money(totals.monthlyEmi)}</td><td colspan="5"></td></tr></tfoot></table></div>`;
    } else html += `<div class="empty">No open loans or EMIs.</div>`;

    html += `<div class="section-head"><h2 style="margin:0">Closed (${closed.length})</h2></div>`;
    if (closed.length) {
      html += `<div class="card table-wrap"><table><thead><tr><th>Loan</th><th>Type</th><th class="right">Principal</th><th>Closed on</th><th></th></tr></thead><tbody>`;
      for (const l of closed) {
        html += `<tr><td>${esc(l.name)}<div class="muted small">${esc(l.lender || '')}</div></td><td><span class="badge grey">${esc(l.type)}</span></td>
          <td class="right">${money(l.principal)}</td><td>${fmtDate(l.closedDate)}</td>
          <td class="actions"><button class="sm" data-action="reopen-loan" data-id="${l.id}">Reopen</button>
            <button class="sm danger" data-action="delete-loan" data-id="${l.id}">Delete</button></td></tr>`;
      }
      html += `</tbody></table></div>`;
    } else html += `<div class="empty small">Closed loans will appear here.</div>`;
    return html;
  }

  const loanFields = [
    { name: 'type', label: 'Type', type: 'select', options: L.LOAN_TYPES },
    { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Flat in Pune / iPhone EMI' },
    { name: 'lender', label: 'Lender / card', placeholder: 'e.g. SBI / ICICI Amazon Pay' },
    { name: 'principal', label: 'Principal amount', type: 'number', min: 0 },
    { name: 'outstanding', label: 'Outstanding amount', type: 'number', min: 0, required: true },
    { name: 'emi', label: 'Monthly EMI', type: 'number', min: 0, required: true },
    { name: 'rate', label: 'Interest rate (% p.a.)', type: 'number' },
    { name: 'startDate', label: 'Start date', type: 'date' },
    { name: 'tenureMonths', label: 'Tenure (months)', type: 'number', min: 1, step: 1, hint: 'Used to compute end date and EMIs left' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];

  function loanForm(existing, presetType) {
    openForm({
      title: existing ? 'Edit loan / EMI' : `Add ${presetType || 'loan / EMI'}`,
      fields: loanFields,
      values: existing || { type: presetType || 'Other', startDate: L.todayISO() },
      onSubmit: (v) => {
        if (!v.name) return 'Name is required';
        if (v.outstanding === '' || v.emi === '') return 'Outstanding and EMI are required';
        if (existing) Object.assign(existing, v);
        else state.loans.push({ id: L.uid(), status: 'open', ...v });
      },
    });
  }

  function closeLoan(id) {
    const l = find('loans', id);
    openForm({
      title: `Close – ${l.name}`,
      submitLabel: 'Close loan',
      fields: [{ name: 'closedDate', label: 'Closed on', type: 'date', required: true, default: L.todayISO() }],
      onSubmit: (v) => {
        Object.assign(l, { status: 'closed', closedDate: v.closedDate, outstanding: 0 });
      },
    });
  }

  /* ---------- Milestones ---------- */

  function renderMilestones() {
    const sources = L.sourceSummary(state);
    const s = L.summary(state);

    let html = `<div class="section-head"><div><h1>Milestones</h1><div class="muted small">Earmark your savings towards goals. Allocatable pool = savings instruments + savings-type accounts.</div></div>
      <div><button data-action="auto-allocate" title="Distribute unallocated savings by priority and target date">Auto-allocate</button>
      <button data-action="clear-allocations">Clear allocations</button>
      <button class="primary" data-action="add-milestone">+ Add milestone</button></div></div>`;

    html += `<div class="grid kpis">
      ${kpi('Allocatable pool', money(s.allocatable), `${sources.length} source(s)`)}
      ${kpi('Allocated to goals', money(s.allocated))}
      ${kpi('Unallocated', money(s.unallocated), '', s.unallocated < 0 ? 'neg' : 'pos')}
      ${kpi('Goal targets', money(state.milestones.reduce((x, m) => x + L.num(m.target), 0)), `${state.milestones.length} milestone(s)`)}
    </div>`;

    const over = sources.filter((x) => x.overAllocated);
    if (over.length) {
      html += `<div class="callout" style="margin-top:16px">⚠ Over-allocated: ${over
        .map((x) => `${esc(x.label)} (${money(x.allocated)} allocated, value ${money(x.value)})`)
        .join('; ')}. Reduce allocations on the affected milestones.</div>`;
    }

    html += `<div class="section-head"><h2 style="margin:0">Goals</h2></div>`;
    if (!state.milestones.length) {
      html += `<div class="empty">No milestones yet. Add goals like "Emergency fund", "Child education" or "Home down payment".</div>`;
    } else {
      html += `<div class="grid cards">`;
      for (const m of state.milestones) {
        const st = L.milestoneStats(m);
        const prCls = m.priority === 'High' ? 'bad' : m.priority === 'Low' ? 'grey' : 'warn';
        const allocs = Object.entries(m.allocations || {}).filter(([, v]) => L.num(v) > 0);
        html += `<div class="card">
          <div class="item-head"><h3>${esc(m.name)}</h3><span class="badge ${prCls}">${esc(m.priority || 'Medium')}</span></div>
          <div class="item-balance">${money(st.allocated)} <span class="muted small" style="font-weight:400">of ${money(st.target)}</span></div>
          <div class="progress ${st.achieved ? 'good' : st.overdue ? 'warn' : ''}"><div style="width:${st.progress.toFixed(1)}%"></div></div>
          <div class="small">${st.progress.toFixed(0)}% funded ·
            ${st.achieved ? '<span class="pos">Goal fully funded 🎉</span>' : `${money(st.remaining)} to go`}</div>
          <div class="small muted">${m.targetDate ? `Target ${fmtDate(m.targetDate)}${st.overdue ? ' · <span class="neg">overdue</span>' : ` · ${st.monthsLeft} month(s) left`}` : 'No target date'}
            ${!st.achieved && st.monthlyNeeded ? ` · save ${money(st.monthlyNeeded)}/month` : ''}</div>
          ${m.notes ? `<div class="small muted" style="margin-top:6px">${esc(m.notes)}</div>` : ''}
          ${allocs.length ? `<ul class="alloc-list">${allocs.map(([k, v]) => `<li><span>${esc(sourceLabel(k))}</span><b>${money(v)}</b></li>`).join('')}</ul>` : '<div class="small muted" style="margin-top:8px">Nothing allocated yet.</div>'}
          <div class="item-actions">
            <button class="sm primary" data-action="allocate" data-id="${m.id}">Allocate savings</button>
            <button class="sm" data-action="edit-milestone" data-id="${m.id}">Edit</button>
            <button class="sm danger" data-action="delete-milestone" data-id="${m.id}">Delete</button>
          </div></div>`;
      }
      html += `</div>`;
    }

    html += `<div class="section-head"><h2 style="margin:0">Savings pool</h2></div>`;
    if (!sources.length) {
      html += `<div class="empty">Add savings instruments or a "Savings" type account to have money to allocate.</div>`;
    } else {
      html += `<div class="card table-wrap"><table><thead><tr><th>Source</th><th>Type</th><th class="right">Value</th><th class="right">Allocated</th><th class="right">Free</th></tr></thead><tbody>`;
      for (const x of sources) {
        html += `<tr><td>${esc(x.label)}</td><td><span class="badge">${esc(x.group)}</span></td><td class="right">${money(x.value)}</td>
          <td class="right">${money(x.allocated)}</td><td class="right ${x.free < 0 ? 'neg' : ''}"><b>${money(x.free)}</b></td></tr>`;
      }
      html += `</tbody><tfoot><tr><td colspan="2">Total</td><td class="right">${money(s.allocatable)}</td><td class="right">${money(s.allocated)}</td><td class="right">${money(s.unallocated)}</td></tr></tfoot></table></div>`;
    }
    return html;
  }

  const milestoneFields = [
    { name: 'name', label: 'Goal name', required: true, full: true, placeholder: 'e.g. Home down payment' },
    { name: 'target', label: 'Target amount', type: 'number', min: 0, required: true },
    { name: 'targetDate', label: 'Target date', type: 'date' },
    { name: 'priority', label: 'Priority', type: 'select', options: L.PRIORITIES, default: 'Medium' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];

  function milestoneForm(existing) {
    openForm({
      title: existing ? 'Edit milestone' : 'Add milestone',
      fields: milestoneFields,
      values: existing || {},
      onSubmit: (v) => {
        if (!v.name) return 'Name is required';
        if (!(v.target > 0)) return 'Target must be greater than zero';
        if (existing) Object.assign(existing, v);
        else state.milestones.push({ id: L.uid(), allocations: {}, ...v });
      },
    });
  }

  function allocateForm(id) {
    const m = find('milestones', id);
    const sources = L.allocationSources(state);
    if (!sources.length) {
      alert('Add a savings instrument or a "Savings" type account first.');
      return;
    }
    const rows = sources
      .map((src) => {
        const elsewhere = L.allocatedFromSource(state, src.key, m.id);
        const max = Math.max(0, src.value - elsewhere);
        const cur = L.num(m.allocations[src.key]);
        return `<div class="alloc-row">
          <div><div class="src-name">${esc(src.label)}</div><div class="src-meta">${esc(src.group)} · value ${money(src.value)} · available ${money(max)}</div></div>
          <input type="number" min="0" step="any" data-key="${esc(src.key)}" data-max="${max}" value="${cur || ''}" placeholder="0" />
        </div>`;
      })
      .join('');

    openModal({
      title: `Allocate savings – ${m.name}`,
      submitLabel: 'Save allocation',
      body: `<p class="small muted" style="margin-top:0">Target ${money(m.target)}. Enter how much of each source is earmarked for this goal.</p>
        ${rows}
        <div class="alloc-total"><span>Allocated</span><span id="allocTotal"></span></div>
        <p style="margin:10px 0 0"><button type="button" class="sm" id="allocFill">Fill remaining from available</button></p>`,
      onOpen: (body) => {
        const inputs = [...body.querySelectorAll('input[data-key]')];
        const update = () => {
          const t = inputs.reduce((x, i) => x + L.num(i.value), 0);
          $('#allocTotal', body).innerHTML = `${money(t)} / ${money(m.target)}${t > L.num(m.target) ? ' <span class="badge warn">exceeds target</span>' : ''}`;
        };
        inputs.forEach((i) => i.addEventListener('input', update));
        $('#allocFill', body).addEventListener('click', () => {
          let need = L.num(m.target) - inputs.reduce((x, i) => x + L.num(i.value), 0);
          for (const i of inputs) {
            if (need <= 0) break;
            const room = L.num(i.dataset.max) - L.num(i.value);
            const add = Math.min(room, need);
            if (add > 0) {
              i.value = Math.round((L.num(i.value) + add) * 100) / 100;
              need -= add;
            }
          }
          update();
        });
        update();
      },
      onSubmit: (body) => {
        const next = {};
        for (const i of body.querySelectorAll('input[data-key]')) {
          const v = L.num(i.value);
          if (v < 0) return 'Amounts cannot be negative';
          if (v > L.num(i.dataset.max) + 0.005) return `Only ${money(i.dataset.max, { decimals: 2 })} is available in one of the sources`;
          if (v > 0) next[i.dataset.key] = v;
        }
        m.allocations = next;
      },
    });
  }

  /* ================= Sample data ================= */

  function loadSample() {
    const t = L.todayISO();
    const ago = (months) => L.addMonths(t, -months);
    const acc = (name, type, bank, entries) => ({
      id: L.uid(), name, type, bank,
      entries: entries.map((e, i) => ({ id: L.uid(), seq: i + 1, ...e })),
    });
    const s = L.emptyState();
    s.accounts = [
      acc('Salary Account', 'Salary', 'HDFC Bank', [
        { date: ago(2), kind: 'set', amount: 45000, note: 'Opening balance' },
        { date: ago(1), kind: 'credit', amount: 150000, note: 'Salary' },
        { date: ago(1), kind: 'debit', amount: 110000, note: 'Expenses & EMIs' },
        { date: t, kind: 'credit', amount: 150000, note: 'Salary' },
      ]),
      acc('Savings Account', 'Savings', 'SBI', [
        { date: ago(3), kind: 'set', amount: 250000, note: 'Opening balance' },
        { date: ago(1), kind: 'credit', amount: 40000, note: 'Monthly transfer' },
      ]),
    ];
    const inv = (type, name, provider, invested, currentValue, extra = {}) => ({ id: L.uid(), type, name, provider, invested, currentValue, updatedOn: t, ...extra });
    s.savings = [
      inv('Mutual Fund', 'Nifty 50 Index Fund', 'UTI', 300000, 362000, { monthly: 15000, startDate: ago(24) }),
      inv('Mutual Fund', 'Flexi Cap Fund', 'Parag Parikh', 180000, 214000, { monthly: 10000, startDate: ago(18) }),
      inv('Fixed Deposit', 'FD 1 year', 'ICICI Bank', 200000, 207500, { rate: 7.1, startDate: ago(5), maturityDate: L.addMonths(t, 7) }),
      inv('Recurring Deposit', 'RD 24 months', 'SBI', 60000, 62300, { rate: 6.8, monthly: 5000, startDate: ago(12), maturityDate: L.addMonths(t, 12) }),
      inv('Life Insurance', 'Endowment Plan', 'LIC', 120000, 135000, { monthly: 4000, maturityDate: L.addMonths(t, 120) }),
      inv('Provident Fund', 'EPF', 'EPFO', 420000, 485000, { rate: 8.25, monthly: 7200 }),
      inv('Provident Fund', 'PPF', 'Post Office', 150000, 168000, { rate: 7.1 }),
    ];
    s.loans = [
      { id: L.uid(), status: 'open', type: 'Home Loan', name: 'Apartment', lender: 'SBI Home Loans', principal: 4500000, outstanding: 3820000, emi: 39500, rate: 8.5, startDate: ago(30), tenureMonths: 240 },
      { id: L.uid(), status: 'open', type: 'Credit Card EMI', name: 'Laptop', lender: 'HDFC Regalia', principal: 90000, outstanding: 45000, emi: 7800, rate: 14, startDate: ago(6), tenureMonths: 12 },
      { id: L.uid(), status: 'closed', type: 'Credit Card EMI', name: 'Phone', lender: 'ICICI Amazon Pay', principal: 60000, outstanding: 0, emi: 5200, startDate: ago(14), tenureMonths: 12, closedDate: ago(2) },
    ];
    s.milestones = [
      { id: L.uid(), name: 'Emergency fund', target: 600000, targetDate: L.addMonths(t, 6), priority: 'High', allocations: {} },
      { id: L.uid(), name: 'Car down payment', target: 400000, targetDate: L.addMonths(t, 18), priority: 'Medium', allocations: {} },
      { id: L.uid(), name: 'Child education', target: 2500000, targetDate: L.addMonths(t, 144), priority: 'Medium', allocations: {} },
      { id: L.uid(), name: 'Retirement corpus', target: 30000000, targetDate: L.addMonths(t, 300), priority: 'Low', allocations: {} },
    ];
    s.milestones = L.autoAllocate(s);
    state = s;
    save();
  }

  /* ================= Events ================= */

  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    currentTab = b.dataset.tab;
    render();
  });

  $('#currency').addEventListener('change', (e) => {
    state.settings.currency = e.target.value;
    save();
  });

  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object' || !('accounts' in data)) throw new Error('Not a TrackerFN backup');
        if (!confirm('Replace all current data with the imported backup?')) return;
        state = normalize(data);
        save();
      } catch (err) {
        alert('Import failed: ' + err.message);
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  });

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trackerfn-backup-${L.todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const actions = {
    go: (d) => { currentTab = d.tab; render(); },
    export: exportData,
    'load-sample': loadSample,
    'modal-cancel': closeModal,

    'add-account': addAccount,
    'edit-account': (d) => editAccount(d.id),
    'delete-account': (d) => {
      const a = find('accounts', d.id);
      if (confirm(`Delete account "${a.name}" and its history?`)) {
        state.accounts = state.accounts.filter((x) => x.id !== d.id);
        save();
      }
    },
    'add-entry': (d) => addEntry(d.id),
    'delete-entry': (d) => {
      const a = find('accounts', d.id);
      if (confirm('Delete this balance entry?')) {
        a.entries = a.entries.filter((e) => e.id !== d.entry);
        save();
      }
    },

    'add-savings': (d) => savingsForm(null, d.type),
    'edit-savings': (d) => savingsForm(find('savings', d.id)),
    'update-value': (d) => updateValue(d.id),
    'delete-savings': (d) => {
      const s = find('savings', d.id);
      if (confirm(`Delete "${s.name}"? Any goal allocations from it will be removed.`)) {
        state.savings = state.savings.filter((x) => x.id !== d.id);
        save();
      }
    },

    'add-loan': (d) => loanForm(null, d.type),
    'edit-loan': (d) => loanForm(find('loans', d.id)),
    'close-loan': (d) => closeLoan(d.id),
    'reopen-loan': (d) => {
      const l = find('loans', d.id);
      l.status = 'open';
      delete l.closedDate;
      save();
    },
    'delete-loan': (d) => {
      if (confirm('Delete this loan permanently?')) {
        state.loans = state.loans.filter((x) => x.id !== d.id);
        save();
      }
    },

    'add-milestone': () => milestoneForm(null),
    'edit-milestone': (d) => milestoneForm(find('milestones', d.id)),
    'delete-milestone': (d) => {
      const m = find('milestones', d.id);
      if (confirm(`Delete milestone "${m.name}"? Its allocated savings become free again.`)) {
        state.milestones = state.milestones.filter((x) => x.id !== d.id);
        save();
      }
    },
    allocate: (d) => allocateForm(d.id),
    'auto-allocate': () => {
      state.milestones = L.autoAllocate(state);
      save();
    },
    'clear-allocations': () => {
      if (confirm('Remove all savings allocations from every milestone?')) {
        state.milestones.forEach((m) => (m.allocations = {}));
        save();
      }
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = actions[el.dataset.action];
    if (fn) {
      e.preventDefault();
      fn(el.dataset);
    }
  });

  render();
})();
