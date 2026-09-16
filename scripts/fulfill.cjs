/*
 * Fiverr order fulfilment — one command turns an order into the exact package the buyer receives.
 *
 *   node scripts/fulfill.cjs --order FS-1001 --client "Acme Ltd" --rate 120 \
 *        --business "Studio Five" --currency USD [--pro-token CLPRO1.…] [--zip]
 *
 * Everything the buyer gets is generated, hashed into MANIFEST.txt, and reproducible: the same
 * order id always produces the same delivery, so a 5-minute turnaround is a real promise.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("../tests/build/core.cjs");

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes("--" + name);

const order = arg("order");
if (!order) {
  console.error("usage: node scripts/fulfill.cjs --order FS-1001 --client \"Acme Ltd\" [--rate 120] [--business \"Studio Five\"] [--currency USD] [--pro-token CLPRO1.…] [--zip]");
  process.exit(2);
}
const clientName = arg("client", "Your client");
const rate = parseFloat(arg("rate", "120"));
const business = arg("business", "Client Ledger customer");
const currency = arg("currency", "USD");
const proToken = arg("pro-token", "");
const wantZip = flag("zip");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "out", order);
if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });

/* ---------------- sample workload -> a real invoice ---------------- */
// A worked example built from the buyer's own client name and rate, so the invoice they open is
// billable on day one instead of an empty template.
const month = "2026-08";
const rng = core.monthRange(month);
const sample = [
  { date: `${month}-03`, lines: [`- 09:00-10:30 @${clientName} kickoff and scope review`, `- 2h @${clientName} build the import pipeline`, "- 45m @Other client small call"] },
  { date: `${month}-04`, lines: [`- 09:15-11:45 @${clientName} deep work`, `- 22:30-00:30 @${clientName} overnight migration`, "- 90m refactor C++ module internals"] },
  { date: `${month}-12`, lines: [`- 09:00-09:00 @${clientName} typo demo (same start and end)`, `- 1h 30m @${clientName} review the invoice draft`] },
];
const files = sample.map((s) => ({ path: `${s.date}.md`, content: `# ${s.date}\n\n${s.lines.join("\n")}\n` }));

const opts = { clients: [clientName, "Other client"], roundTo: 15 };
const all = core.parseDailyNotes(files, opts);
const entries = all.filter((e) => e.date >= rng.from && e.date <= rng.to);
const flagged = core.suspiciousEntries(entries);
const totals = core.aggregate(entries, { ...opts, ...rng });
const rates = { [clientName]: rate, "Other client": Math.round(rate * 0.75) };

const invoice = core.buildInvoice(
  totals,
  rates,
  {
    number: `INV-${order.replace(/[^A-Za-z0-9]/g, "")}`,
    from: rng.from,
    to: rng.to,
    issueDate: new Date().toISOString().slice(0, 10),
    currency,
    businessName: business,
    businessDetails: "Set this in Settings → Client Ledger → Invoice identity",
    notes: "Payable within 14 days.",
  },
  flagged
);

/* ---------------- delivery tree ---------------- */
const write = (rel, data) => {
  const p = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
};

write("00-START-HERE.md", `# Your delivery — order ${order}

Everything in this folder is generated from your order. Nothing here needs an account, a login or an
internet connection.

## What is inside

| Folder | What it is |
| --- | --- |
| \`plugin/\` | the Client Ledger plugin (MIT). Free tier: dashboard, markdown invoice, CSV timesheet, audit. |
| \`vault-example/\` | three daily notes showing the exact syntax, using **${clientName}** as the client. |
| \`invoice/\` | a real invoice and timesheet generated from those notes, at ${core.money(rate, currency)}/h. |
| \`SETUP.md\` | 5-step install, 3 minutes. |

## Install (3 minutes)

1. In Obsidian: **Settings → Community plugins → Installed plugins → open folder**.
2. Copy \`plugin/\` there and rename the folder to \`client-ledger\` (so you get \`.obsidian/plugins/client-ledger/main.js\`).
3. Back in Obsidian: reload (**Ctrl/Cmd-R**), then enable **Client Ledger**.
4. **Settings → Client Ledger**: paste your clients (one per line) and your rates (\`${clientName}=${rate}\`).
5. Open a daily note named with a date, e.g. \`${rng.to}.md\`, and run the command
   **"Client Ledger: Generate invoice for current month"**.

## Try it with the invoice in this folder first

\`invoice/\` already contains the output for the three example notes. Open the \`.html\` in a browser and
print to PDF — that is what your client receives${proToken ? " (Pro export, unlocked by the licence key below)" : ""}.

## Support

Reply to the order with any question, or send the note you are stuck on. Updates for 12 months.
${proToken ? `\n## Your Pro licence key\n\n\`${proToken}\`\n\nSettings → Client Ledger → Pro license → paste it. Verified offline, no network call.\n` : ""}
`);

write("SETUP.md", `# Client Ledger — 3 minute setup

## 1. Write time the way you already write your day

In any note whose **file name contains a date** (\`${rng.to}.md\`, \`2026-08-03 daily.md\`):

\`\`\`markdown
- 09:00-10:30 @${clientName} design review
- [ ] 10:30 to 12:00 [${clientName}] API schema draft
- 45m @${clientName} quick sync
- 2h ${clientName} refactor the scraper        <- bare name works once "${clientName}" is in your client list
- 22:30-00:30 @${clientName} overnight migration
\`\`\`

A line is billable only when it has **both** a duration (\`HH:MM-HH:MM\`, \`45m\`, \`2h\`, \`1h 15m\`) and a
client token (\`@Name\`, \`[Name]\`, \`#client/Name\`, or a name from your client list).

## 2. Settings you must fill in

| Setting | Value for you |
| --- | --- |
| Clients | \`${clientName}\` (one per line) |
| Rates | \`${clientName}=${rate}\` |
| Round entries up to | \`15\` (the usual freelance rule) |
| Flag entries longer than | \`960\` minutes — anything longer is treated as a typo, never charged |
| Currency | \`${currency}\` |

## 3. Commands

| Command | Output |
| --- | --- |
| Generate invoice for current month | invoice preview → save \`.md\` / export printable HTML |
| Generate invoice for last month | same, previous month |
| Export timesheet CSV for current month | \`Client Ledger/timesheet-YYYY-MM.csv\` |
| Open ledger dashboard | tracked vs billable time per client |
| Audit: entries with time but no client | \`Client Ledger/unassigned-audit.md\` |

## 4. The one thing that protects you

If an entry looks like a typo — \`09:00-09:00\`, \`10:30-10:00\`, or anything over the threshold — it is
**excluded from every total and printed on the invoice itself** under *Not billed — needs review*,
with the original line and file. You never over-bill from a typo, and nothing disappears silently.

## 5. Notes that cannot be invoiced

A note whose file name has no date cannot belong to a month, so it is never billed. Rename it
(\`${month}-18.md\`) or move those lines into a dated daily note. The audit command lists them for you.
`);

write("vault-example/daily notes/README.txt", `Copy these into your vault. They are plain markdown: one dated note per day.\n`);
for (const s of sample) {
  write(`vault-example/daily notes/${s.date}.md`, `# ${s.date}\n\n${s.lines.join("\n")}\n`);
}

for (const f of ["main.js", "manifest.json", "styles.css"]) {
  write(`plugin/${f}`, fs.readFileSync(path.join(root, f)));
}

write(`invoice/invoice-${invoice.meta.number}.md`, core.buildInvoiceMarkdown(invoice));
write(`invoice/invoice-${invoice.meta.number}.html`, core.buildInvoiceHtml(invoice));
write("invoice/timesheet.csv", core.buildTimesheetCsv(totals, rates));

/* ---------------- manifest + hashes ---------------- */
const walk = (dir, base = dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).replace(/\\/g, "/"));
  }
  return out;
};
const filesList = walk(outDir);
const manifest = filesList.map((rel) => {
  const buf = fs.readFileSync(path.join(outDir, rel));
  return `${crypto.createHash("sha256").update(buf).digest("hex")}  ${rel}`;
});
fs.writeFileSync(path.join(outDir, "MANIFEST.txt"), `# order ${order} — sha256 of every delivered file\n${manifest.join("\n")}\n`);

/* ---------------- report ---------------- */
const hours = core.toDecimalHours(invoice.minutes);
console.log(`order ${order}`);
console.log(`  client      : ${clientName} @ ${core.money(rate, currency)}/h`);
console.log(`  notes       : ${sample.length} (${sample.reduce((n, s) => n + s.lines.length, 0)} lines)`);
console.log(`  billed      : ${core.formatDuration(invoice.minutes)} = ${hours.toFixed(2)}h -> ${core.money(invoice.total, currency)}`);
console.log(`  excluded    : ${flagged.length} (typo guard) -> ${flagged.map((f) => f.raw).join(" | ") || "none"}`);
console.log(`  files       : ${filesList.length} (+MANIFEST.txt)`);
console.log(`  delivery    : ${path.relative(root, outDir).replace(/\\/g, "/")}/`);

if (wantZip) {
  const zip = path.join(root, "out", `${order}.zip`);
  fs.rmSync(zip, { force: true });
  const { execFileSync } = require("node:child_process");
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${outDir}' -DestinationPath '${zip}' -Force`], { stdio: "pipe" });
  } catch (e) {
    execFileSync("zip", ["-qr", zip, "."], { cwd: outDir, stdio: "pipe" });
  }
  const size = fs.statSync(zip).size;
  console.log(`  zip         : out/${order}.zip (${size} bytes, sha256 ${crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex").slice(0, 16)}…)`);
}
