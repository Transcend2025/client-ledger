/*
 * Client Ledger — pure core.
 * No Obsidian imports on purpose: everything here runs in plain Node and is unit tested.
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

// @noble/ed25519 v3 has no bundled hash: its synchronous API needs sha512 injected once.
// Pure JS on purpose — the plugin must also work on Obsidian mobile, where node:crypto is absent.
(ed as unknown as { hashes: { sha512?: typeof sha512 } }).hashes.sha512 = sha512;

export interface LedgerEntry {
  file: string;
  date: string; // YYYY-MM-DD (from filename)
  start: string | null; // HH:MM
  end: string | null; // HH:MM
  minutes: number;
  client: string;
  note: string;
  raw: string;
  line: number;
  /** True when the line looks like a typo (e.g. a range longer than a working day). Never billed. */
  suspicious?: boolean;
}

export interface LedgerOptions {
  /** Known client names. Used for `@token`/`[token]` matching and bare-name matching. */
  clients?: string[];
  /** Round each entry UP to the nearest N minutes (it never rounds down). 0/1 = off. */
  roundTo?: number;
  /** Drop entries shorter than this after rounding. */
  minimumMinutes?: number;
  /**
   * A single entry longer than this is treated as a typo, flagged and never billed.
   * 0 disables the guard. Defaults to MAX_ENTRY_MINUTES (16h).
   */
  maxEntryMinutes?: number;
}

export interface ClientTotal {
  client: string;
  entries: LedgerEntry[];
  minutes: number;
}

export interface InvoiceLine {
  client: string;
  description: string;
  hours: number;
  rate: number;
  amount: number;
}

export interface InvoiceMeta {
  number?: string;
  from?: string;
  to?: string;
  issueDate?: string;
  currency?: string;
  businessName?: string;
  businessDetails?: string;
  notes?: string;
  taxPercent?: number;
}

export interface Invoice {
  meta: InvoiceMeta;
  lines: InvoiceLine[];
  subtotal: number;
  tax: number;
  total: number;
  minutes: number;
  /**
   * Lines that were parsed but deliberately not billed (typo-looking durations). They are printed
   * on the invoice itself so the record survives after the transient Notice is gone.
   */
  excluded?: LedgerEntry[];
}

const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;
// "- 09:00-10:30 @Acme design review" | "- [ ] 9:00 to 11:00 [Acme] fix bug"
const TIME_RANGE_RE = /(\d{1,2}):(\d{2})\s*(?:-|–|—|to|until)\s*(\d{1,2}):(\d{2})/i;
const HOURS_RE = /\b(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i;
const MINUTES_ONLY_RE = /\b(\d+)\s*(?:m|min|mins|minute|minutes)\b/i;
const HOURS_AND_MIN_RE = /\b(\d+)\s*(?:h|hr|hrs|hour|hours)\s*(\d{1,2})\s*(?:m|min|mins)\b/i;
const CHECKBOX_RE = /^\s*(?:[-*+]|\d+\.)\s*(?:\[[ xX>/-]\]\s*)?/;
/**
 * Legacy constant kept for reference; the effective limit comes from
 * LedgerOptions.maxEntryMinutes so a real 17h launch day is not silently dropped.
 */
export const MAX_ENTRY_MINUTES = 16 * 60;
export const DEFAULT_MAX_ENTRY_MINUTES = 16 * 60;

export function parseClock(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

export function formatClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "1h 30m" style for humans. */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Decimal hours, fixed to 2 decimals — what invoice lines use. */
export function toDecimalHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

export function money(amount: number, currency = "USD"): string {
  const symbols: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", CNY: "¥", JPY: "¥" };
  const sym = symbols[currency] ?? "";
  const fixed = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sym ? `${sym}${fixed}` : `${fixed} ${currency}`;
}

export function roundMinutes(minutes: number, roundTo: number): number {
  if (!roundTo || roundTo <= 1) return minutes;
  return Math.ceil(minutes / roundTo) * roundTo;
}

const TAG_RE = /(?:@|#client\/|\[)([^\s\]]+)\]?/g;

/**
 * Client detection order matters:
 *   1. a known client name mentioned anywhere (longest first, so "Acme Corp" wins over "Acme")
 *   2. the first generic tag token — @Name, [Name], #client/Name. A bare "+" is NOT a tag:
 *      "refactor C++ module" must not create a client called "+".
 * The raw line is returned without any client tokens so the invoice description stays clean.
 */
function extractClient(text: string, known: string[]): { client: string | null; rest: string } {
  const ordered = [...known].sort((a, b) => b.length - a.length);

  let client: string | null = null;
  for (const k of ordered) {
    const re = new RegExp(`(?:^|[^\\w])${escapeRe(k)}(?:$|[^\\w])`, "i");
    if (re.test(text)) {
      client = k;
      break;
    }
  }

  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  const tag = new RegExp(TAG_RE.source, "g");
  while ((m = tag.exec(text)) !== null) tokens.push(m[1]);

  let rest = text.replace(new RegExp(TAG_RE.source, "g"), " ");
  for (const k of ordered) rest = rest.replace(new RegExp(escapeRe(k), "gi"), " ");

  if (!client && tokens.length) client = tokens[0].replace(/[.,;:!?]+$/, "");
  return { client, rest };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse a single line into minutes + client, or null if it is not a time entry. */
function parseLine(
  line: string,
  known: string[],
  maxMinutes: number = DEFAULT_MAX_ENTRY_MINUTES
): { minutes: number; client: string | null; note: string; start: string | null; end: string | null; suspicious: boolean } | null {
  let body = line.replace(CHECKBOX_RE, "").trim();
  if (!body) return null;
  // skip headings / comments / code
  if (/^#{1,6}\s/.test(line.trim())) return null;

  let minutes: number | null = null;
  let startClock: string | null = null;
  let endClock: string | null = null;
  let suspicious = false;

  const range = TIME_RANGE_RE.exec(body);
  if (range) {
    const start = parseClock(`${range[1]}:${range[2]}`);
    let end = parseClock(`${range[3]}:${range[4]}`);
    // A range whose end is <= start is assumed to cross midnight — but only if the result still
    // looks like a working session. "09:00-09:00" and "10:30-10:00" are typos, not 24h shifts;
    // they used to be billed as 1440 / 1410 minutes (a 5.4x over-invoice). Flag, never bill.
    if (end <= start) {
      end += 1440;
      if (maxMinutes > 0 && end - start > maxMinutes) suspicious = true;
    }
    minutes = end - start;
    startClock = formatClock(start);
    endClock = formatClock(end);
    body = body.replace(range[0], " ");
  } else {
    const hm = HOURS_AND_MIN_RE.exec(body);
    if (hm) {
      // "2h 90m" is 210 minutes; clamping the minutes field to 59 silently ate 31 of them.
      minutes = parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
      if (maxMinutes > 0 && minutes > maxMinutes) suspicious = true;
      body = body.replace(hm[0], " ");
    } else {
      const h = HOURS_RE.exec(body);
      if (h) {
        minutes = Math.round(parseFloat(h[1].replace(",", ".")) * 60);
        if (maxMinutes > 0 && minutes > maxMinutes) suspicious = true;
        body = body.replace(h[0], " ");
      } else {
        const mo = MINUTES_ONLY_RE.exec(body);
        if (mo) {
          minutes = parseInt(mo[1], 10);
          body = body.replace(mo[0], " ");
        }
      }
    }
  }
  if (minutes === null || minutes <= 0) return null;

  const { client, rest } = extractClient(body, known);
  const note = cleanNote(rest);
  return { minutes, client, note, start: startClock, end: endClock, suspicious };
}

function cleanNote(s: string): string {
  return s
    .replace(/^[\s:|\-–—]+/, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\((\d+(?:[.,]\d+)?\s*[hm]\w*)\)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function hasDateInPath(path: string): boolean {
  return DATE_RE.test(path);
}

/** Parse one daily note. `path` supplies the date; notes without a date in the path are skipped. */
export function parseDailyNote(path: string, content: string, opts: LedgerOptions = {}): LedgerEntry[] {
  const known = opts.clients ?? [];
  const maxMinutes = opts.maxEntryMinutes ?? DEFAULT_MAX_ENTRY_MINUTES;
  const dm = DATE_RE.exec(path);
  // A note whose path carries no date cannot be attributed to a day. v0.1 used the whole path as the
  // "date", so those entries showed up in the dashboard but never in a monthly invoice (480 vs 420).
  if (!dm) return [];
  const date = `${dm[1]}-${dm[2]}-${dm[3]}`;
  const out: LedgerEntry[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const parsed = parseLine(line, known, maxMinutes);
    if (!parsed || !parsed.client) return;
    const minutes = roundMinutes(parsed.minutes, opts.roundTo ?? 0);
    if (minutes < (opts.minimumMinutes ?? 0)) return;
    out.push({
      file: path,
      date,
      start: parsed.start,
      end: parsed.end,
      minutes,
      client: parsed.client,
      note: parsed.note,
      raw: line.trim(),
      line: idx + 1,
      suspicious: parsed.suspicious,
    });
  });
  return out;
}

export function parseDailyNotes(
  files: Array<{ path: string; content: string }>,
  opts: LedgerOptions = {}
): LedgerEntry[] {
  // A vault often keeps copies of the same note (Backup/2026-08-03 copy.md). Identical lines in a
  // *different* file describing the same date+clock+client are the same session: bill it once.
  // Repeats inside one file are left alone (two real sessions can share a description).
  const seen = new Set<string>();
  const out: LedgerEntry[] = [];
  for (const f of files) {
    for (const e of parseDailyNote(f.path, f.content, opts)) {
      const key = [e.date, e.start ?? "", e.end ?? "", e.minutes, e.client, e.note].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Lines whose duration looked like a typo. Surfaced to the user, excluded from every total. */
export function suspiciousEntries(entries: LedgerEntry[]): LedgerEntry[] {
  return entries.filter((e) => e.suspicious);
}

export function inRange(date: string, from?: string, to?: string): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export function aggregate(
  entries: LedgerEntry[],
  opts: LedgerOptions & { from?: string; to?: string } = {}
): ClientTotal[] {
  const byClient = new Map<string, ClientTotal>();
  for (const e of entries) {
    if (e.suspicious) continue; // a flagged typo must never reach an invoice
    if (!inRange(e.date, opts.from, opts.to)) continue;
    let t = byClient.get(e.client);
    if (!t) {
      t = { client: e.client, entries: [], minutes: 0 };
      byClient.set(e.client, t);
    }
    t.entries.push(e);
    t.minutes += e.minutes;
  }
  return [...byClient.values()].sort((a, b) => b.minutes - a.minutes);
}

export function buildInvoice(
  totals: ClientTotal[],
  rates: Record<string, number>,
  meta: InvoiceMeta = {},
  excluded: LedgerEntry[] = []
): Invoice {
  const lines: InvoiceLine[] = [];
  for (const t of totals) {
    const rate = rates[t.client] ?? 0;
    const hours = toDecimalHours(t.minutes);
    lines.push({
      client: t.client,
      description: describe(t),
      hours,
      rate,
      amount: Math.round(hours * rate * 100) / 100,
    });
  }
  const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const tax = meta.taxPercent ? Math.round(subtotal * (meta.taxPercent / 100) * 100) / 100 : 0;
  return {
    meta,
    lines,
    subtotal,
    tax,
    total: Math.round((subtotal + tax) * 100) / 100,
    minutes: totals.reduce((s, t) => s + t.minutes, 0),
    excluded,
  };
}

function describe(t: ClientTotal): string {
  const uniq = [...new Set(t.entries.map((e) => e.note).filter(Boolean))];
  const head = uniq.slice(0, 3).join("; ");
  const more = uniq.length > 3 ? `; +${uniq.length - 3} more` : "";
  const span = t.entries.length ? `${t.entries[0].date} → ${t.entries[t.entries.length - 1].date}` : "";
  return `${formatDuration(t.minutes)} across ${t.entries.length} ${t.entries.length === 1 ? "entry" : "entries"} (${span})${head ? `: ${head}${more}` : more}`;
}

export function buildTimesheetCsv(totals: ClientTotal[], rates: Record<string, number> = {}): string {
  const rows: string[] = ["date,client,start,end,minutes,hours,rate,amount,note"];
  for (const t of totals) {
    const rate = rates[t.client] ?? 0;
    for (const e of t.entries) {
      const hours = toDecimalHours(e.minutes);
      rows.push(
        [
          e.date,
          csv(e.client),
          e.start ?? "",
          e.end ?? "",
          String(e.minutes),
          hours.toFixed(2),
          rate ? rate.toFixed(2) : "",
          rate ? (Math.round(hours * rate * 100) / 100).toFixed(2) : "",
          csv(e.note),
        ].join(",")
      );
    }
  }
  return rows.join("\n") + "\n";
}

function csv(s: string): string {
  // Excel/Sheets execute a cell that starts with = + - @ (and tabs/CR can smuggle one in).
  // Prefixing an apostrophe keeps the text literal without changing what the user sees.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildInvoiceMarkdown(inv: Invoice): string {
  const cur = inv.meta.currency ?? "USD";
  const L: string[] = [];
  L.push(`# Invoice ${inv.meta.number ?? ""}`.trim());
  L.push("");
  if (inv.meta.businessName) L.push(`**From:** ${inv.meta.businessName}`);
  if (inv.meta.businessDetails) L.push(inv.meta.businessDetails);
  if (inv.meta.from || inv.meta.to) L.push(`**Period:** ${inv.meta.from ?? "…"} → ${inv.meta.to ?? "…"}`);
  if (inv.meta.issueDate) L.push(`**Issue date:** ${inv.meta.issueDate}`);
  L.push("");
  L.push("| Client | Description | Hours | Rate | Amount |");
  L.push("| --- | --- | ---: | ---: | ---: |");
  for (const l of inv.lines) {
    L.push(
      `| ${l.client} | ${l.description.replace(/\|/g, "\\|")} | ${l.hours.toFixed(2)} | ${money(l.rate, cur)} | ${money(l.amount, cur)} |`
    );
  }
  L.push(`| | **Subtotal** | **${toDecimalHours(inv.minutes).toFixed(2)}** | | **${money(inv.subtotal, cur)}** |`);
  if (inv.tax) L.push(`| | Tax (${inv.meta.taxPercent}%) | | | **${money(inv.tax, cur)}** |`);
  L.push(`| | **Total due** | | | **${money(inv.total, cur)}** |`);
  if (inv.meta.notes) {
    L.push("");
    L.push(inv.meta.notes);
  }
  if (inv.excluded && inv.excluded.length) {
    L.push("");
    L.push(`## Not billed — needs review (${inv.excluded.length})`);
    L.push("");
    L.push(
      "These lines were left out of every total above because the duration reads like a typo (for example a range longer than a working day). Fix the note and regenerate the invoice to include them."
    );
    L.push("");
    for (const e of inv.excluded) {
      L.push(`- \`${e.date}\` **${formatDuration(e.minutes)}** excluded — \`${e.raw}\` _(${e.file}:${e.line})_`);
    }
  }
  return L.join("\n") + "\n";
}

export function buildInvoiceHtml(inv: Invoice, opts: { printRules?: boolean } = {}): string {
  const cur = inv.meta.currency ?? "USD";
  const rows = inv.lines
    .map(
      (l) => `<tr>
      <td>${esc(l.client)}</td>
      <td class="desc">${esc(l.description)}</td>
      <td class="num">${l.hours.toFixed(2)}</td>
      <td class="num">${esc(money(l.rate, cur))}</td>
      <td class="num">${esc(money(l.amount, cur))}</td>
    </tr>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Invoice ${esc(inv.meta.number ?? "")}</title>
<style>
  :root { --ink:#14161a; --muted:#6b7280; --line:#e5e7eb; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); margin: 0; padding: 48px; background: #fff; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 32px; border-bottom: 2px solid var(--ink); padding-bottom: 16px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.02em; }
  .muted { color: var(--muted); font-size: 13px; }
  .meta { text-align: right; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; margin-top: 28px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); border-bottom: 1px solid var(--ink); }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .desc { color: #374151; font-size: 13px; }
  tfoot td { border: none; padding: 6px 8px; }
  tfoot .total td { border-top: 2px solid var(--ink); font-size: 17px; font-weight: 600; padding-top: 12px; }
  .notes { margin-top: 32px; font-size: 13px; color: #374151; white-space: pre-wrap; }
  .review { margin-top: 36px; border: 1px solid #d97706; border-radius: 6px; padding: 12px 16px; background: #fffbeb; font-size: 12.5px; }
  .review h2 { font-size: 13px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .05em; color: #92400e; }
  .review p { margin: 0 0 8px; color: #92400e; }
  .review ul { margin: 0; padding-left: 18px; }
  .review code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  ${opts.printRules === false ? "" : "@page { size: A4; margin: 16mm; }"}
</style>
</head>
<body>
<header>
  <div>
    <h1>Invoice ${esc(inv.meta.number ?? "")}</h1>
    <div class="muted">${esc(inv.meta.businessName ?? "")}</div>
    <div class="muted">${esc(inv.meta.businessDetails ?? "").replace(/\n/g, "<br>")}</div>
  </div>
  <div class="meta muted">
    ${inv.meta.from || inv.meta.to ? `Period<br><strong>${esc(inv.meta.from ?? "…")} → ${esc(inv.meta.to ?? "…")}</strong>` : ""}
    ${inv.meta.issueDate ? `<br><br>Issued<br><strong>${esc(inv.meta.issueDate)}</strong>` : ""}
  </div>
</header>
<table>
  <thead><tr><th>Client</th><th>Description</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
  <tbody>
${rows}
  </tbody>
  <tfoot>
    <tr><td colspan="4" class="num">Subtotal</td><td class="num">${esc(money(inv.subtotal, cur))}</td></tr>
    ${inv.tax ? `<tr><td colspan="4" class="num">Tax (${inv.meta.taxPercent}%)</td><td class="num">${esc(money(inv.tax, cur))}</td></tr>` : ""}
    <tr class="total"><td colspan="4" class="num">Total due</td><td class="num">${esc(money(inv.total, cur))}</td></tr>
  </tfoot>
</table>
${inv.meta.notes ? `<div class="notes">${esc(inv.meta.notes)}</div>` : ""}
${
  inv.excluded && inv.excluded.length
    ? `<section class="review">
  <h2>Not billed — needs review (${inv.excluded.length})</h2>
  <p>These lines are excluded from every total above because the duration reads like a typo. Fix the note and regenerate.</p>
  <ul>
${inv.excluded
  .map((e) => `    <li><strong>${esc(formatDuration(e.minutes))}</strong> on ${esc(e.date)} — <code>${esc(e.raw)}</code> <span class="muted">(${esc(e.file)}:${e.line})</span></li>`)
  .join("\n")}
  </ul>
</section>`
    : ""
}
</body>
</html>
`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]
  );
}

export function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split("-").map((x) => parseInt(x, 10));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}

/* ------------------------------------------------------------------ *
 * Offline licence verification.
 *
 * v0.1 shipped `/^CLPRO-[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/` — a pattern any buyer can type, so the
 * Pro gate was cosmetic and revenue could not hang off it. Here the plugin carries only a PUBLIC
 * key and verifies a signed token: a key that was not minted with the seller's private key fails.
 * Still zero network calls, so the "no telemetry / no remote resources" review rules hold.
 * ------------------------------------------------------------------ */

/** Raw 32-byte Ed25519 public key (base64url) whose private half lives in the seller's worker. */
export const LICENSE_PUBKEY = "zj2jvHJMqN0VO-2w2t3lGMfL1S5fgERvqk2IyUyZr4k";
export const LICENSE_PREFIX = "CLPRO1";

export interface LicenseStatus {
  pro: boolean;
  reason: string;
  licenseId?: string;
  expires?: string;
}

function b64uToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Verify a license token entirely offline. Never throws — bad input fails closed. */
export function verifyLicenseToken(token: string, nowMs: number = Date.now(), publicRaw: string = LICENSE_PUBKEY): LicenseStatus {
  const fail = (reason: string): LicenseStatus => ({ pro: false, reason });
  if (typeof token !== "string" || !token.trim()) return fail("empty");
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return fail("malformed");
  const [, body, sig] = parts;
  const payloadBytes = b64uToBytes(body);
  const sigBytes = b64uToBytes(sig);
  const pubBytes = b64uToBytes(publicRaw);
  if (!payloadBytes || !sigBytes || !pubBytes || pubBytes.length !== 32 || sigBytes.length !== 64) return fail("malformed");

  const msg = new TextEncoder().encode(`${LICENSE_PREFIX}.${body}`);
  let ok = false;
  try {
    ok = ed.verify(sigBytes, msg, pubBytes);
  } catch {
    return fail("bad_signature");
  }
  if (!ok) return fail("bad_signature");

  let payload: { v?: number; lic?: string; plan?: string; iat?: number; exp?: number };
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return fail("bad_payload");
  }
  if (payload.v !== 1) return fail("unsupported_version");
  if (typeof payload.exp !== "number" || nowMs > payload.exp * 1000) return fail("expired");
  if (typeof payload.iat === "number" && payload.iat * 1000 > nowMs + 86400000) return fail("issued_in_future");
  return { pro: true, reason: "ok", licenseId: payload.lic, expires: new Date(payload.exp * 1000).toISOString() };
}
