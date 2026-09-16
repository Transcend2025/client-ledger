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


/* ---- regression tests for the adversarial findings + 0.1.2 fixes ---- */

test("typo range 09:00-09:00 is flagged and never billed", () => {
  const e = core.parseDailyNote("2026-08-10.md", "- 09:00-09:00 @Acme call", { clients: ["Acme"] });
  assert.strictEqual(e[0].minutes, 1440);
  assert.strictEqual(e[0].suspicious, true);
  assert.strictEqual(core.aggregate(e, { clients: ["Acme"] }).length, 0, "a flagged typo must not reach a total");
});

test("10:30-10:00 is flagged too, but a real midnight crossing is not", () => {
  const bad = core.parseDailyNote("2026-08-10.md", "- 10:30-10:00 @Acme backfill", { clients: ["Acme"] });
  assert.strictEqual(bad[0].suspicious, true);
  const good = core.parseDailyNote("2026-08-10.md", "- 22:30-00:30 @Acme night shift", { clients: ["Acme"] });
  assert.strictEqual(good[0].suspicious, false);
  assert.strictEqual(good[0].minutes, 120);
});

test("a real 17h shift is not silently dropped when the limit allows it", () => {
  const note = "- 18:00-11:00 @Acme launch day";
  const strict = core.parseDailyNote("2026-08-11.md", note, { clients: ["Acme"] });
  assert.strictEqual(strict[0].suspicious, true);
  const relaxed = core.parseDailyNote("2026-08-11.md", note, { clients: ["Acme"], maxEntryMinutes: 1200 });
  assert.strictEqual(relaxed[0].suspicious, false);
  assert.strictEqual(core.aggregate(relaxed, { clients: ["Acme"] })[0].minutes, 1020);
});

test("maxEntryMinutes: 0 disables the guard entirely", () => {
  const e = core.parseDailyNote("2026-08-12.md", "- 09:00-09:00 @Acme call", { clients: ["Acme"], maxEntryMinutes: 0 });
  assert.strictEqual(e[0].suspicious, false);
});

test("excluded lines are printed on the invoice, not only in a Notice", () => {
  const entries = core.parseDailyNote(
    "2026-08-13.md",
    "- 09:00-09:00 @Acme call\n- 2h @Acme real work",
    { clients: ["Acme"] }
  );
  const totals = core.aggregate(entries, { clients: ["Acme"] });
  const inv = core.buildInvoice(totals, { Acme: 120 }, { number: "INV-X", currency: "USD" }, core.suspiciousEntries(entries));
  assert.strictEqual(inv.total, 240, "only the real 2h may be billed");
  const md = core.buildInvoiceMarkdown(inv);
  assert.ok(md.includes("Not billed"), md);
  assert.ok(md.includes("09:00-09:00 @Acme call"), md);
  const html = core.buildInvoiceHtml(inv);
  assert.ok(html.includes("Not billed"));
  assert.ok(!/https?:\/\//.test(html), "no remote assets in the printable invoice");
});

test("notes with no date in the path are never billed (dashboard/invoice drift)", () => {
  assert.deepStrictEqual(core.parseDailyNote("Daily/scratch.md", "- 2h @Acme work", { clients: ["Acme"] }), []);
  assert.strictEqual(core.hasDateInPath("Daily/2026-08-03.md"), true);
  assert.strictEqual(core.hasDateInPath("Daily/scratch.md"), false);
});

test("duplicate copies of the same note are billed once", () => {
  const body = "- 90m @Acme design review";
  const two = core.parseDailyNotes(
    [{ path: "2026-08-05.md", content: body }, { path: "Backup/2026-08-05 copy.md", content: body }],
    { clients: ["Acme"] }
  );
  assert.strictEqual(two.length, 1);
});

test("C++ is not a client, and A+B keeps its text", () => {
  assert.deepStrictEqual(core.parseDailyNote("2026-08-07.md", "- 90m refactor C++ module internals", { clients: [] }), []);
  const e2 = core.parseDailyNote("2026-08-07.md", "- 60m @Acme wire A+B harness", { clients: ["Acme"] });
  assert.strictEqual(e2[0].client, "Acme");
  assert.ok(e2[0].note.includes("A+B"), e2[0].note);
});

test("'2h 90m' is 210 minutes", () => {
  const e = core.parseDailyNote("2026-08-08.md", "- 2h 90m @Acme long haul", { clients: ["Acme"] });
  assert.strictEqual(e[0].minutes, 210);
});

test("csv cells starting with = are neutralised", () => {
  const e = core.parseDailyNote("2026-08-09.md", "- 60m @Acme =SUM(A1:A99)", { clients: ["Acme"] });
  const csv = core.buildTimesheetCsv(core.aggregate(e, { clients: ["Acme"] }));
  assert.ok(csv.includes("'=SUM(A1:A99)"), csv);
});

/* ---- licence tokens: verified entirely offline, fail closed ---- */

const crypto = require("node:crypto");

function mint(payload) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.sign(null, Buffer.from("CLPRO1." + body), privateKey).toString("base64url");
  return { token: "CLPRO1." + body + "." + sig, pub: publicKey.export({ format: "jwk" }).x };
}

test("a properly signed token verifies against its own public key", () => {
  const now = Math.floor(Date.now() / 1000);
  const { token, pub } = mint({ v: 1, lic: "T-1", plan: "pro", iat: now, exp: now + 86400 });
  const s = core.verifyLicenseToken(token, Date.now(), pub);
  assert.strictEqual(s.pro, true, s.reason);
  assert.strictEqual(s.licenseId, "T-1");
});

test("the shipped public key rejects a token signed by another key", () => {
  const now = Math.floor(Date.now() / 1000);
  const { token } = mint({ v: 1, lic: "T-2", iat: now, exp: now + 86400 });
  assert.strictEqual(core.verifyLicenseToken(token).pro, false, "foreign signature must not unlock Pro");
});

test("tampered payload, expired token and future iat all fail closed", () => {
  const now = Math.floor(Date.now() / 1000);
  const { token, pub } = mint({ v: 1, lic: "T-3", iat: now, exp: now + 86400 });
  const parts = token.split(".");
  const other = Buffer.from(JSON.stringify({ v: 1, lic: "T-3", iat: now, exp: now + 315360000 })).toString("base64url");
  assert.strictEqual(core.verifyLicenseToken(parts[0] + "." + other + "." + parts[2], Date.now(), pub).reason, "bad_signature");
  const expired = mint({ v: 1, lic: "T-4", iat: now - 100000, exp: now - 10 });
  assert.strictEqual(core.verifyLicenseToken(expired.token, Date.now(), expired.pub).reason, "expired");
  const future = mint({ v: 1, lic: "T-5", iat: now + 604800, exp: now + 86400 });
  assert.strictEqual(core.verifyLicenseToken(future.token, Date.now(), future.pub).reason, "issued_in_future");
  for (const junk of ["", "CLPRO-AAAA-BBBB-CCCC-DDDD", "CLPRO1.abc.def", "CLPRO1....", "not-a-token", parts[0] + "." + parts[1] + "."]) {
    assert.strictEqual(core.verifyLicenseToken(junk).pro, false, "should reject: " + junk);
  }
});


test("a multi-word client name is fully removed from the description", () => {
  const e = core.parseDailyNote("2026-08-14.md", "- 09:00-10:30 @Acme Ltd kickoff and scope review", { clients: ["Acme Ltd"] });
  assert.strictEqual(e[0].client, "Acme Ltd");
  assert.strictEqual(e[0].note, "kickoff and scope review", "stray word left behind: " + JSON.stringify(e[0].note));
  const e2 = core.parseDailyNote("2026-08-14.md", "- 45m @Other client small call", { clients: ["Acme Ltd", "Other client"] });
  assert.strictEqual(e2[0].client, "Other client");
  assert.strictEqual(e2[0].note, "small call", JSON.stringify(e2[0].note));
  const e3 = core.parseDailyNote("2026-08-14.md", "- 2h @Northwind Corp monthly retainer, invoice 3", { clients: ["Northwind Corp"] });
  assert.strictEqual(e3[0].note, "monthly retainer, invoice 3", JSON.stringify(e3[0].note));
});

console.log("\n" + passed + " passed");
if (process.exitCode) console.error("SOME TESTS FAILED");
