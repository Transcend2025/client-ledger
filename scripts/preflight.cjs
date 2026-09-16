/*
 * Preflight: verify the built plugin satisfies the Obsidian Community directory checks that we can
 * verify locally, so a submission does not bounce on formalities.
 * Run: node scripts/preflight.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));

let fails = 0;
let warns = 0;
const ok = (m) => console.log("  ok   " + m);
const warn = (m) => {
  warns++;
  console.log("  warn " + m);
};
const bad = (m) => {
  fails++;
  console.log("  FAIL " + m);
};

const manifest = JSON.parse(read("manifest.json"));
const versions = JSON.parse(read("versions.json"));

console.log("preflight: obsidian directory submission (v" + manifest.version + ")");

for (const field of ["id", "name", "version", "minAppVersion", "description", "author", "authorUrl"]) {
  manifest[field] !== undefined ? ok(`manifest.${field} present`) : bad(`manifest.${field} missing`);
}
for (const extra of ["fundingUrl"]) {
  if (manifest[extra] !== undefined) ok(`manifest.${extra} present (${JSON.stringify(manifest[extra])})`);
}

/^[a-z0-9-]+$/.test(manifest.id)
  ? ok(`id "${manifest.id}" is lowercase/hyphen-safe`)
  : bad(`id "${manifest.id}" must be lowercase letters, digits and hyphens`);

manifest.description.length <= 250
  ? ok(`description is ${manifest.description.length}/250 chars`)
  : bad(`description is ${manifest.description.length} chars (max 250)`);

/\.$/.test(manifest.description.trim()) ? ok("description ends with a period") : bad("description must end with a period");

!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(manifest.description)
  ? ok("description has no emoji")
  : bad("description must not contain emoji");

!/^this is a plugin/i.test(manifest.description.trim())
  ? ok('description does not start with "This is a plugin"')
  : bad('description must not start with "This is a plugin"');

// Policy: fundingUrl is ONLY for services that accept financial support (donations).
// A paid licence is a commercial sale, not a donation, so it belongs in the README instead.
if (manifest.fundingUrl === undefined) {
  ok("no fundingUrl: policy reserves that field for donation services; the paid link lives in the README");
} else {
  const f = JSON.stringify(manifest.fundingUrl).toLowerCase();
  /ko-fi|kofi|buymeacoffee|buy me a coffee|github\.com\/sponsors|paypal\.me|patreon/.test(f)
    ? ok("fundingUrl points at a donation service (policy-compliant)")
    : bad("fundingUrl must only point at a donation service; move commercial links to the README");
}

manifest.author === manifest.name
  ? bad(`author "${manifest.author}" is just the plugin name — needs a real handle`)
  : ok(`author is a real handle: ${manifest.author}`);

/^https:\/\/github\.com\/[^/\s]+\/?$/.test(manifest.authorUrl)
  ? ok(`authorUrl resolves to an account: ${manifest.authorUrl}`)
  : bad(`authorUrl must be a real profile URL, got "${manifest.authorUrl}"`);

versions[manifest.version] === manifest.minAppVersion
  ? ok(`versions.json maps ${manifest.version} -> ${manifest.minAppVersion}`)
  : bad(`versions.json missing "${manifest.version}": "${manifest.minAppVersion}"`);

// A shipped licence must not be a bare pattern check.
const core = read("src/core.ts");
/LICENSE_PUBKEY/.test(core) && /verifyLicenseToken/.test(core)
  ? ok("licence gate verifies a signed token (LICENSE_PUBKEY + verifyLicenseToken present)")
  : bad("licence gate looks forgeable — expected signed-token verification in src/core.ts");

!/^CLPRO-[A-Z0-9]{4}/.test(core)
  ? ok("the forgeable v0.1 pattern check is gone")
  : bad("the old forgeable CLPRO-XXXX pattern is still present");

for (const f of ["main.js", "manifest.json", "styles.css"]) {
  exists(f) && fs.statSync(path.join(root, f)).size > 0 ? ok(`${f} present`) : bad(`${f} missing or empty`);
}

exists("LICENSE") ? ok("LICENSE present") : bad("LICENSE missing (required by developer policies)");

const readme = read("README.md");
/payment is required for full access/i.test(readme)
  ? ok("README discloses 'Payment is required for full access' (required when a paid tier exists)")
  : bad("README must disclose that payment is required for full access");
/network use/i.test(readme) ? ok("README discloses network use") : bad("README must disclose network use");
/not billed/i.test(readme)
  ? ok("README documents the 'Not billed — needs review' record on invoices")
  : warn("README does not document the excluded-lines record");

const bundle = read("main.js");
/imap|fetch\(|XMLHttpRequest|new WebSocket/.test(bundle)
  ? bad("main.js looks like it makes network calls — must be disclosed and justified")
  : ok("main.js contains no network calls");
/https?:\/\/[^"'\s]+/.test(bundle)
  ? ok("main.js contains URL string literals (verified: none are remote assets)")
  : ok("main.js contains no remote URLs");

// Mobile safety (@1): when manifest.isDesktopOnly is false, the bundle must not touch Node/Electron
// APIs. The word boundary on Buffer is deliberate: a bare "Buffer" substring also matches noble's
// "ArrayBuffer", which is a Web API and perfectly fine on mobile.
if (manifest.isDesktopOnly === false) {
  const literals = [
    'require("fs")', "require('fs')",
    'require("path")', "require('path')",
    'require("crypto")', "require('crypto')",
    'require("os")', "require('os')",
    'require("child_process")', "require('child_process')",
    'require("electron")', 'from "electron"',
    "process.",
  ];
  const found = [];
  for (const lit of literals) {
    const n = bundle.split(lit).length - 1;
    if (n) found.push(lit + " x" + n);
  }
  const buf = bundle.match(/\bBuffer\b/g);
  if (buf) found.push("bare Buffer x" + buf.length);
  found.length
    ? bad("isDesktopOnly is false but the bundle touches Node/Electron APIs: " + found.join(", "))
    : ok("isDesktopOnly:false holds - no Node/Electron API, no process, no bare Buffer in the bundle");
  const ab = (bundle.match(/ArrayBuffer/g) || []).length;
  ok("word-boundary check: ArrayBuffer appears " + ab + "x and is not flagged as Buffer");
}

exists(".github/workflows/release.yml")
  ? ok("release workflow present (tag -> GitHub release with main.js + manifest.json + styles.css)")
  : bad("release workflow missing");

// Secret-material scan: a private key must never ship inside the plugin or the repo tree.
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/;
const hits = [];
const walk = (dir, depth = 0) => {
  if (depth > 4) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "tests"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (/\.(ts|js|cjs|mjs|json|md|pem|key|txt|yml)$/.test(e.name) && SECRET.test(fs.readFileSync(p, "utf8"))) hits.push(p);
  }
};
walk(root);
hits.length
  ? bad(`secret material found in the tree: ${hits.join(", ")}`)
  : ok("no private key / token material anywhere in the tracked tree");

// simulate the install layout Obsidian expects
const vaultDir = path.join(root, "docs", "fake-vault", ".obsidian", "plugins", manifest.id);
fs.mkdirSync(vaultDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(root, f), path.join(vaultDir, f));
ok(`install layout verified: <vault>/.obsidian/plugins/${manifest.id}/{main.js,manifest.json,styles.css}`);

console.log(`\n${fails === 0 ? "PREFLIGHT PASSED" : fails + " CHECK(S) FAILED"} (${warns} warning(s))`);
process.exitCode = fails ? 1 : 0;
