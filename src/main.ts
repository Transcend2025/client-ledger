import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";
import {
  aggregate,
  buildInvoice,
  buildInvoiceHtml,
  buildInvoiceMarkdown,
  buildTimesheetCsv,
  formatDuration,
  monthRange,
  money,
  parseDailyNotes,
  type ClientTotal,
  type Invoice,
  type LedgerEntry,
  type LedgerOptions,
} from "./core";

interface Settings {
  dailyNotesFolder: string;
  clients: string; // newline separated
  rates: string; // "Acme=120" per line
  roundTo: number;
  minimumMinutes: number;
  currency: string;
  businessName: string;
  businessDetails: string;
  paymentTerms: string;
  invoiceNumber: string;
  licenseKey: string;
}

const DEFAULTS: Settings = {
  dailyNotesFolder: "",
  clients: "",
  rates: "",
  roundTo: 0,
  minimumMinutes: 0,
  currency: "USD",
  businessName: "",
  businessDetails: "",
  paymentTerms: "Payable within 14 days.",
  invoiceNumber: "",
  licenseKey: "",
};

export default class ClientLedger extends Plugin {
  settings!: Settings;
  private lastInvoice: Invoice | null = null;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "invoice-current-month",
      name: "Generate invoice for current month",
      callback: () => this.runInvoice(0),
    });
    this.addCommand({
      id: "invoice-last-month",
      name: "Generate invoice for last month",
      callback: () => this.runInvoice(-1),
    });
    this.addCommand({
      id: "timesheet-csv-current-month",
      name: "Export timesheet CSV for current month",
      callback: () => this.runCsv(0),
    });
    this.addCommand({
      id: "ledger-dashboard",
      name: "Open ledger dashboard",
      callback: () => this.openDashboard(),
    });
    this.addCommand({
      id: "audit-pending-tasks",
      name: "Audit: list entries with time but no client",
      callback: () => void this.auditUnassigned(),
    });

    this.addRibbonIcon("receipt", "Client Ledger", () => this.openDashboard());
    this.addSettingTab(new LedgerSettingTab(this.app, this));
  }

  /* ---------------- settings ---------------- */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  clientList(): string[] {
    return this.settings.clients
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  rateMap(): Record<string, number> {
    const map: Record<string, number> = {};
    for (const line of this.settings.rates.split("\n")) {
      const m = /^\s*(.+?)\s*[=:]\s*(-?[\d.,]+)\s*$/.exec(line);
      if (m) map[m[1].trim()] = parseFloat(m[2].replace(",", "."));
    }
    return map;
  }

  options(): LedgerOptions {
    return {
      clients: this.clientList(),
      roundTo: this.settings.roundTo,
      minimumMinutes: this.settings.minimumMinutes,
    };
  }

  isPro(): boolean {
    // v0.1: offline entitlement. Keys are issued manually after purchase and
    // checked locally; no network call is made (see README "Payment" disclosure).
    return /^CLPRO-[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(this.settings.licenseKey.trim().toUpperCase());
  }

  /* ---------------- data ---------------- */

  async scan(range?: { from: string; to: string }) {
    const folder = this.settings.dailyNotesFolder.trim();
    const prefix = folder ? normalizePath(folder) + "/" : "";
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f: TFile) => (prefix ? f.path.startsWith(prefix) : true));
    const payload: Array<{ path: string; content: string }> = [];
    for (const f of files) {
      const dm = /(\d{4})-(\d{2})-(\d{2})/.exec(f.path);
      const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : "";
      if (range && date && (date < range.from || date > range.to)) continue;
      payload.push({ path: f.path, content: await this.app.vault.read(f) });
    }
    return parseDailyNotes(payload, this.options());
  }

  async computeTotals(ym?: string): Promise<ClientTotal[]> {
    const range = ym ? monthRange(ym) : undefined;
    const entries = await this.scan(range);
    return aggregate(entries, { ...this.options(), ...(range ?? {}) });
  }

  /* ---------------- actions ---------------- */

  private ym(offset: number): string {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  async runInvoice(offset: number) {
    const ym = this.ym(offset);
    const { from, to } = monthRange(ym);
    const totals = await this.computeTotals(ym);
    if (!totals.length) {
      new Notice(`Client Ledger: no billable entries found for ${ym}. Add lines like "- 09:00-10:30 @Acme design review".`);
      return;
    }
    const invoice = buildInvoice(totals, this.rateMap(), {
      number: this.settings.invoiceNumber || `INV-${ym.replace("-", "")}`,
      from,
      to,
      issueDate: new Date().toISOString().slice(0, 10),
      currency: this.settings.currency,
      businessName: this.settings.businessName,
      businessDetails: this.settings.businessDetails,
      notes: this.settings.paymentTerms,
    });
    this.lastInvoice = invoice;
    new LedgerModal(this.app, invoice, totals, this).open();
  }

  async runCsv(offset: number) {
    const ym = this.ym(offset);
    const totals = await this.computeTotals(ym);
    if (!totals.length) {
      new Notice(`Client Ledger: nothing to export for ${ym}.`);
      return;
    }
    const csvText = buildTimesheetCsv(totals, this.rateMap());
    const path = normalizePath(`Client Ledger/timesheet-${ym}.csv`);
    await this.writeFile(path, csvText);
    new Notice(`Client Ledger: timesheet saved to ${path}`);
  }

  async auditUnassigned() {
    const files = this.app.vault.getMarkdownFiles();
    const orphan: string[] = [];
    for (const f of files.slice(0, 2000)) {
      const content = await this.app.vault.read(f);
      content.split(/\r?\n/).forEach((line, i) => {
        if (/(\d{1,2}:\d{2}\s*(?:-|–|—|to)\s*\d{1,2}:\d{2})|\b\d+\s*(?:h|min|m)\b/i.test(line) && !/@|\[[^\]]+\]/.test(line)) {
          orphan.push(`${f.path}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    const report = orphan.length
      ? `# Unassigned time entries\n\n${orphan.map((l) => "- " + l).join("\n")}\n`
      : "# Unassigned time entries\n\nNothing found. Every timed line has a client token.\n";
    const path = normalizePath("Client Ledger/unassigned-audit.md");
    await this.writeFile(path, report);
    new Notice(`Client Ledger: ${orphan.length} unassigned line(s) → ${path}`);
  }

  private async writeFile(path: string, data: string) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, data);
    else await this.app.vault.create(path, data);
  }

  async openDashboard() {
    const totals = await this.computeTotals();
    new DashboardModal(this.app, totals, this).open();
  }

  async exportMarkdown(inv: Invoice) {
    const md = buildInvoiceMarkdown(inv);
    const path = normalizePath(`Client Ledger/invoice-${inv.meta.number ?? "draft"}.md`);
    await this.writeFile(path, md);
    new Notice(`Client Ledger: invoice note saved to ${path}`);
  }

  async exportHtml(inv: Invoice) {
    if (!this.isPro()) {
      new Notice("Client Ledger: invoice/PDF export is a Pro feature. Enter your license key in settings.", 6000);
      return;
    }
    const html = buildInvoiceHtml(inv);
    const path = normalizePath(`Client Ledger/invoice-${inv.meta.number ?? "draft"}.html`);
    await this.writeFile(path, html);
    const url = this.app.vault.adapter.getResourcePath(path);
    window.open(url, "_blank");
    new Notice("Client Ledger: invoice opened in browser — print to PDF from there.");
  }
}

/* ---------------- UI ---------------- */

class DashboardModal extends Modal {
  constructor(app: App, private totals: ClientTotal[], private plugin: ClientLedger) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Client Ledger — all billable time" });
    const rates = this.plugin.rateMap();
    if (!this.totals.length) {
      contentEl.createEl("p", {
        text: 'No billable entries found. Format: "- 09:00-10:30 @Client what you did" (or "- 45m @Client …").',
      });
      return;
    }
    const table = contentEl.createEl("table", { cls: "cl-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const h of ["Client", "Entries", "Time", "Rate", "Amount"]) head.createEl("th", { text: h });
    const total = contentEl.createEl("p");
    let amount = 0;
    for (const t of this.totals) {
      const rate = rates[t.client] ?? 0;
      const amt = (t.minutes / 60) * rate;
      amount += amt;
      const tr = table.createEl("tbody").createEl("tr");
      tr.createEl("td", { text: t.client });
      tr.createEl("td", { text: String(t.entries.length) });
      tr.createEl("td", { text: formatDuration(t.minutes) });
      tr.createEl("td", { text: rate ? money(rate, this.plugin.settings.currency) : "—" });
      tr.createEl("td", { text: rate ? money(Math.round(amt * 100) / 100, this.plugin.settings.currency) : "—" });
    }
    total.createEl("strong", { text: `Tracked: ${formatDuration(this.totals.reduce((s, t) => s + t.minutes, 0))}  ·  Billable: ${money(Math.round(amount * 100) / 100, this.plugin.settings.currency)}` });
  }
  onClose() {
    this.contentEl.empty();
  }
}

class LedgerModal extends Modal {
  constructor(app: App, private invoice: Invoice, private totals: ClientTotal[], private plugin: ClientLedger) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    const cur = this.invoice.meta.currency ?? "USD";
    contentEl.createEl("h2", { text: `Invoice ${this.invoice.meta.number ?? ""}` });
    contentEl.createEl("p", { text: `Period ${this.invoice.meta.from} → ${this.invoice.meta.to}` });
    const table = contentEl.createEl("table", { cls: "cl-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const h of ["Client", "Hours", "Rate", "Amount"]) head.createEl("th", { text: h });
    for (const l of this.invoice.lines) {
      const tr = table.createEl("tbody").createEl("tr");
      tr.createEl("td", { text: l.client });
      tr.createEl("td", { text: l.hours.toFixed(2) });
      tr.createEl("td", { text: money(l.rate, cur) });
      tr.createEl("td", { text: money(l.amount, cur) });
    }
    contentEl.createEl("p").createEl("strong", { text: `Total due: ${money(this.invoice.total, cur)}` });

    const bar = contentEl.createDiv({ cls: "cl-buttons" });
    bar.createEl("button", { text: "Save invoice note (.md)" }).onclick = () => void this.plugin.exportMarkdown(this.invoice);
    const html = bar.createEl("button", { text: "Export printable invoice (Pro)" });
    html.onclick = () => void this.plugin.exportHtml(this.invoice);
    bar.createEl("button", { text: "Copy markdown" }).onclick = async () => {
      await navigator.clipboard.writeText(buildInvoiceMarkdown(this.invoice));
      new Notice("Client Ledger: invoice markdown copied.");
    };
    if (!this.plugin.isPro()) {
      contentEl.createEl("p", { cls: "cl-hint", text: "Pro unlocks printable HTML/PDF invoice export with your branding and license key. Free tier: dashboard, markdown invoice, CSV timesheet." });
    }
  }
  onClose() {
    this.contentEl.empty();
  }
}

class LedgerSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ClientLedger) {
    super(app, plugin);
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Client Ledger" });

    new Setting(containerEl)
      .setName("Daily notes folder")
      .setDesc("Vault-relative folder to scan. Leave empty to scan the whole vault.")
      .addText((t) => t.setValue(this.plugin.settings.dailyNotesFolder).onChange(async (v) => {
        this.plugin.settings.dailyNotesFolder = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Clients")
      .setDesc("One per line. Used to recognise @tokens and bare names in your notes.")
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.clients).onChange(async (v) => {
          this.plugin.settings.clients = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName("Rates")
      .setDesc("One per line as Client=rate, e.g. Acme=120")
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.rates).onChange(async (v) => {
          this.plugin.settings.rates = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName("Round entries up to")
      .setDesc("Minutes. 0 disables rounding. 15 is the common freelance rule.")
      .addText((t) => t.setValue(String(this.plugin.settings.roundTo)).onChange(async (v) => {
        this.plugin.settings.roundTo = parseInt(v, 10) || 0;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Minimum billable entry (minutes)")
      .setDesc("Entries shorter than this are ignored.")
      .addText((t) => t.setValue(String(this.plugin.settings.minimumMinutes)).onChange(async (v) => {
        this.plugin.settings.minimumMinutes = parseInt(v, 10) || 0;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Currency")
      .setDesc("USD, EUR, GBP, CNY…")
      .addText((t) => t.setValue(this.plugin.settings.currency).onChange(async (v) => {
        this.plugin.settings.currency = v.trim().toUpperCase() || "USD";
        await this.plugin.saveSettings();
      }));

    containerEl.createEl("h3", { text: "Invoice identity" });
    new Setting(containerEl).setName("Business name").addText((t) =>
      t.setValue(this.plugin.settings.businessName).onChange(async (v) => {
        this.plugin.settings.businessName = v;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Business details").setDesc("Address, tax ID, bank line — multi-line.").addTextArea((t) => {
      t.setValue(this.plugin.settings.businessDetails).onChange(async (v) => {
        this.plugin.settings.businessDetails = v;
        await this.plugin.saveSettings();
      });
      t.inputEl.rows = 3;
    });
    new Setting(containerEl).setName("Payment terms").addText((t) =>
      t.setValue(this.plugin.settings.paymentTerms).onChange(async (v) => {
        this.plugin.settings.paymentTerms = v;
        await this.plugin.saveSettings();
      })
    );

    containerEl.createEl("h3", { text: "Pro license" });
    new Setting(containerEl)
      .setName("License key")
      .setDesc("Format CLPRO-XXXX-XXXX-XXXX-XXXX. Verified locally, no network call.")
      .addText((t) => t.setValue(this.plugin.settings.licenseKey).onChange(async (v) => {
        this.plugin.settings.licenseKey = v.trim();
        await this.plugin.saveSettings();
      }));
  }
}
