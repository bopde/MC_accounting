# Finance Tracker

A finance management web app built entirely on Google Apps Script with Google Sheets as the backend. Designed for consultants trading through a company who work with multiple clients and need to track hours, generate invoices, split income between business and personal budgets, and monitor accounts across currencies.

**All code runs within the Google Apps Script sandbox. No external servers, no databases, no third-party APIs.**

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [External Services & Security](#external-services--security)
- [Google Sheets Structure](#google-sheets-structure)
- [Setup & Deployment](#setup--deployment)
- [Usage Guide](#usage-guide)
- [Project Structure](#project-structure)
- [Function Reference](#function-reference)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Features

### 1. Hours & Expenses
- Log time entries with business, work code, start/end times. Hours and line totals calculated server-side.
- Log expenses with date, amount, description, and work code.
- Filter entries by business, date range, or invoiced status.
- Selecting a business auto-fills the default hourly rate and currency.

### 2. Invoices
- Generate invoices from uninvoiced time entries and expenses for a business and date range.
- Optional GST at a configurable rate (default 15%). Record tax already withheld by the payer.
- Optional **PO number**, defaulting from the selected contract but editable, and settable on an existing invoice via Edit.
- Print-friendly invoice view with your details ("From"), client details ("Bill To"), itemised services grouped by work code, and expenses listed individually. Only the **GST number** is printed — the IRD number is kept in Settings for reference but stays off documents that go to clients.
- Status flow: draft -> sent -> paid -> void.
- Entries are marked with the invoice ID once invoiced, preventing double-billing.

**Invoice numbers** are `<business code><MMYY>` — Auckland Transport for May 2026 is `AT0526`. Further invoices for the same client in the same month get a letter suffix: `AT0526a`, `AT0526b`. Numbering is per client per month, so two clients invoiced in May both start unsuffixed.

1. The code defaults to the initials of the business name, skipping connectives and legal suffixes: `Auckland Transport` -> `AT`, `Ministry of Business and Employment` -> `MBE`, `Beta Corp Limited` -> `BC`. A single-word name takes its first two letters: `Acme` -> `AC`.
1. Set an explicit **invoice code** on the business in Settings to override it — needed when the initials read badly. Saving a business whose code would clash with another one is **refused**, naming the client it clashes with: two clients sharing a prefix share one sequence, so each ends up with a run full of holes.
1. A code never starts with a digit. `normalizeId` strips leading zeros from every id it compares, so a prefix beginning `0` would make `0S0526` and `S0526` alias each other and `findById` could return the wrong invoice.
1. Numbering counts a client's invoices **for that month**, not matching id text, so renaming a business cannot restart its sequence and produce a second unsuffixed invoice. A number that has been used is never reissued, even if the invoice was deleted — a client's records may still refer to it.
1. Invoices raised before this format existed keep their bare `MMYY` ids, and their sequence continues independently.

### 3. Budget Allocations

Budgeting is split into two scopes — **business** (company money that stays in the business account) and **personal** (money drawn out) — joined by a derived **Owner Pay** bridge. Allocations are calculated from billed hours only, ex-GST; expenses are treated as pass-throughs.

1. **Business**
   1. a. **GST** — taken verbatim from the invoice, not a percentage. Held for the IRD.
   1. b. **Business Tax** — % of business income (company rate).
   1. c. **Business ACC** — % of business income (employer levies).
   1. d. **Reserve** — % of business income, retained as company working capital.
1. **Owner Pay** — business income minus the three business buckets above. A derived remainder, so it balances to the cent. It is excluded from every money total, because it moves money between two of your own accounts rather than adding to it.
1. **Personal** (all calculated from Owner Pay)
   1. a. **Personal Tax** — % of Owner Pay.
   1. b. **Personal ACC** — % of Owner Pay (earner levy).
   1. c. **Donate / Save / Invest / Spend** — split what remains, must sum to 100%. The rounding residual lands on Spend so the four lines sum exactly.
1. **Withholding** (optional, defaults to 0%) — Tax Withheld and ACC Withheld come off gross before anything else, for the rare contract that still withholds. Created already paid, because the payer sent that money to the IRD rather than to you. On the Money Flow page it is counted inside the tax or ACC obligation it settled, not as a category of its own.

Every category definition, percentage field and the cascade itself live in one registry (`src/server/BudgetCategories.gs`). The front end reads that registry rather than keeping its own copy, and the allocation preview is computed by the same server function that writes the allocations.

- Only paid invoices can be allocated. An allocation carries both what was assigned and how much of it has been paid, so a payment can settle part of one.
- Money is paid **per bucket**, not per invoice — in full or for any part of what is outstanding — and the full history of payments and allocations sits below the totals.
- An allocation can be **removed** again from the invoice view, which is what lets an allocated invoice be corrected or voided.
- **Pre-company (sole trader) rules and allocations still work.** Historical allocations are tagged `legacy` and are folded into the section they belong to rather than kept in a silo; a rule's `model` column (`company` or `sole_trader`) decides which cascade applies.

The percentages are yours to set — the seeded defaults reflect current NZ rates but are placeholders, not tax advice. Note that tax is provisioned on revenue, not profit: as a company, deductible expenses genuinely reduce your taxable income, so the Business Tax bucket will over-provision.

### 4. Account Summaries
- Enter monthly snapshots for each account: EOM balance, realised/unrealised gains, tax paid, notes.
- 15-month year overview (Jan-Dec + Jan-Mar following year) with month-over-month balance changes colour-coded.
- Upsert logic: re-entering data for an existing account+month updates rather than duplicates.

### 5. Settings
- **My Details**: Name, address, email, phone, tax number, GST number, bank account, payment terms. Appears on invoices.
- **Businesses**: Client name, contact, email, address, default rate, currency, and an optional **invoice code** that prefixes their invoice numbers. Soft-delete to preserve history.
- **Work Codes**: Short codes (DEV, DESIGN, etc.) with descriptions and categories.
- **Accounts**: Bank, investment, hold, crypto, or other accounts with currency, scope (business or personal), and purpose.
- **Budget Rules**: Named percentage-split templates. One can be marked as default. The form is generated from the category registry and shows the implied Owner Pay percentage as you type.

All configuration is editable from the frontend. Dropdowns suggest existing entries to prevent duplication.

---

## Architecture

### How It Works

```
Browser (your computer)
    |
    |  Loads HTML/CSS/JS via HtmlService
    v
Google Apps Script Web App
    |
    |  google.script.run (RPC calls)
    v
Server-side .gs functions
    |
    |  SpreadsheetApp API
    v
Google Spreadsheet (your private Sheet)
```

1. **Entry point**: `doGet()` in `Main.gs` serves `index.html` via `HtmlService`. All client files (JS, CSS) are inlined using `<?!= include() ?>` template directives.
2. **Client SPA**: A hash-based router (`#hours`, `#invoices`, etc.) in `app.js.html` handles page navigation. On each route change, reference data is loaded from cache (or fetched from the server), then the page render function is called.
3. **Client-server RPC**: Client code calls server functions via `google.script.run`, wrapped in a Promise-based `serverCall()` utility with a 15-second timeout. Functions that need multiple arguments use pipe-delimited strings through `ClientWrappers.gs`.
4. **Data layer**: `SheetService.gs` provides generic CRUD (getAll, appendRow, updateRow, findById). Each service module (Hours, Invoice, Budget, Account, Settings) builds on these primitives. `getSpreadsheet()` calls `SpreadsheetApp.getActiveSpreadsheet()` -- no ID configuration needed because the script is bound to its spreadsheet.
5. **ID generation**: `nextId()` in `IdService.gs` generates sequential reference ids (TE-001, EXP-001, BA-042). Invoices instead use `generateInvoiceId()` in `InvoiceService.gs` for the `AT0526` format. Both run inside `withScriptLock` so the read-then-write is atomic — see [Data Integrity](#data-integrity).
6. **Caching**: `AppCache` on the client stores reference data (businesses, work codes, accounts, budget rules, my details) to reduce server round-trips. The cache is cleared on settings changes.

### Security Model

| Layer | Protection |
|-------|-----------|
| **Source code** | Public on GitHub. Contains zero credentials or sensitive data. |
| **Script ID** | `.clasp.json` is gitignored. Only `.clasp.json.example` is committed. |
| **OAuth scope** | `spreadsheets.currentonly` -- the script can only access the spreadsheet it's bound to, not any other file in your Google account. |
| **Spreadsheet data** | Private Google Sheet, not shared with anyone. |
| **Web app access** | Deployed as "Execute as: Me" with "Only myself" access. |

### Data Integrity

- **Dropdown-driven entry**: Businesses, work codes, and accounts are selected from dropdowns.
- **Sequential IDs with locking**: `withScriptLock` in `SheetService.gs` is the single place that touches `LockService`. It is re-entrant, so an operation like `allocateBudget` or `generateInvoice` holds **one** lock across its whole read-check-then-write. That matters: when ID generation took and released its own lock, an outer critical section lost its protection the moment it appended a row, and two concurrent requests could both pass the same "already exists?" check.
- **Writes fail loudly on schema drift**: `appendRow` and `updateRow` build rows from the *sheet's* header row, so a field with no matching column would vanish silently. `assertKnownColumns` throws instead, naming the columns and telling you to run `setupSheets()`. The app also warns on load — see [Migrations](#migrations).
- **Foreign keys by ID**: Renaming a business updates display everywhere automatically.
- **Soft deletes**: Deactivating reference data hides it from dropdowns but preserves historical records.
- **Upsert for summaries**: Account summaries for the same account+month are updated, not duplicated.
- **Dynamic column lookups**: Column indices resolved by header name, not hardcoded positions.

---

## External Services & Security

This section lists **every external service** the app contacts. There are only two, and one of them is optional.

### 1. Google Apps Script Built-in APIs (required)

These are Google's own APIs, accessed within the Apps Script sandbox. No network calls leave Google's infrastructure.

| API | Used By | Purpose |
|-----|---------|---------|
| `SpreadsheetApp` | SheetService.gs, Setup.gs, IdService.gs, ClientWrappers.gs | Read/write the bound spreadsheet |
| `LockService` | IdService.gs | Prevent concurrent ID collisions |
| `HtmlService` | Main.gs | Serve the web app HTML |
| `google.script.run` | utils.js.html (client) | Client-to-server RPC mechanism |

### 2. Pico CSS CDN (optional, removable)

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
```

**File**: `src/client/index.html`, line 7

This is the **only external network request** made by the client. It loads the Pico CSS framework from the jsDelivr CDN for styling. To eliminate this dependency entirely:

1. Download the CSS file
2. Paste its contents into a new `pico.css.html` file wrapped in `<style>` tags
3. Replace the `<link>` tag with `<?!= include('client/css/pico.css') ?>`

### What is NOT used

- No external APIs (Stripe, PayPal, exchange rate services, etc.)
- No analytics or tracking scripts
- No authentication libraries (relies entirely on Google account)
- No server-side HTTP fetches (`UrlFetchApp` is not used anywhere)
- No external databases

---

## Google Sheets Structure

The spreadsheet has **12 tabs**, created automatically by `setupSheets()`:

| Tab | Purpose | Key Fields |
|-----|---------|-----------|
| **MyDetails** | Invoice "From" details (key/value pairs) | key, value |
| **Businesses** | Client/employer reference data | business_id, name, contact_name, email, address, default_rate, currency, invoice_code, active |
| **WorkCodes** | Job classification codes | code_id, description, category, contract_id, active |
| **Accounts** | Bank/investment accounts | account_id, name, type, currency, scope, purpose, active |
| **BudgetRules** | Budget percentage templates | rule_id, name, model, legacy `tax_withheld_pct`…`spend_pct`, company `biz_*_pct` / `per_*_pct`, is_default, notes, active |
| **Contracts** | Client contracts / purchase orders | contract_id, business_id, name, po_number, date_from, date_to, value, currency, work_codes, status, notes |
| **TimeEntries** | Logged work hours | entry_id, business_id, date, time_start, time_end, hours, description, work_code, rate, line_total, invoice_id, contract_id |
| **Expenses** | Reimbursable expenses | expense_id, business_id, date, amount, description, work_code, invoice_id |
| **Invoices** | Generated invoices | invoice_id, business_id, date_from, date_to, created_date, include_gst, gst_rate, time_subtotal, subtotal, gst_amount, total, status, budget_rule_id, contract_id, po_number, description, notes, line_descriptions |
| **BudgetAllocations** | Per-invoice budget splits | allocation_id, invoice_id, category, category_key, scope, percentage, amount, status, paid_amount, transfer_date, notes |
| **BudgetPayments** | Money actually moved, per payment | payment_id, payment_date, category_key, category, scope, amount, notes, covered, created_date |
| **AccountSummaries** | Monthly account snapshots | summary_id, account_id, month, ending_balance, realised_gains, unrealised_gains, tax_paid, total_in, total_out, notes |

`category_key` and `scope` are the identity columns on an allocation; `category` is the human-readable label.

`paid_amount` is how much of an allocation has actually been paid, so a payment need not settle a whole allocation. `status` is kept in step (`paid` once `paid_amount` covers `amount`), and a **blank** `paid_amount` means the row predates partial payments — there, `status` is the whole truth.

`BudgetPayments.covered` records exactly which allocations a payment was applied to and how much each got, as `BA-002:252;BA-003:18`, so a payment can be undone precisely rather than by re-deriving it.

### Migrations

Schema changes only take effect when `setupSheets()` runs. Until then, any write touching a new column loses that value — so the app makes this hard to miss:

1. **Spreadsheet menu**: **Finance Tracker → Run setup / migrations** (and **Check for missing columns**), installed by `onOpen()` in `Main.gs`. No need to open the script editor.
1. **Load-time banner**: `bootstrap()` returns `schemaWarnings` from `checkSchema()`, and the app shows a banner naming the sheets and columns that are missing.
1. **Loud writes**: `assertKnownColumns` throws rather than dropping a field with no column.

`setupSheets()` is idempotent: create missing sheets, append missing columns (`migrateColumns`), repair allocation identity columns (`migrateBudgetAllocations`), backfill `paid_amount` (`migrateAllocationPaidAmounts`), and seed a company rule if none exists.

`migrateAllocationPaidAmounts` fills only blank cells, from the status that was already there — a `paid` row was paid in full, an `allocated` row was not paid at all. A partial payment recorded since is never overwritten.

`migrateBudgetAllocations` classifies **per invoice**, not per row. Six category labels — `Donate`, `Save`, `Invest`, `Spend`, `Tax Withheld`, `ACC Withheld` — are identical in both models, so a single row is ambiguous. A whole invoice is not: only a company allocation can contain `GST`, `Business Tax`, `Business ACC`, `Reserve`, `Owner Pay`, `Personal Tax` or `Personal ACC`. If any row in an invoice's set carries one of those, every row in that set is company. Amounts, labels and statuses are never rewritten — only the two identity columns are filled.

### Relationships

```
Businesses ---< TimeEntries    (business_id)
Businesses ---< Expenses       (business_id)
Businesses ---< Invoices       (business_id)
WorkCodes  ---< TimeEntries    (work_code)
WorkCodes  ---< Expenses       (work_code)
Invoices   ---< TimeEntries    (invoice_id, set when invoiced)
Invoices   ---< Expenses       (invoice_id, set when invoiced)
Invoices   ---< BudgetAllocations (invoice_id)
BudgetAllocations >-< BudgetPayments (BudgetPayments.covered, many-to-many)
BudgetRules --< Invoices       (budget_rule_id, set when allocated)
Accounts   ---< AccountSummaries (account_id)
```

### Budget category registry

`BudgetAllocations.category_key` is not a foreign key to a sheet — the category definitions live in code, in `src/server/BudgetCategories.gs`:

```
BUDGET_CATEGORY_DEFS  (company model)
  business  biz_tax_withheld, biz_acc_withheld, biz_gst, biz_tax, biz_acc, biz_reserve
  bridge    owner_pay                    (derived remainder, excluded from totals)
  personal  per_tax, per_acc, per_donate, per_save, per_invest, per_spend

LEGACY_CATEGORY_DEFS  (sole trader model, historical)
  legacy    legacy_tax_withheld, legacy_tax, legacy_acc_withheld, legacy_acc,
            legacy_gst, legacy_donate, legacy_save, legacy_invest, legacy_spend
```

Each definition carries its scope, its percentage field on `BudgetRules`, the base it is calculated from, and how it settles (`auto_paid`, `pay`, `hold`, `transfer`). Adding a bucket means adding one entry here plus one column via `setupSheets()` — the forms, tables, tiles and dashboard are all generated from the registry.

---

## Setup & Deployment

### Prerequisites

- A Google account
- A Google Spreadsheet (create a new blank one)

### Important: Container-Bound Script

This app is designed as a **container-bound** script -- meaning it is created from *within* the spreadsheet, not as a standalone project. This is what allows the narrow `spreadsheets.currentonly` permission scope: the script can only touch the one spreadsheet it lives inside.

### Option A: Using clasp (Recommended)

[clasp](https://github.com/google/clasp) is Google's CLI tool for managing Apps Script projects. It lets you push code from your local repo directly to Apps Script.

```bash
# 1. Install clasp globally
npm install -g @google/clasp

# 2. Log in to your Google account
clasp login

# 3. Create the Apps Script project BOUND to your spreadsheet.
#    First, open your spreadsheet, go to Extensions > Apps Script.
#    This creates a container-bound script. Copy the script ID from
#    the URL: https://script.google.com/home/projects/SCRIPT_ID/edit
#
#    Then create .clasp.json locally:
echo '{ "scriptId": "YOUR_SCRIPT_ID", "rootDir": "src" }' > .clasp.json

# 4. DO NOT commit .clasp.json (it's already in .gitignore).

# 5. Push all source files to Apps Script
clasp push

# 6. Open the Apps Script editor in your browser
clasp open
```

Then in the Apps Script editor:

1. In the editor, run the `setupSheets` function (select it from the function dropdown and click Run). This creates all 12 tabs with headers, appends any missing columns, repairs allocation identity columns, backfills `paid_amount`, and seeds a company budget rule if none exists. Safe to re-run — it is idempotent. **After the first run you can do this from the spreadsheet instead: Finance Tracker → Run setup / migrations.** Re-run it after every code update that changes the schema; the app shows a banner when columns are missing.
2. Go to **Deploy > New deployment**
3. Select type: **Web app**
4. Set "Execute as": **Me**
5. Set "Who has access": **Only myself**
6. Click **Deploy**
7. Open the provided URL

### Option B: Browser Only (No Tools Required)

1. Create a new Google Spreadsheet
2. Go to **Extensions > Apps Script** (this creates a container-bound script)
3. In the editor, go to **Project Settings** and check "Show `appsscript.json` manifest file"
4. Replace the contents of `appsscript.json` with the contents of `src/appsscript.json`
5. For each `.gs` file in `src/server/`, create a new script file (File > New > Script) and paste the contents. Name each file to match (e.g., `Main`, `Setup`, etc. -- the `.gs` extension is added automatically)
6. For each `.html` file in `src/client/`, create a new HTML file (File > New > HTML) and paste the contents. Paths matter -- name them exactly:
   - `client/index` (from `src/client/index.html`)
   - `client/css/styles.css` (from `src/client/css/styles.css.html`)
   - `client/js/utils.js` (from `src/client/js/utils.js.html`)
   - `client/js/app.js` (from `src/client/js/app.js.html`)
   - `client/js/hours.js`, `client/js/invoices.js`, `client/js/budget.js`, `client/js/accounts.js`, `client/js/settings.js`
7. Run `setupSheets` from the editor
8. **Deploy > New deployment > Web app** (Execute as: Me, Only myself)

### Updating After Code Changes

Every time you update code (via `clasp push` or manual paste), you must create a **new deployment version** for the changes to take effect:

1. Go to **Deploy > Manage deployments**
2. Click the **pencil icon** (edit) on your deployment
3. Under "Version", select **New version**
4. Click **Deploy**
5. Reload the web app URL

Simply saving the code in the editor is not enough -- the deployed web app serves the version that was active at deployment time.

---

## Usage Guide

### First-Time Setup (After Deployment)

1. **Settings > My Details**: Fill in your name, address, email, phone, tax/GST numbers, bank account, and payment terms. These appear on invoices.
2. **Settings > Businesses**: Add your clients/employers with their contact info, default hourly rate, and currency. The **invoice code** can be left blank — it defaults to the initials of the name.
3. **Settings > Work Codes**: Add codes for the types of work you do (e.g., DEV - Development, DESIGN - Design Work, ADMIN - Administration).
4. **Settings > Accounts**: Add your bank, investment, savings, and other accounts you want to track.
5. **Settings > Budget Rules**: `setupSheets` seeds a "Company Default" rule. Edit it — set your business tax, ACC and reserve percentages (the form shows the resulting Owner Pay as you type), your personal tax and ACC, and a Donate/Save/Invest/Spend split summing to 100%.
6. **Settings > Accounts**: mark each account's scope as business or personal.

### Daily Workflow: Logging Hours

1. Go to **Hours > Time Entries**
2. Select a business from the dropdown (rate auto-fills)
3. Select a work code
4. Enter date, start time, end time, and optionally a description
5. Click **Submit** -- hours and line total are calculated automatically

For expenses: switch to the **Expenses** tab, select business and work code, enter date, amount, and description.

### Invoicing

1. Go to **Invoices > Create**
2. Select a business and date range
3. Click **Preview** to see all uninvoiced entries for that period
4. Check/uncheck **Include GST** and adjust the rate if needed
5. Enter any tax already withheld by the payer
6. Click **Create Invoice** to generate. Entries are now marked as invoiced.
7. View the invoice from the **All Invoices** tab. Use your browser's print function for PDF output.
8. Update status as the invoice progresses: **Mark Sent** -> **Mark Paid**

### Budget Allocation

1. Go to **Budget > Allocate Invoice**
2. Select a paid invoice and a budget rule
3. Click **Preview allocation**. The cascade reads Gross → Business income → business buckets → **Owner Pay** → personal buckets, and the total ties back to the invoice total including GST.
4. Click **Confirm allocation** to write the rows. Buckets that come to zero are skipped.
5. In **Budget > Money Flow**, record the money as you move it — one payment per bucket, not per invoice. See below.

To undo an allocation — to correct it, or because the invoice needs voiding — open the invoice and use **Remove allocation**. It is refused while any recorded payment has settled part of it; undo those under **Money Flow → History** first.

### Reading the Money Flow tab

An overview first and a ledger second. Everything above the history is totals with one action each; nothing there asks you to settle invoices one at a time.

1. **Money map** — the whole journey in one band: what the company invoiced, what it owes and keeps, the **owner pay** draw across to your personal account, and what happens on the personal side. Every figure appears again below; this is the shape of it.
1. **Revenue** — two views of the same money, deliberately **not** added together. Both count **allocated** invoices only, so a paid invoice you have not allocated yet is absent:
   1. a. **Business revenue** — everything the company invoiced, including GST.
   1. b. **Personal revenue** — what actually reached you: the owner pay draw plus sole-trader income, before personal tax, ACC and allocations.
   1. c. They overlap by the owner pay draw — business revenue the company then paid to you — so there is no combined total, and the section says so rather than leaving you to work out why the boxes do not sum.
1. **Total obligations** — what is still owed, split into **Business** (tax, GST, ACC) and **Personal** (tax, ACC). Each box shows what is left to pay as the headline, with a progress bar, `Paid $X of $Y`, and the button that settles it. Tax and ACC **withheld at source** are counted here, inside the obligation they settled — see below.
1. **Total income** — what survives the obligations: the **Reserve pot** the business keeps, and the **Personal pot**, with the from-business and sole-trader portions named in small text.
1. **Allocations** — the **owner pay draw** out of the company, then the personal pot split across **Save / Donate / Invest / Spend**.
1. **History** — collapsed by default. Every payment made, newest first, each with **Undo**; then every allocation itemised per invoice, read-only.

#### Recording a payment

Money leaves an account in single payments, not invoice by invoice, so that is how it is recorded. Every box's button says **Pay**, whatever the bucket is — paying GST, setting money aside in Reserve and drawing owner pay are one act (money leaving the account it is sitting in), and three different words made the page read as three mechanisms. The settle mode still decides whether a bucket has a button at all. The button opens a panel prefilled with the full outstanding amount:

1. **Pay it all**: leave the amount as it is (or click **Use full $X**) and record it.
1. **Pay part of it**: type any smaller amount. The rest stays outstanding.

The payment is applied to that bucket's **oldest unpaid invoices first**, splitting the last one where it does not cover it in full. One row goes into `BudgetPayments` naming every allocation it touched and by how much, so **Undo** in the history puts back exactly what that payment took and nothing else.

Two things bound a payment:

1. It is limited to the **date range on screen**, so "the remaining" means exactly the figure shown and never reaches into a period you are not looking at.
1. It cannot exceed what is outstanding — an overpayment is refused rather than silently capped.

A box that merges buckets settles all of them at once: **Personal / Tax to pay** covers `per_tax` and `legacy_tax`, and one payment clears across both.

Sole-trader money is folded into the section it belongs to rather than kept in a separate silo — legacy tax and ACC join Personal obligations, and legacy Save/Donate/Invest/Spend join their company counterparts in the same box.

#### The money map's columns

The map's two columns are built from the server's **scope** tagging, not from the display groupings the boxes below use. The groupings deliberately merge scopes — sole-trader tax appears under Personal, sole-trader GST under Business GST — which is right for a box answering "what do I owe" and wrong for a column that has to balance against the revenue on its own side. So each column balances exactly:

```
business in − obligations − reserve = the owner pay draw
personal in − obligations           = the personal pot
```

Where a sole-trader invoice carried GST, the Business **GST to pay** box and the map's business **Obligations out** differ by exactly that amount, and that is correct: it is one GST bill with the company's, but the money sat in the personal account.

#### Tax withheld at source

Tax and ACC the payer deducted belong to the **obligation they settled**, not to a category of their own. A payer who withheld tax on a sole-trader invoice paid that tax to the IRD out of the same obligation — it simply never passed through your account. So `legacy_tax_withheld` is counted inside Personal **Tax to pay** (and `biz_tax_withheld` inside Business Tax to pay, and the two ACC equivalents likewise).

What that changes:

1. a. It raises **Paid** and the **total**, and leaves **still to pay** exactly where it was. The box says `$X already withheld at source` so the higher Paid figure is explained.
1. b. A payment is never applied to it — there is nothing left to pay — so the withheld keys are stripped from what the Pay button sends.
1. c. It no longer has a box of its own in Allocations or in the History; its allocations are listed inside the obligation, where the invoice and date are visible.

Keeping it apart understated every tax figure by the amount already paid, and put a box on the page for money that needs nothing done with it.

The sections reconcile on **invoiced** revenue — business plus sole trader. The personal view overlaps that and plays no part in the identity. `tools/check-budget-render.js` asserts both, and `tools/check-reconciliation.js` asserts them over a whole book of invoices:

```
invoiced revenue − Total obligations = Reserve + Personal pot
Personal pot                        = Save + Donate + Invest + Spend
```

Note that the **Total obligations** header shows what is still *owed*, which falls as payments are recorded; the identity above is over what was *allocated*.

### The Dashboard hours table

**Hours & Earnings** lists, per client: hours logged, **Earned** (the value of that logged time) and **Invoiced** (billed time only — excluding expenses and GST, i.e. the invoice's `time_subtotal`). Voided invoices are excluded, and a client invoiced in the period with no hours logged in it still gets a row.

Earned and Invoiced are deliberately different sets of work: Earned is time logged inside the date range, Invoiced is what was billed inside it — May's work invoiced in June appears in each of them in a different month.

### The Dashboard budget tile

The same figures, condensed to three groups: **Total revenue** (business and personal, with the same overlap caveat), **Total obligations** (business and personal, outstanding only), and **Personal allocations** (spend, save, invest, donate). The bucket groupings are shared globals in `utils.js.html`, so the Dashboard and the Budget page cannot drift apart.

### Contract progress

Time tagged with a contract belongs to that contract. Untagged time is attributed to the client's contract whose period covers its date — **but only when exactly one does**. Where two contracts for the same client overlap, nothing in the data says which one the work was for, so it is counted against neither and reported under the Contract Progress tile instead. Set the contract on those entries under **Hours** to bring them in.

The rule lives in one place (`attributeTimeToContracts` in `ContractService.gs`); the Dashboard and the Contracts tab both call it, so they cannot report different spend for the same contract.

### Account Monitoring

1. Go to **Accounts > Monthly**
2. Select a month and click **Load**
3. Enter EOM balance, realised/unrealised gains, tax paid, and notes for each account
4. Click **Save All**
5. Use **Year Overview** to see the full 15-month picture with balance trends

---

## Project Structure

```
MC/
├── .gitignore
├── .clasp.json.example      # Template -- copy to .clasp.json and add your script ID
├── README.md
├── tools/
│   ├── check-budget-math.js        # Dependency-free node checks for the cascade
│   ├── check-budget-integration.js # allocate -> summarise, stubbed Sheets layer
│   ├── check-sheet-guards.js       # column guards, schema check, allocation repair
│   ├── check-budget-render.js      # Budget page + Dashboard markup and totals
│   ├── check-invoice-ids.js        # invoice number format and sequencing
│   ├── check-client-smoke.js       # every client page renders without throwing
│   ├── check-app-flows.js          # invoice lines, voiding, dashboard agreement, guards
│   ├── check-reconciliation.js     # does the money add up? identities, end to end
│   └── screenshot-budget.js        # renders the Money Flow tab to PNGs for review
└── src/
    ├── appsscript.json       # Apps Script manifest (runtime config, webapp settings)
    ├── server/
    │   ├── Main.gs           # doGet() entry point, include() helper
    │   ├── Setup.gs          # Sheet creation, column + allocation migrations
    │   ├── IdService.gs      # Sequential ID generation with LockService
    │   ├── SheetService.gs   # Generic CRUD: getAll, appendRow, updateRow, findById
    │   ├── HoursService.gs   # Time entry and expense logic
    │   ├── InvoiceService.gs # Invoice generation, GST, status tracking
    │   ├── BudgetCategories.gs # Category registry + the pure cascade maths
    │   ├── BudgetService.gs  # Allocation, preview and summary over the registry
    │   ├── DashboardService.gs # Single-RPC dashboard bundle
    │   ├── ContractService.gs  # Contracts / purchase orders
    │   ├── AccountService.gs # Monthly account summaries, 15-month overview
    │   ├── SettingsService.gs# Reference data CRUD, MyDetails management
    │   └── ClientWrappers.gs # Adapters for google.script.run single-arg limitation
    └── client/
        ├── index.html        # SPA shell with nav, includes all JS/CSS
        ├── css/
        │   └── styles.css.html   # Layout, print, and component styles
        └── js/
            ├── utils.js.html     # serverCall, AppCache, formatters, helpers
            ├── app.js.html       # Hash-based router
            ├── hours.js.html     # Hours & expenses module
            ├── invoices.js.html  # Invoice list, create, preview, detail
            ├── budget.js.html    # Budget allocation & summary
            ├── accounts.js.html  # Monthly entry & year overview
            └── settings.js.html  # All configuration tabs
```

---

## Function Reference

### Client -> Server Call Map

Every server function the client can call, grouped by module. These are invoked via `serverCall('functionName')` which wraps `google.script.run`.

#### Reference Data (loaded on every page via `loadReferenceData`)

| Client calls | Server function | File | Returns |
|-------------|----------------|------|---------|
| `serverCall('getBusinesses')` | `getBusinesses()` | SettingsService.gs | Active businesses |
| `serverCall('getWorkCodes')` | `getWorkCodes()` | SettingsService.gs | Active work codes |
| `serverCall('getAccounts')` | `getAccounts()` | SettingsService.gs | Active accounts |
| `serverCall('getBudgetRules')` | `getBudgetRules()` | SettingsService.gs | All budget rules |
| `serverCall('getMyDetails')` | `getMyDetails()` | SettingsService.gs | Key-value object of invoice details |

#### Hours & Expenses

| Client calls | Server function | File | Purpose |
|-------------|----------------|------|---------|
| `serverCall('addTimeEntry', data)` | `addTimeEntry(data)` | HoursService.gs | Create time entry; calculates hours/total |
| `serverCall('getTimeEntries', filters)` | `getTimeEntries(filters)` | HoursService.gs | Filter entries by business/date/status |
| `serverCall('addExpense', data)` | `addExpense(data)` | HoursService.gs | Create expense entry |
| `serverCall('getExpenses', filters)` | `getExpenses(filters)` | HoursService.gs | Filter expenses |

#### Invoices

| Client calls | Server function | File | Purpose |
|-------------|----------------|------|---------|
| `serverCall('getUninvoicedItems', params)` | `getUninvoicedItems(params)` | ClientWrappers.gs | Preview items for invoicing |
| `serverCall('generateInvoice', params)` | `generateInvoice(params)` | InvoiceService.gs | Create invoice, mark items invoiced |
| `serverCall('getInvoicesWithDetails')` | `getInvoicesWithDetails()` | InvoiceService.gs | List invoices with business names |
| `serverCall('getInvoiceDetails', id)` | `getInvoiceDetails(id)` | InvoiceService.gs | Full invoice detail for viewing |
| `serverCall('updateInvoiceStatusFromClient', params)` | `updateInvoiceStatusFromClient(params)` | ClientWrappers.gs -> `updateInvoiceStatus()` | Change invoice status |

#### Budget

| Client calls | Server function | File | Purpose |
|-------------|----------------|------|---------|
| `serverCall('getBudgetSummary', range)` | `getBudgetSummary(params)` | BudgetService.gs | Allocations grouped by scope, with per-scope and Owner Pay figures |
| `serverCall('previewAllocationFromClient', params)` | `previewAllocationFromClient(params)` | ClientWrappers.gs -> `previewAllocation()` | Compute an allocation without writing it |
| `serverCall('allocateBudgetFromClient', params)` | `allocateBudgetFromClient(params)` | ClientWrappers.gs -> `allocateBudget()` | Write the allocations for an invoice |
| `serverCall('updateAllocationStatusFromClient', params)` | `updateAllocationStatusFromClient(params)` | ClientWrappers.gs -> `updateAllocationStatus()` | Mark an allocation paid / set aside / transferred, or undo |

#### Accounts

| Client calls | Server function | File | Purpose |
|-------------|----------------|------|---------|
| `serverCall('getAccountSummariesForMonth', month)` | `getAccountSummariesForMonth(month)` | AccountService.gs | Load month's account data |
| `serverCall('saveAccountSummary', data)` | `saveAccountSummary(data)` | AccountService.gs | Save/update monthly snapshot |
| `serverCall('getYearOverview', year)` | `getYearOverview(year)` | AccountService.gs | 15-month overview data |

#### Settings Management

| Client calls | Server function | File | Purpose |
|-------------|----------------|------|---------|
| `serverCall('saveMyDetails', data)` | `saveMyDetails(data)` | SettingsService.gs | Save invoice "From" details |
| `serverCall('addBusiness', data)` | `addBusiness(data)` | SettingsService.gs | Add new business |
| `serverCall('getAllBusinesses')` | `getAllBusinesses()` | SettingsService.gs | List all businesses (inc. inactive) |
| `serverCall('addWorkCode', data)` | `addWorkCode(data)` | SettingsService.gs | Add new work code |
| `serverCall('getAll', 'WorkCodes')` | `getAll('WorkCodes')` | SheetService.gs | List all work codes (inc. inactive) |
| `serverCall('addAccount', data)` | `addAccount(data)` | SettingsService.gs | Add new account |
| `serverCall('getAll', 'Accounts')` | `getAll('Accounts')` | SheetService.gs | List all accounts (inc. inactive) |
| `serverCall('addBudgetRule', data)` | `addBudgetRule(data)` | SettingsService.gs | Add budget rule |
| `serverCall('toggleEntityFromClient', params)` | `toggleEntityFromClient(params)` | ClientWrappers.gs | Activate/deactivate any entity |

### Internal Server Call Chains

How server functions call each other internally:

```
doGet()
└── HtmlService.createTemplateFromFile('client/index')
    └── include() x8  (embeds all JS/CSS files)

generateInvoice(params)
└── withScriptLock(...)          [ONE lock across select -> write -> stamp]
    ├── getUninvoicedItemsInternal(businessId, dateFrom, dateTo, contractId)
    │   └── getAll('TimeEntries'), getAll('Expenses'), findById('Contracts', ...)
    ├── generateInvoiceId(dateTo)     [re-entrant, no separate lock]
    ├── appendRow('Invoices', data)
    └── stampInvoiceId(sheet, rows, id) x2   [batched into contiguous runs]

allocateBudget(invoiceId, ruleId)
└── withScriptLock(...)          [ONE lock, so the duplicate guard is race-safe]
    ├── findById('Invoices', invoiceId)
    ├── findById('BudgetRules', ruleId)
    ├── buildAllocationPlan(invoice, rule)
    │   ├── invoiceAllocationBasis(invoice)      [billed hours, ex-GST]
    │   └── computeCompanyAllocation(...)        [or computeLegacyAllocation for a
    │                                             pre-company rule]
    ├── appendRow('BudgetAllocations', ...) per non-zero line
    │   └── nextId('BudgetAllocations')          [lock already held]
    └── updateRow('Invoices', ...)

previewAllocation(invoiceId, ruleId)
└── buildAllocationPlan(invoice, rule)   [same code path, nothing written]

getInvoiceDetails(invoiceId)
├── findById('Invoices', invoiceId)
├── findById('Businesses', businessId)
├── getAll('TimeEntries')  [filtered to invoice]
├── getAll('Expenses')     [filtered to invoice]
├── getAll('BudgetAllocations')  [filtered to invoice]
└── getMyDetails()

getBudgetSummary()
├── getAll('BudgetAllocations')
├── getAll('Invoices')
└── getAll('Businesses')

getYearOverview(year)
├── getAll('AccountSummaries')
└── getActive('Accounts')

setupSheets()
├── getSpreadsheet()
│   └── SpreadsheetApp.getActiveSpreadsheet()
├── migrateColumns(ss, schemas)           [append-only, never renames]
├── migrateBudgetAllocations()            [stamps legacy_* keys, idempotent]
└── seedCompanyBudgetRule()               [only if no company rule exists]
    └── addBudgetRule(...) -> validateCompanyRule(...)
```

### ClientWrappers.gs Adapter Pattern

`google.script.run` only supports a single argument per call. Functions that need multiple arguments use `ClientWrappers.gs`, which accepts a pipe-delimited string and splits it:

```
Client:  serverCall('updateInvoiceStatusFromClient', 'INV-2026-001|paid')
Server:  updateInvoiceStatusFromClient('INV-2026-001|paid')
           -> splits on '|'
           -> calls updateInvoiceStatus('INV-2026-001', 'paid')

Client:  serverCall('allocateBudgetFromClient', 'AT0526|BR-001')
Server:  allocateBudgetFromClient('AT0526|BR-001')
           -> splits on '|'
           -> calls allocateBudget('AT0526', 'BR-001')
```

---

## Testing

The app itself only runs inside Apps Script, but the allocation cascade in `src/server/BudgetCategories.gs` deliberately references no Google globals, so it can be exercised locally. No dependencies, no build step:

```bash
node tools/check-budget-math.js         # the cascade arithmetic
node tools/check-budget-integration.js  # allocate -> summarise, with a stubbed Sheets layer
node tools/check-sheet-guards.js        # column guards, schema check, allocation repair
node tools/check-budget-render.js       # Budget page + Dashboard markup and totals
node tools/check-invoice-ids.js         # invoice number format, sequencing and ordering
node tools/check-client-smoke.js        # every client page, tab and edit view renders
```

1. `check-budget-math.js` asserts the conservation invariant (every line sums to gross + GST), that Owner Pay is an exact remainder, that the distribution residual keeps the four personal buckets exact, that each rule-validation failure throws, and that the legacy sole-trader cascade produces figures identical to before the split.
1. `check-budget-integration.js` stands in for the Sheets layer and checks that `allocateBudget` writes exactly what the preview promised, that `getBudgetSummary` returns the scoped shape the Budget page renders, that pre-company allocations resolve by label rather than colliding with the new personal buckets, and that settling and undoing move the right figures.
1. `check-sheet-guards.js` runs `appendRow`/`updateRow`/`checkSchema`/`migrateBudgetAllocations` against an in-memory spreadsheet: a write with no matching column must throw and name it, and the allocation repair must classify per invoice — a company `Spend` becoming `legacy_spend` is the exact corruption it guards against.
1. `check-budget-render.js` feeds a real `getBudgetSummary` result — over a fixture holding both a company allocation set and a complete pre-company one — into the actual render functions from `budget.js.html` and `dashboard.js.html`, then asserts on the markup: every section and bucket present, buckets in order, the right settle verb per bucket, user text escaped, no `undefined`/`NaN` in the page, the section totals reconciling, and the Dashboard's figures matching the Budget page's. It is the only automated check on the client rendering.
1. `check-invoice-ids.js` covers the invoice number format end to end: prefix derivation from awkward names, per-client-per-month sequencing, the `z` -> `aa` suffix rollover, existing bare `MMYY` ids continuing independently, a leading zero stripped by Sheets still being recognised, and chronological ordering (`0625` is June 2025, which sorts *before* `0526` — May 2026 — despite being the larger number).

1. `check-client-smoke.js` loads every client module into one context with a minimal DOM and stubbed server responses, then drives every page, every tab, and every detail/edit view. It asserts nothing throws, no error toast is raised, no promise rejection goes unhandled, and that every `serverCall` the client makes has a fixture — so a call renamed on the server but not the client shows up here. It checks that the pages *run*, not what they look like.

Run all six before pushing any change to the budget, invoice or sheet layer. They do not replace clicking through the deployed app — the real Sheets API and locking are only exercised there.

---

## Troubleshooting

### Stuck on loading spinner

The app loads reference data on every page navigation. If any call hangs:

1. Open browser DevTools (F12 > Console). The app logs every server call with `[serverCall]` prefixes.
2. Look for `TIMEOUT` messages -- these indicate which function isn't responding.
3. Most common cause: **stale deployment**. You updated code but didn't create a new deployment version. See [Updating After Code Changes](#updating-after-code-changes).
4. Second most common: **`setupSheets` wasn't run**, so the sheet tabs don't exist. Run it from the Apps Script editor.

### "Error loading data" message

This means reference data loaded but with errors. Check the console for `[serverCall] FAIL` messages. Usually means:
- Script is not bound to the spreadsheet (it must be created via Extensions > Apps Script from within the spreadsheet)
- Sheet tabs are missing (run `setupSheets`)

### Executions tab errors

In the Apps Script editor, go to **Executions** (left sidebar) to see server-side errors. Common ones:
- `TypeError: Cannot read properties of undefined`: Usually a filter parameter issue. The app guards against this, but check you're on the latest deployment.
- `Exception: You do not have permission`: The script isn't bound to the spreadsheet. Make sure you created it from within the spreadsheet (Extensions > Apps Script), not as a standalone project.

### CSP / Feature-Policy warnings in console

These are normal Google Apps Script warnings (Content Security Policy headers set by Google). They don't affect functionality. Ignore them.

### MutationObserver errors

`TypeError: MutationObserver.observe: Argument 1 is not an object` in `injected.js` -- this is from a **browser extension**, not your app. Ignore it.
