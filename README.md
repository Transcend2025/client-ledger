# Client Ledger

Turn daily note time entries into client timesheets and invoices. Runs entirely inside your vault — no account, no server, no network calls.

## What it does

You already write your day in a daily note. Client Ledger reads the timed lines that name a client and turns a month of them into:

- a **dashboard** of tracked vs. billable time per client
- a **markdown invoice note** saved into your vault
- a **printable HTML invoice** (print → PDF) with your business details
- a **CSV timesheet** (date, client, start, end, minutes, hours, rate, amount, note)
- an **audit report** listing every timed line that has no client yet, so unbilled work is visible before you invoice

## Syntax

Any of these lines in a daily note (any note with a `YYYY-MM-DD` in its file name) count:

```markdown
- 09:00-10:30 @Acme design review
- [ ] 10:30 to 12:00 [Acme] API schema draft
- 45m @Northwind quick sync
- 2h Acme refactor the scraper          <- bare client name, if Acme is in your client list
- 22:30-00:30 @Northwind overnight migration   <- ranges crossing midnight work
```

A line only becomes billable when it has **both** a duration (a `HH:MM-HH:MM` range, `45m`, `2h`, or `1h 15m`) and a client token (`@Name`, `[Name]`, `#client/Name`, `+Name`, or a known client name). Everything else in your note is ignored.

Set your clients and rates in **Settings → Client Ledger**:

```
Acme
Northwind
Beta
```

```
Acme=120
Northwind=80
```

## Commands

| Command | What it produces |
| --- | --- |
| Client Ledger: Generate invoice for current month | invoice preview → save `.md`, export printable HTML, or copy markdown |
| Client Ledger: Generate invoice for last month | same, previous month |
| Client Ledger: Export timesheet CSV for current month | `Client Ledger/timesheet-YYYY-MM.csv` |
| Client Ledger: Open ledger dashboard | time + money per client across the whole vault |
| Client Ledger: Audit: list entries with time but no client | `Client Ledger/unassigned-audit.md` |

## Disclosures

**Payment is required for full access** to some features. The free tier covers the dashboard, the markdown invoice note, the CSV timesheet and the audit report. The Pro license unlocks printable HTML/PDF invoice export with your own branding.

**Account required:** No. There is no account and no login.

**Network use:** none. Client Ledger makes no network requests. License keys are verified locally in the plugin; it never phones home. Confirmed by the test suite: generated invoices contain no remote asset references.

**Files outside the vault:** not accessed. Only markdown files inside your vault are read, and generated files are written to your vault.

**Telemetry:** none, client-side or server-side.

## Not billed — needs review

An entry whose duration reads like a typo is never charged and never silently dropped. A range that ends before it starts (`09:00-09:00`, `10:30-10:00`) or any single entry longer than the threshold (default 960 minutes / 16h, configurable, `0` = guard off) is:

- excluded from every total, and
- printed on the invoice itself, under **Not billed — needs review**, with the original line and file:line

A genuine long day is a one-click fix: raise the threshold in settings, or split the entry. Nothing disappears into a transient notification.

## Pro licence

The free tier covers the dashboard, the markdown invoice note, the CSV timesheet, the audit report and the excluded-lines record. Pro unlocks the printable HTML/PDF invoice export.

Pro keys are signed tokens of the form `CLPRO1.<payload>.<signature>`, minted by the seller. The plugin embeds only the **public** key and verifies the signature **offline** — a key you typed yourself, or one signed by anyone else, will not unlock Pro. To buy one, see <https://github.com/Transcend2025>.

## Install

1. Build: `npm install && npm run build` (produces `main.js`)
2. Copy `main.js`, `manifest.json` and `styles.css` into `<your vault>/.obsidian/plugins/client-ledger/`
3. Enable **Client Ledger** in Settings → Community plugins → Installed plugins

## Development

```bash
npm install
npm test        # bundles src/core.ts and runs the 30-assertion core suite in plain Node
npm run build   # tsc --noEmit + esbuild -> main.js
node scripts/demo.cjs   # writes a real invoice to docs/demo/ from the fixtures
```

`src/core.ts` has no Obsidian imports on purpose: parsing, rounding, aggregation, money and rendering are all unit tested in Node, so the invoice math is verifiable without launching the app.

## License

MIT (see LICENSE). The bundled invoice renderer is MIT; the Pro license gate is a separate commercial entitlement.
