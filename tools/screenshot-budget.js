#!/usr/bin/env node
/**
 * Render the Budget page's Money Flow tab to PNGs for review.
 *
 *   node tools/screenshot-budget.js [--out DIR] [--assets DIR]
 *
 * The app only runs inside Apps Script, so there is no way to open it locally
 * and look at it. This takes the same route check-budget-render.js does — run
 * the real getBudgetSummary over a fixture, feed it to the real render
 * functions — and then puts the resulting markup in a page shaped like
 * index.html, with the real stylesheet, and photographs it in headless
 * Chromium.
 *
 * What it produces is the layout and the styling, not the live app: there is
 * no server behind it, so nothing on the page responds to a click. Each state
 * worth reviewing is rendered as its own file instead.
 *
 * --assets points at a directory holding pico.min.css and the two webfonts, so
 * the page matches what index.html loads from its CDNs. Without it the page
 * still renders, on fallback fonts and with no Pico base styles. To populate
 * one (the CDNs themselves are not reachable from here, the npm registry is):
 *
 *   npm pack @picocss/pico@2 @fontsource/dm-sans @fontsource/cormorant-garamond
 *   tar -xzf picocss-pico-*.tgz -O package/css/pico.min.css > assets/pico.min.css
 *   for w in 300 400 500; do tar -xzf fontsource-dm-sans-*.tgz \
 *     -O package/files/dm-sans-latin-$w-normal.woff2 > assets/dm-sans-$w.woff2; done
 *   for w in 300 400 600; do tar -xzf fontsource-cormorant-garamond-*.tgz \
 *     -O package/files/cormorant-garamond-latin-$w-normal.woff2 > assets/cormorant-$w.woff2; done
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const OUT = path.resolve(arg('out', path.join(ROOT, 'screenshots')));
const ASSETS = arg('assets') ? path.resolve(arg('assets')) : null;

// Playwright is installed globally in this environment, not as a dependency of
// this repo — which has no package.json and no build step, and should not gain
// one for a screenshot tool.
function loadPlaywright() {
  const candidates = [
    '/opt/node22/lib/node_modules/playwright/index.js',
    '/usr/lib/node_modules/playwright/index.js',
    '/usr/local/lib/node_modules/playwright/index.js'
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return createRequire(file)(file);
  }
  try {
    return require('playwright');
  } catch (e) {
    throw new Error('Playwright not found. Install it, or add its path to loadPlaywright().');
  }
}

// --- Server: a fixture, allocated and part-paid through the real code ---

const srv = { Logger: { log: function() {} } };
vm.createContext(srv);
vm.runInContext(['BudgetCategories.gs', 'BudgetService.gs']
  .map(function(f) { return fs.readFileSync(path.join(ROOT, 'src', 'server', f), 'utf8'); })
  .join('\n'), srv, { filename: 'budget-service.js' });

const RULE = {
  rule_id: 'BR-001', name: 'Company Default', model: 'company', is_default: true, active: true,
  biz_tax_withheld_pct: 0, biz_acc_withheld_pct: 0,
  biz_tax_pct: 0.28, biz_acc_pct: 0.01, biz_reserve_pct: 0.10,
  per_tax_pct: 0.30, per_acc_pct: 0.0167,
  per_donate_pct: 0.05, per_save_pct: 0.10, per_invest_pct: 0.15, per_spend_pct: 0.70
};

const db = {
  Businesses: [
    { business_id: 'BIZ-001', name: 'Auckland Transport', currency: 'NZD', active: true, _rowIndex: 2 },
    { business_id: 'BIZ-002', name: 'Kaipara Estuary Trust', currency: 'NZD', active: true, _rowIndex: 3 }
  ],
  Invoices: [
    { invoice_id: 'AT0526', business_id: 'BIZ-001', created_date: '2026-05-31', include_gst: true,
      gst_rate: 0.15, time_subtotal: 12000, subtotal: 12000, gst_amount: 1800, total: 13800,
      status: 'paid', budget_rule_id: '', _rowIndex: 2 },
    { invoice_id: 'AT0626', business_id: 'BIZ-001', created_date: '2026-06-30', include_gst: true,
      gst_rate: 0.15, time_subtotal: 9600, subtotal: 9600, gst_amount: 1440, total: 11040,
      status: 'paid', budget_rule_id: '', _rowIndex: 3 },
    { invoice_id: 'KE0626', business_id: 'BIZ-002', created_date: '2026-06-28', include_gst: true,
      gst_rate: 0.15, time_subtotal: 4200, subtotal: 4200, gst_amount: 630, total: 4830,
      status: 'paid', budget_rule_id: '', _rowIndex: 4 },
    // Pre-company: a sole-trader invoice, still carrying its own allocations.
    { invoice_id: '0326', business_id: 'BIZ-002', created_date: '2026-03-31', include_gst: false,
      gst_rate: 0, time_subtotal: 3800, subtotal: 3800, gst_amount: 0, total: 3800,
      status: 'paid', budget_rule_id: 'BR-000', _rowIndex: 5 }
  ],
  BudgetRules: [Object.assign({}, RULE, { _rowIndex: 2 })],
  // The sole-trader set on 0326, including tax withheld at source. Sums to 3800.
  BudgetAllocations: [
    ['BA-001', 'Tax Withheld', 'legacy_tax_withheld', 380, 'paid'],
    ['BA-002', 'Tax To Pay', 'legacy_tax', 957.6, 'allocated'],
    ['BA-003', 'ACC To Pay', 'legacy_acc', 68.4, 'allocated'],
    ['BA-004', 'Spend', 'legacy_spend', 1676.22, 'allocated'],
    ['BA-005', 'Save', 'legacy_save', 239.46, 'allocated'],
    ['BA-006', 'Donate', 'legacy_donate', 119.73, 'allocated'],
    ['BA-007', 'Invest', 'legacy_invest', 358.59, 'allocated']
  ].map(function(r, i) {
    return {
      allocation_id: r[0], invoice_id: '0326', category: r[1], category_key: r[2],
      scope: 'legacy', percentage: '', amount: r[3], status: r[4],
      paid_amount: r[4] === 'paid' ? r[3] : 0,
      transfer_date: r[4] === 'paid' ? '2026-03-31' : '', notes: '', _rowIndex: i + 2
    };
  }),
  BudgetPayments: []
};

let seq = 100;
let paymentSeq = 0;
Object.assign(srv, {
  LockService: { getScriptLock: function() { return { waitLock: function() {}, releaseLock: function() {} }; } },
  withScriptLock: function(fn) { return fn(); },
  getAll: function(n) { return (db[n] || []).map(function(r) { return Object.assign({}, r); }); },
  findById: function(n, id) {
    const rows = db[n] || [];
    const f = Object.keys(rows[0] || {}).filter(function(k) { return k !== '_rowIndex'; })[0];
    return rows.find(function(r) { return srv.idsMatch(r[f], id); }) || null;
  },
  appendRow: function(n, d) {
    if (n === 'BudgetAllocations') d.allocation_id = 'BA-' + (++seq);
    if (n === 'BudgetPayments') d.payment_id = 'BP-' + String(++paymentSeq).padStart(3, '0');
    d._rowIndex = db[n].length + 2;
    db[n].push(Object.assign({}, d));
    return d;
  },
  updateRow: function(n, i, d) {
    const k = db[n].findIndex(function(r) { return r._rowIndex === i; });
    if (k >= 0) db[n][k] = Object.assign({}, d);
    return d;
  },
  deleteRow: function(n, i) {
    db[n] = db[n].filter(function(r) { return r._rowIndex !== i; });
    db[n].forEach(function(r, k) { r._rowIndex = k + 2; });
  },
  idsMatch: function(a, b) {
    const x = String(a), y = String(b);
    return x === y || (x.replace(/^0+/, '') === y.replace(/^0+/, '') && x !== '' && y !== '');
  },
  normalizeId: function(i) { return String(i).replace(/^0+/, '') || '0'; },
  isTruthy: function(v) { return v === true || v === 'TRUE' || v === 'true'; },
  todayLocal: function() { return '2026-07-06'; },
  dateOnly: function(v) { return (String(v).match(/^(\d{4}-\d{2}-\d{2})/) || ['', ''])[1]; },
  getByDateRange: function(n, c, f, t) {
    return srv.getAll(n).filter(function(r) {
      const d = srv.dateOnly(r[c]);
      return d && (!f || d >= f) && (!t || d <= t);
    });
  },
  getByYear: function(n, c, y) {
    return srv.getAll(n).filter(function(r) { return srv.dateOnly(r[c]).indexOf(String(y)) === 0; });
  },
  getByDateParams: function(n, c, p) {
    if (typeof p === 'object' && p !== null) {
      if (!p.dateFrom && !p.dateTo) return srv.getAll(n);
      return srv.getByDateRange(n, c, p.dateFrom, p.dateTo);
    }
    return p ? srv.getByYear(n, c, p) : srv.getAll(n);
  },
  isFilteringParams: function(p) {
    if (typeof p === 'object' && p !== null) return !!(p.dateFrom || p.dateTo);
    return !!p;
  }
});

const RANGE = { dateFrom: '2026-01-01', dateTo: '2026-07-06' };

['AT0526', 'AT0626', 'KE0626'].forEach(function(id) { srv.allocateBudget(id, 'BR-001'); });

// A few payments, so the page is photographed with money genuinely part-moved
// rather than every bar sitting at zero.
srv.payBudgetCategories('biz_gst,legacy_gst', 3870, '2026-06-28', 'ASB 4471 | GST return May', RANGE);
srv.payBudgetCategories('biz_tax', 4000, '2026-07-01', 'Provisional tax instalment', RANGE);
srv.payBudgetCategories('per_tax,legacy_tax', 2500, '2026-07-02', '', RANGE);
srv.payBudgetCategories('owner_pay', 9000, '2026-07-03', 'Drawn to personal', RANGE);
srv.payBudgetCategories('per_save,legacy_save', 800, '2026-07-04', 'Emergency fund', RANGE);
srv.payBudgetCategories('biz_reserve', 1500, '2026-07-05', '', RANGE);

const summary = srv.getBudgetSummary(RANGE);

// --- Client: the real render functions ---

function inlineScript(file) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'js', file), 'utf8');
  return /<script[^>]*>([\s\S]*?)<\/script>/.exec(src)[1];
}

// A DOM stub just wide enough for openPayPanel, which writes into a host.
const hosts = {};
const cli = {
  console: console,
  document: {
    getElementById: function(id) {
      if (!hosts[id]) hosts[id] = { id: id, innerHTML: '', focus: function() {} };
      return hosts[id];
    }
  },
  prompt: function() { return null; },
  confirm: function() { return true; }
};
cli.serverCall = function() { return Promise.resolve(null); };
vm.createContext(cli);
vm.runInContext([inlineScript('utils.js.html'), inlineScript('budget.js.html')].join('\n'),
  cli, { filename: 'budget-client.js' });
cli.AppCache.budgetCategories = srv.getBudgetCategories();
cli.BudgetRange = { from: RANGE.dateFrom, to: RANGE.dateTo };

const cats = cli.catByKey(summary);

const filters =
  '<div class="filters">' +
    '<label>From <input type="date" value="' + RANGE.dateFrom + '"></label>' +
    '<label>To <input type="date" value="' + RANGE.dateTo + '"></label>' +
    '<button type="button" class="btn-subtle">Apply</button>' +
  '</div>' +
  '<p class="muted small" style="margin:-0.5rem 0 0.5rem;">Default: last 6 months</p>';

const overview =
  cli.renderMoneyMap(summary, cats) +
  cli.renderRevenueSection(summary, cats) +
  cli.renderObligationsSection(cats) +
  cli.renderIncomeSection(cats) +
  cli.renderAllocationsSection(cats);
const history = cli.renderHistorySection(summary, cats);

// The payment panel, produced by the real openPayPanel and spliced into the
// host it targets — there is no server here to click a button against.
const gst = cli.sumCats(cats, ['biz_tax']);
cli.openPayPanel('pay-host-obligations', 'biz_tax', 'Tax to pay', 'pay', gst.outstanding);
const panel = hosts['pay-host-obligations'].innerHTML;
const withPanel = overview.replace(
  '<div class="pay-host" id="pay-host-obligations"></div>',
  '<div class="pay-host" id="pay-host-obligations">' + panel + '</div>');

// --- Page shell, mirroring index.html ---

function asset(file) {
  if (!ASSETS) return null;
  const full = path.join(ASSETS, file);
  return fs.existsSync(full) ? full : null;
}

function fontFace(family, weight, file) {
  const found = asset(file);
  if (!found) return '';
  return '@font-face{font-family:"' + family + '";font-style:normal;font-weight:' + weight +
    ';font-display:block;src:url("file://' + found + '") format("woff2");}';
}

const pico = asset('pico.min.css');
const fonts =
  fontFace('Cormorant Garamond', 300, 'cormorant-300.woff2') +
  fontFace('Cormorant Garamond', 400, 'cormorant-400.woff2') +
  fontFace('Cormorant Garamond', 600, 'cormorant-600.woff2') +
  fontFace('DM Sans', 300, 'dm-sans-300.woff2') +
  fontFace('DM Sans', 400, 'dm-sans-400.woff2') +
  fontFace('DM Sans', 500, 'dm-sans-500.woff2');

const appStyles = fs.readFileSync(path.join(ROOT, 'src/client/css/styles.css.html'), 'utf8');

function page(body, opts) {
  opts = opts || {};
  return '<!DOCTYPE html>\n<html lang="en" data-theme="light"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>Finance Tracker — Money Flow</title>' +
    (pico ? '<link rel="stylesheet" href="file://' + pico + '">' : '') +
    (fonts ? '<style>' + fonts + '</style>' : '') +
    appStyles +
    '<style>' +
      // Screenshots only: kill the entry animations so a capture is never
      // taken mid-fade, and stop scrollbars cropping the full-page shot.
      '*,*::before,*::after{animation:none !important;transition:none !important;}' +
      'body::-webkit-scrollbar{display:none;}' +
    '</style>' +
    '</head><body>' +
    '<nav class="container-fluid" aria-label="Main navigation">' +
      '<ul><li><strong>Finance Tracker</strong></li></ul>' +
      '<ul>' +
        ['Dashboard', 'Hours', 'Invoices', 'Budget', 'Settings'].map(function(p) {
          return '<li><a href="#" class="nav-link' + (p === 'Budget' ? ' active' : '') + '">' + p + '</a></li>';
        }).join('') +
      '</ul>' +
    '</nav>' +
    '<main class="container">' +
      '<div id="app-content">' +
        '<div class="tab-bar" id="budget-tabs">' +
          '<button type="button" class="active">Money Flow</button>' +
          '<button type="button">Allocate Invoice</button>' +
        '</div>' +
        '<div id="budget-tab-content">' + (opts.filters === false ? '' : filters) + body + '</div>' +
      '</div>' +
    '</main>' +
    '</body></html>';
}

// --- Capture ---

const SHOTS = [
  { file: 'money-flow-overview.png', width: 1280,
    html: page(overview + history),
    caption: 'The whole tab at desktop width, history collapsed.' },
  { file: 'money-flow-payment-panel.png', width: 1280,
    html: page(withPanel + history),
    caption: 'Recording a payment: full remaining or any part of it.' },
  { file: 'money-flow-history.png', width: 1280,
    html: page(overview + history.replace('<details class="flow-group history-group">',
      '<details class="flow-group history-group" open>')),
    caption: 'History expanded: every payment, then every allocation per invoice.' },
  { file: 'money-flow-mobile.png', width: 420,
    html: page(overview + history),
    caption: 'The same page on a phone.' }
];

(async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!pico) console.log('  note: no Pico stylesheet found — base element styling will differ');

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();

  for (const shot of SHOTS) {
    const tmp = path.join(OUT, '.' + shot.file.replace(/\.png$/, '.html'));
    fs.writeFileSync(tmp, shot.html);

    const ctx = await browser.newContext({
      viewport: { width: shot.width, height: 1000 },
      deviceScaleFactor: 2
    });
    const pg = await ctx.newPage();
    await pg.goto('file://' + tmp, { waitUntil: 'load' });
    await pg.evaluate(function() { return document.fonts ? document.fonts.ready : null; });
    await pg.screenshot({ path: path.join(OUT, shot.file), fullPage: true });
    await ctx.close();
    fs.unlinkSync(tmp);

    console.log('  ' + shot.file.padEnd(32) + shot.caption);
  }

  await browser.close();
  console.log('\n' + SHOTS.length + ' screenshots written to ' + OUT);
})().catch(function(err) {
  console.error(err);
  process.exit(1);
});
