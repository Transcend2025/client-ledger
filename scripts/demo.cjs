/* Generates a real invoice from the fixtures, so the output is reviewable without Obsidian. */
const fs = require("node:fs");
const path = require("node:path");
const core = require("../tests/build/core.cjs");

const FIX = path.join(__dirname, "..", "tests", "fixtures");
const files = fs
  .readdirSync(FIX)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ path: f, content: fs.readFileSync(path.join(FIX, f), "utf8") }));

const opts = { clients: ["Acme", "Northwind", "Beta"], roundTo: 15 };
const aug = core.monthRange("2026-08");

// A deliberately broken note, so the demo also shows the "Not billed" guard instead of hiding it.
files.push({
  path: "2026-08-12.md",
  content: "- 09:00-09:00 @Acme call (typo: same start and end)\n- 3h @Acme real work on the importer\n",
});

const all = core.parseDailyNotes(files, opts);
const entries = all.filter((e) => e.date >= aug.from && e.date <= aug.to);
const flagged = core.suspiciousEntries(entries);
const totals = core.aggregate(entries, { ...opts, ...aug });
const rates = { Acme: 120, Northwind: 80, Beta: 95 };

const inv = core.buildInvoice(totals, rates, {
  number: "INV-202608",
  from: aug.from,
  to: aug.to,
  issueDate: "2026-09-01",
  currency: "USD",
  businessName: "Studio Five",
  businessDetails: "Freelance engineering\nVAT: N/A\npay@studiofive.example",
  notes: "Payable within 14 days. Thank you.",
}, flagged);

const out = path.join(__dirname, "..", "docs", "demo");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "invoice-INV-202608.html"), core.buildInvoiceHtml(inv), "utf8");
fs.writeFileSync(path.join(out, "invoice-INV-202608.md"), core.buildInvoiceMarkdown(inv), "utf8");
fs.writeFileSync(path.join(out, "timesheet-2026-08.csv"), core.buildTimesheetCsv(totals, rates), "utf8");

console.log("clients:", totals.map((t) => `${t.client}=${core.formatDuration(t.minutes)}`).join(", "));
console.log("lines:", inv.lines.map((l) => `${l.client} ${l.hours}h x $${l.rate} = $${l.amount}`).join(" | "));
console.log("TOTAL DUE:", core.money(inv.total, "USD"), "| tracked:", core.formatDuration(inv.minutes));
console.log("excluded from billing:", inv.excluded.length, flagged.map((f) => `${f.date} ${f.raw} => ${core.formatDuration(f.minutes)}`).join(" | "));
console.log("wrote docs/demo/{invoice-INV-202608.html,.md,timesheet-2026-08.csv}");
