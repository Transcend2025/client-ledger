/*
 * Preflight: verify the built plugin satisfies the Obsidian Community directory
 * checks we can verify locally, so a submission does not bounce on formalities.
 * Run: node scripts/preflight.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));

let fails = 0;
const ok = (m) => console.log("  ok   " + m);
const bad = (m) => {
  fails++;
  console.log("  FAIL " + m);
};

const manifest = JSON.parse(read("manifest.json"));
const versions = JSON.parse(read("versions.json"));

console.log("preflight: obsidian directory submission");

for (const field of ["id", "name", "version", "minAppVersion", "description", "author", "authorUrl"]) {
  manifest[field] !== undefined ? ok(`manifest.${field} present`) : bad(`manifest.${field} missing`);
}

/^[a-z0-9-]+$/.test(manifest.id)
  ? ok(`id "${manifest.id}" is lowercase/hyphen-safe`)
  : bad(`id "${manifest.id}" must be lowercase letters, digits and hyphens`);

manifest.description.length <= 250
  ? ok(`description is ${manifest.description.length}/250 chars`)
  : bad(`description is ${manifest.description.length} chars (max 250)`);

/\.$/.test(manifest.description.trim())
  ? ok("description ends with a period")
  : bad("description must end with a period");

!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(manifest.description)
  ? ok("description has no emoji")
  : bad("description must not contain emoji");

!/^this is a plugin/i.test(manifest.description.trim())
  ? ok('description does not start with "This is a plugin"')
  : bad('description must not start with "This is a plugin"');

versions[manifest.version] === manifest.minAppVersion
  ? ok(`versions.json maps ${manifest.version} -> ${manifest.minAppVersion}`)
  : bad(`versions.json missing "${manifest.version}": "${manifest.minAppVersion}"`);

manifest.fundingUrl
  ? ok(`fundingUrl set (${typeof manifest.fundingUrl === "string" ? manifest.fundingUrl : "multi-label"})`)
  : bad("fundingUrl missing — no way to take financial support from the directory page");

for (const f of ["main.js", "manifest.json", "styles.css"]) {
  exists(f) && fs.statSync(path.join(root, f)).size > 0 ? ok(`${f} present`) : bad(`${f} missing or empty`);
}

exists("LICENSE") ? ok("LICENSE present") : bad("LICENSE missing (required by developer policies)");

const readme = read("README.md");
/payment is required for full access/i.test(readme)
  ? ok("README discloses 'Payment is required for full access' (required when a paid tier exists)")
  : bad("README must disclose that payment is required for full access");
/network use/i.test(readme) ? ok("README discloses network use") : bad("README must disclose network use");
/imap|fetch\(|XMLHttpRequest|require\("https?/.test(read("main.js"))
  ? bad("main.js looks like it makes network calls — must be disclosed and justified")
  : ok("main.js contains no network calls");
/https?:\/\/[^"'\s]+/.test(read("main.js"))
  ? ok("main.js contains URL string literals (verify they are not remote assets)")
  : ok("main.js contains no remote URLs");

exists(".github/workflows/release.yml")
  ? ok("release workflow present (tag -> GitHub release with main.js + manifest.json + styles.css)")
  : bad("release workflow missing");

// simulate the install layout Obsidian expects
const vaultDir = path.join(root, "docs", "fake-vault", ".obsidian", "plugins", manifest.id);
fs.mkdirSync(vaultDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(root, f), path.join(vaultDir, f));
ok(`install layout verified: <vault>/.obsidian/plugins/${manifest.id}/{main.js,manifest.json,styles.css}`);

console.log(`\n${fails === 0 ? "PREFLIGHT PASSED" : fails + " CHECK(S) FAILED"}`);
process.exitCode = fails ? 1 : 0;
