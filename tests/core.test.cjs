/* Node-runnable unit tests for the pure core. */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./build/core.cjs");

const FIX = path.join(__dirname, "fixtures");
const files = fs
  .readdirSync(FIX)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ path: f, content: fs.readFileSync(path.join(FIX, f), "utf8") }));

const opts = { clients: ["Acme", "Northwind", "Beta"] };
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    console.error("  FAIL " + name + "\n       " + e.message);
    process.exitCode = 1;
  }
}

console.log("client-ledger core tests");

const entries = core.parseDailyNotes(files, opts);

test("parses only client-tagged timed lines (5 in fixture 08-03, 3 in 08-04, 2 in 09-01)", () => {
  assert.strictEqual(entries.length, 10, "got " + entries.length);
});

test("drops lines with a time range but no client", () => {
  assert.ok(!entries.some((e) => e.raw.includes("meeting with no client")));
});

test("parses checkbox syntax, ranges and durations", () => {
  const aug3 = entries.filter((e) => e.date === "2026-08-03").map((e) => [e.client, e.minutes]);
  assert.deepStrictEqual(aug3, [
    ["Acme", 90],
    ["Acme", 90],
    ["Northwind", 45],
    ["Acme", 120],
    ["Northwind", 60],
  ]);
});

test("handles overnight ranges (22:30 -> 00:30 = 120m)", () => {
  const e = entries.find((x) => x.date === "2026-08-04" && x.client === "Northwind" && x.minutes === 120);
  assert.ok(e, "overnight entry not found");
});

test("recognises bare client names and '1h 15m' durations", () => {
  const betas = entries.filter((e) => e.date === "2026-09-01");
  assert.strictEqual(betas.length, 2);
  assert.strictEqual(betas[0].client, "Beta");
  assert.strictEqual(betas[0].minutes, 180);
  assert.strictEqual(betas[1].client, "Acme");
  assert.strictEqual(betas[1].minutes, 75);
});

test("rounds up to the nearest increment", () => {
  const rounded = core.parseDailyNotes(files, { ...opts, roundTo: 30 });
  const aug3 = rounded.filter((e) => e.date === "2026-08-03").map((e) => e.minutes);
  // 90/120/60 are already multiples of 30; the 45m entry becomes 60
  assert.deepStrictEqual(aug3, [90, 90, 60, 120, 60]);
});

test("rounds a non-multiple entry up (1h 07m -> 90m at 30m increments)", () => {
  const one = core.parseDailyNote("2026-08-06.md", "- 09:00-10:07 @Acme odd job", { clients: ["Acme"], roundTo: 30 });
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].minutes, 90);
  const off = core.parseDailyNote("2026-08-06.md", "- 09:00-10:07 @Acme odd job", { clients: ["Acme"] });
  assert.strictEqual(off[0].minutes, 67);
});

test("aggregates per client and filters by period", () => {
  const aug = core.monthRange("2026-08");
  const totals = core.aggregate(entries, { ...opts, ...aug });
  assert.strictEqual(totals.length, 2);
  const byName = Object.fromEntries(totals.map((t) => [t.client, t.minutes]));
  assert.strictEqual(byName.Acme, 450);
  assert.strictEqual(byName.Northwind, 255);
});

test("builds an invoice with correct hours and money", () => {
  const aug = core.monthRange("2026-08");
  const totals = core.aggregate(entries, { ...opts, ...aug });
  const inv = core.buildInvoice(totals, { Acme: 120, Northwind: 80 }, {
    number: "INV-202608",
    currency: "USD",
    taxPercent: 0,
    from: aug.from,
    to: aug.to,
  });
  assert.strictEqual(inv.lines.length, 2);
  assert.strictEqual(inv.lines[0].hours, 7.5);
  assert.strictEqual(inv.lines[0].amount, 900);
  assert.strictEqual(inv.lines[1].hours, 4.25);
  assert.strictEqual(inv.lines[1].amount, 340);
  assert.strictEqual(inv.subtotal, 1240);
  assert.strictEqual(inv.total, 1240);
});

test("applies tax on top of the subtotal", () => {
  const aug = core.monthRange("2026-08");
  const totals = core.aggregate(entries, { ...opts, ...aug });
  const inv = core.buildInvoice(totals, { Acme: 100, Northwind: 100 }, { taxPercent: 10 });
  assert.strictEqual(inv.subtotal, 1175);
  assert.strictEqual(inv.tax, 117.5);
  assert.strictEqual(inv.total, 1292.5);
});
// 7.5h*100 + 4.25h*100 = 1175

test("renders markdown invoice with totals row", () => {
  const aug = core.monthRange("2026-08");
  const totals = core.aggregate(entries, { ...opts, ...aug });
  const inv = core.buildInvoice(totals, { Acme: 120, Northwind: 80 }, { number: "INV-1", currency: "USD" });
  const md = core.buildInvoiceMarkdown(inv);
  assert.ok(md.includes("| Acme |"), "missing Acme row");
  assert.ok(md.includes("$1,240.00"), "expected $1,240.00 in:\n" + md);
  assert.ok(md.includes("**Total due**"));
});

test("renders standalone html with no external resources", () => {
  const aug = core.monthRange("2026-08");
  const totals = core.aggregate(entries, { ...opts, ...aug });
  const inv = core.buildInvoice(totals, { Acme: 120 }, { number: "INV-2", businessName: "Studio <A&B>" });
  const html = core.buildInvoiceHtml(inv);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(!/https?:\/\//.test(html), "html must not pull remote assets (Obsidian policy: no network assets)");
  assert.ok(html.includes("Studio &lt;A&amp;B&gt;"), "escaping failed");
  assert.ok(html.includes("@page"));
});

test("csv timesheet has a header plus one row per entry", () => {
  const aug = core.monthRange("2026-08");
  const totals = core.aggregate(entries, { ...opts, ...aug });
  const csv = core.buildTimesheetCsv(totals, { Acme: 120 });
  const rows = csv.trim().split("\n");
  assert.strictEqual(rows[0], "date,client,start,end,minutes,hours,rate,amount,note");
  assert.strictEqual(rows.length, 1 + 8);
});

test("monthRange returns real month end (leap year included)", () => {
  assert.deepStrictEqual(core.monthRange("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepStrictEqual(core.monthRange("2028-02"), { from: "2028-02-01", to: "2028-02-29" });
  assert.deepStrictEqual(core.monthRange("2026-12"), { from: "2026-12-01", to: "2026-12-31" });
});

test("formats durations and money", () => {
  assert.strictEqual(core.formatDuration(255), "4h 15m");
  assert.strictEqual(core.formatDuration(60), "1h");
  assert.strictEqual(core.formatDuration(45), "45m");
  assert.strictEqual(core.money(1240, "USD"), "$1,240.00");
  assert.strictEqual(core.money(1240, "CNY"), "¥1,240.00");
});

test("minimumMinutes filters short entries", () => {
  const kept = core.parseDailyNotes(files, { ...opts, minimumMinutes: 60 });
  assert.ok(kept.every((e) => e.minutes >= 60));
  assert.strictEqual(kept.length, 8);
});

test("keeps start/end clock times for the timesheet export", () => {
  const e = entries.find((x) => x.date === "2026-08-03" && x.client === "Acme" && x.minutes === 90);
  assert.strictEqual(e.start, "09:00");
  assert.strictEqual(e.end, "10:30");
  const overnight = entries.find((x) => x.date === "2026-08-04" && x.minutes === 120);
  assert.strictEqual(overnight.start, "22:30");
  assert.strictEqual(overnight.end, "00:30");
});

console.log("\n" + passed + " passed");
if (process.exitCode) console.error("SOME TESTS FAILED");
