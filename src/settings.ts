import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { NoteCalendar } from "./nuovo-evento";
import { DEFAULT_REMINDERS, ReminderSettings } from "./promemoria";
import { DEFAULT_VAULT_SYNC, VaultSyncSettings } from "./vault-sync";
import { clearExternalCache, ExternalCalendar } from "./external";
import {
  buildAuthUrl,
  clearGoogleCache,
  completeLogin,
  GoogleConfig,
  listCalendars,
  PendingAuth,
  REDIRECT_URI,
} from "./google";

export interface CalendarioSettings {
  calendars: ExternalCalendar[];
  noteCalendars: NoteCalendar[];
  reminders: ReminderSettings;
  google: GoogleConfig;
  vaultSync: VaultSyncSettings;
}

export const DEFAULT_SETTINGS: CalendarioSettings = {
  calendars: [],
  noteCalendars: [],
  reminders: DEFAULT_REMINDERS,
  google: { clientId: "", clientSecret: "", accounts: [] },
  vaultSync: DEFAULT_VAULT_SYNC,
};

interface Host extends Plugin {
  settings: CalendarioSettings;
  saveSettings(): Promise<void>;
}

export class CalendarioSettingTab extends PluginSettingTab {
  private pending: PendingAuth | null = null;
  private pastedUrl = "";
  private authUrl = "";

  constructor(
    app: App,
    private plugin: Host,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const g = s.google;

    containerEl.createEl("h2", { text: "Account Google" });
    const help = containerEl.createEl("details");
    help.createEl("summary", { text: "Come ottenere Client ID e Secret (una volta sola)" });
    const ol = help.createEl("ol");
    [
      "console.cloud.google.com → crea un progetto.",
      "API e servizi → Libreria → abilita «Google Calendar API».",
      "Schermata consenso OAuth → tipo «Esterno» → compila nome e email. Poi «Pubblica app» (stato «In produzione»): in «Test» il login scade dopo 7 giorni.",
      `Credenziali → Crea credenziali → ID client OAuth → tipo «App desktop». Copia Client ID e Client secret qui sotto.`,
      `Il login finisce su ${REDIRECT_URI} (pagina che non si carica: è normale). Copia l'intero URL dalla barra degli indirizzi e incollalo qui sotto.`,
      "Google mostrerà «app non verificata»: Avanzate → Vai a … (è la tua app).",
    ].forEach((t) => ol.createEl("li", { text: t }));

    new Setting(containerEl).setName("Client ID").addText((t) =>
      t.setValue(g.clientId).onChange(async (v) => {
        g.clientId = v.trim();
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("Client secret").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(g.clientSecret).onChange(async (v) => {
        g.clientSecret = v.trim();
        await this.plugin.saveSettings();
      });
    });

    new Setting(containerEl)
      .setName("Accedi con Google")
      .setDesc("Apre il browser. Dopo il consenso copia l'URL della pagina finale e incollalo sotto.")
      .addButton((b) =>
        b.setButtonText("Apri login").setCta().onClick(async () => {
          if (!g.clientId || !g.clientSecret) return new Notice("Inserisci Client ID e Client secret");
          const { url, pending } = await buildAuthUrl(g);
          this.pending = pending;
          this.authUrl = url;
          // Su iPhone window.open dopo un await viene bloccato: mostro anche un link da toccare
          try {
            window.open(url);
          } catch {
            // ignorato: resta il link sotto
          }
          this.display();
        }),
      );
    if (this.authUrl) {
      const row = containerEl.createDiv({ cls: "setting-item-description" });
      row.createEl("a", { text: "Tocca qui per aprire il login Google", href: this.authUrl });
      row.createEl("div", { text: "Se il browser non si apre, copia il link:" });
      row.createEl("input", { type: "text", value: this.authUrl, attr: { readonly: "true", style: "width:100%" } });
    }
    new Setting(containerEl)
      .setName("URL di ritorno")
      .addText((t) => {
        t.setPlaceholder(`${REDIRECT_URI}/?state=...&code=...`).setValue(this.pastedUrl).onChange((v) => (this.pastedUrl = v));
      })
      .addButton((b) =>
        b.setButtonText("Conferma").onClick(async () => {
          if (!this.pending) return new Notice("Prima premi «Apri login»");
          try {
            const acc = await completeLogin(g, this.pending, this.pastedUrl);
            const i = g.accounts.findIndex((a) => a.email === acc.email);
            if (i >= 0) g.accounts[i] = { ...acc, refreshToken: acc.refreshToken || g.accounts[i].refreshToken };
            else g.accounts.push(acc);
            this.pending = null;
            this.authUrl = "";
            this.pastedUrl = "";
            await this.plugin.saveSettings();
            new Notice(`Collegato: ${acc.email}`);
            this.display();
          } catch (e) {
            new Notice(`Login fallito: ${(e as Error).message}`, 8000);
          }
        }),
      );

    g.accounts.forEach((acc) => {
      new Setting(containerEl)
        .setName(acc.email)
        .addButton((b) =>
          b.setButtonText("Importa calendari").onClick(async () => {
            try {
              const list = await listCalendars({ google: g, save: () => this.plugin.saveSettings() }, acc.email);
              let added = 0;
              for (const c of list) {
                const exists = s.calendars.some(
                  (x) => x.type === "google" && x.account === acc.email && x.calendarId === c.id,
                );
                if (exists) continue;
                s.calendars.push({
                  type: "google",
                  name: c.summary,
                  color: c.color,
                  enabled: true,
                  account: acc.email,
                  calendarId: c.id,
                });
                added++;
              }
              await this.plugin.saveSettings();
              new Notice(`Aggiunti ${added} calendari`);
              this.display();
            } catch (e) {
              new Notice(`Errore: ${(e as Error).message}`, 8000);
            }
          }),
        )
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("Scollega account").onClick(async () => {
            g.accounts = g.accounts.filter((a) => a.email !== acc.email);
            s.calendars = s.calendars.filter((c) => !(c.type === "google" && c.account === acc.email));
            await this.plugin.saveSettings();
            this.display();
          }),
        );
    });

    containerEl.createEl("h2", { text: "Calendari esterni" });
    s.calendars.forEach((cal, i) => {
      const row = new Setting(containerEl).addText((t) =>
        t.setPlaceholder("Nome").setValue(cal.name).onChange(async (v) => {
          cal.name = v.trim();
          await this.plugin.saveSettings();
        }),
      );
      if (cal.type === "google") row.setDesc(`Google · ${cal.account}`);
      else
        row.addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("URL iCal segreto").setValue(cal.url).onChange(async (v) => {
            cal.url = v.trim();
            await this.plugin.saveSettings();
          });
        });
      row
        .addColorPicker((c) =>
          c.setValue(cal.color).onChange(async (v) => {
            cal.color = v;
            await this.plugin.saveSettings();
          }),
        )
        .addToggle((t) =>
          t.setValue(cal.enabled).onChange(async (v) => {
            cal.enabled = v;
            await this.plugin.saveSettings();
          }),
        )
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("Elimina").onClick(async () => {
            s.calendars.splice(i, 1);
            await this.plugin.saveSettings();
            this.display();
          }),
        );
    });

    new Setting(containerEl)
      .addButton((b) =>
        b.setButtonText("Aggiungi calendario iCal").onClick(async () => {
          s.calendars.push({ type: "ics", name: `iCal ${s.calendars.length + 1}`, url: "", color: "#4285f4", enabled: true });
          await this.plugin.saveSettings();
          this.display();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Svuota cache").onClick(() => {
          clearExternalCache();
          clearGoogleCache();
          new Notice("Cache svuotata: riapri la vista per ricaricare");
        }),
      );

    containerEl.createEl("h2", { text: "Calendari nota (form «Nuovo evento»)" });
    containerEl.createEl("p", {
      text: "Ogni calendario crea una nota per occorrenza nella cartella indicata, con il frontmatter del database (.base).",
    });
    const field = (parent: HTMLElement, name: string, get: () => string, set: (v: string) => void) =>
      new Setting(parent).setName(name).addText((t) =>
        t.setValue(get()).onChange(async (v) => {
          set(v.trim());
          await this.plugin.saveSettings();
        }),
      );
    s.noteCalendars.forEach((nc, i) => {
      const det = containerEl.createEl("details");
      det.createEl("summary", { text: nc.name || `Calendario ${i + 1}` });
      field(det, "Nome", () => nc.name, (v) => (nc.name = v));
      field(det, "Cartella delle note", () => nc.folder, (v) => (nc.folder = v));
      field(det, "File .base", () => nc.base, (v) => (nc.base = v));
      field(det, "Tag", () => nc.tag, (v) => (nc.tag = v));
      field(det, "Proprietà data", () => nc.dateKey, (v) => (nc.dateKey = v));
      new Setting(det).setName("Priorità e Completato").addToggle((t) =>
        t.setValue(!!nc.taskFields).onChange(async (v) => {
          nc.taskFields = v;
          await this.plugin.saveSettings();
        }),
      );
      new Setting(det).addButton((b) =>
        b.setButtonText("Elimina").onClick(async () => {
          s.noteCalendars.splice(i, 1);
          await this.plugin.saveSettings();
          this.display();
        }),
      );
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Aggiungi calendario nota").onClick(async () => {
        s.noteCalendars.push({ name: `Calendario ${s.noteCalendars.length + 1}`, folder: "", base: "", tag: "", dateKey: "Date" });
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    containerEl.createEl("h2", { text: "Sync su Google Calendar (per widget e notifiche)" });
    const v = s.vaultSync;
    containerEl.createEl("p", {
      text: "Copia a senso unico (note → Google): un calendario Google per ogni calendario nota, collegato per nome. Crea prima su calendar.google.com un calendario vuoto con lo stesso nome di ciascun calendario nota (e «Iscrizioni Esami» per i promemoria), poi premi «Collega calendari». Non attivare gli stessi calendari anche tra i «Calendari esterni». Notifiche e colori: quelli del calendario in Google.",
    });
    new Setting(containerEl).setName("Attiva sync").addToggle((t) =>
      t.setValue(v.enabled).onChange(async (val) => {
        v.enabled = val;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("Account").addDropdown((d) => {
      d.addOption("", "—");
      g.accounts.forEach((a) => d.addOption(a.email, a.email));
      d.setValue(v.account).onChange(async (val) => {
        v.account = val;
        v.map = {};
        await this.plugin.saveSettings();
        this.display();
      });
    });
    const sources = [
      ...s.noteCalendars.filter((c) => c.name && c.folder).map((c) => c.name),
      ...(s.reminders.enabled ? ["Iscrizioni Esami"] : []),
    ];
    new Setting(containerEl)
      .setName("Collega calendari")
      .setDesc(sources.map((n) => `${v.map[n] ? "✓" : "✗"} ${n}`).join("  ·  ") || "Nessun calendario nota")
      .addButton((b) =>
        b.setButtonText("Collega calendari").onClick(async () => {
          if (!v.account) return new Notice("Scegli prima l'account");
          try {
            const list = await listCalendars({ google: g, save: () => this.plugin.saveSettings() }, v.account);
            // Solo calendari di cui sei proprietario, uno per nome: uno condiviso con lo stesso nome riceverebbe i titoli delle note
            const map: Record<string, string> = {};
            const problems: string[] = [];
            for (const name of sources) {
              const hits = list.filter((c) => c.owner && c.summary.trim().toLowerCase() === name.toLowerCase());
              if (hits.length === 1) map[name] = hits[0].id;
              else problems.push(`${name} (${hits.length ? "più di uno" : "manca"})`);
            }
            v.map = map;
            await this.plugin.saveSettings();
            if (problems.length) new Notice(`Non collegati: ${problems.join(", ")}`);
            this.display();
          } catch (e) {
            new Notice(`Errore: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );
    new Setting(containerEl)
      .setName("Giorni nel passato")
      .setDesc("Le note con fine più vecchia di N giorni non vengono mandate (e vengono tolte da Google).")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "0";
        t.setValue(String(v.pastDays)).onChange(async (val) => {
          v.pastDays = Math.max(0, parseInt(val) || 0);
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h2", { text: "Promemoria iscrizione esami" });
    const r = s.reminders;
    new Setting(containerEl)
      .setName("Attiva promemoria")
      .setDesc("Per ogni nota nella cartella delle prove crea una nota promemoria con riga Tasks.")
      .addToggle((t) =>
        t.setValue(r.enabled).onChange(async (v) => {
          r.enabled = v;
          await this.plugin.saveSettings();
        }),
      );
    field(containerEl, "Cartella delle prove", () => r.srcFolder, (v) => (r.srcFolder = v));
    field(containerEl, "Cartella dei promemoria", () => r.remFolder, (v) => (r.remFolder = v));
    field(containerEl, "Prefisso del nome file", () => r.prefix, (v) => (r.prefix = v));
    new Setting(containerEl).setName("Giorni prima della prova").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.min = "1";
      t.setValue(String(r.days)).onChange(async (v) => {
        r.days = Math.max(1, parseInt(v) || DEFAULT_REMINDERS.days);
        await this.plugin.saveSettings();
      });
    });
  }
}
