import { Notice, Plugin, TFile } from "obsidian";
import { fmt } from "./date-utils";
import { api, bodyFromForm, clearGoogleCache, eventsUrl, GoogleCtx, GoogleEventForm } from "./google";
import type { NoteCalendar } from "./nuovo-evento";
import type { ReminderSettings } from "./promemoria";

export interface VaultSyncSettings {
  enabled: boolean;
  account: string;
  calendarId: string;
  // Le note con fine più vecchia di N giorni non vengono mandate a Google
  pastDays: number;
}

export const DEFAULT_VAULT_SYNC: VaultSyncSettings = {
  enabled: false,
  account: "",
  calendarId: "",
  pastDays: 30,
};

interface Host extends Plugin {
  settings: {
    noteCalendars: NoteCalendar[];
    reminders: ReminderSettings;
    google: GoogleCtx["google"];
    vaultSync: VaultSyncSettings;
  };
  saveSettings(): Promise<void>;
  refreshViews(): void;
}

interface Remote {
  id: string;
  status?: string;
  extendedProperties?: { private?: Record<string, string> };
}

interface Wanted {
  body: Record<string, unknown>;
  hash: string;
}

// Id deterministico dal percorso della nota: due dispositivi non creano doppioni.
// Google accetta id di 5-1024 caratteri in [a-v0-9]; l'esadecimale va bene.
async function eventId(path: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(path));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Sync a senso unico: le note del vault sono la fonte, il calendario Google «Vault» è una copia in sola lettura.
export class VaultSync {
  private timer: number | undefined;
  private syncing = false;

  constructor(private plugin: Host) {}

  private get cfg() {
    return this.plugin.settings.vaultSync;
  }

  // Cartelle sincronizzate: calendari nota + promemoria iscrizione esami
  private sources(): { folder: string; stripNumber: boolean }[] {
    const { noteCalendars, reminders } = this.plugin.settings;
    const out = noteCalendars
      .filter((c) => c.folder)
      .map((c) => ({ folder: c.folder, stripNumber: c.name !== "Dentista" }));
    if (reminders.enabled && reminders.remFolder) out.push({ folder: reminders.remFolder, stripNumber: false });
    return out;
  }

  register() {
    const { plugin } = this;
    const { app } = plugin;
    plugin.addCommand({
      id: "sync-google-vault",
      name: "Sincronizza note su Google Calendar «Vault»",
      callback: () => void this.sync(true),
    });
    const inSrc = (path: string) => this.sources().some((s) => path.startsWith(s.folder + "/"));
    const trigger = (f: { path: string }) => {
      if (inSrc(f.path)) this.schedule();
    };
    plugin.registerEvent(app.vault.on("create", trigger));
    plugin.registerEvent(app.vault.on("delete", trigger));
    plugin.registerEvent(
      app.vault.on("rename", (f, old) => {
        if (inSrc(f.path) || inSrc(old ?? "")) this.schedule();
      }),
    );
    plugin.registerEvent(app.metadataCache.on("changed", trigger));
    app.workspace.onLayoutReady(() => this.schedule(10_000));
  }

  unload() {
    window.clearTimeout(this.timer);
  }

  private schedule(delay = 8000) {
    if (!this.cfg.enabled) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.sync(false), delay);
  }

  private async collect(): Promise<Map<string, Wanted>> {
    const { vault, metadataCache } = this.plugin.app;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.cfg.pastDays);
    const cut = fmt(cutoff);
    const want = new Map<string, Wanted>();
    for (const f of vault.getMarkdownFiles()) {
      const src = this.sources().find((s) => f.path.startsWith(s.folder + "/"));
      if (!src) continue;
      const form = this.formFromNote(f, src.stripNumber);
      if (!form || (form.endDate || form.date) < cut) continue;
      const body = {
        ...bodyFromForm(form),
        // Notifiche: quelle predefinite del calendario «Vault» in Google Calendar
        reminders: { useDefault: true },
      };
      const hash = hashString(JSON.stringify(body));
      want.set(await eventId(f.path), {
        body: { ...body, extendedProperties: { private: { vaultSync: "1", h: hash, path: f.path } } },
        hash,
      });
    }
    return want;
  }

  private formFromNote(f: TFile, stripNumber: boolean): GoogleEventForm | null {
    const fm = this.plugin.app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm?.date) return null;
    const date = String(fm.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const endDate = fm.endDate ? String(fm.endDate).slice(0, 10) : "";
    const startTime = fm.startTime ? String(fm.startTime) : "";
    const endTime = fm.endTime ? String(fm.endTime) : "";
    const allDay = fm.allDay === true || !startTime || !endTime;
    const title = stripNumber ? f.basename.replace(/ \d+$/, "") : f.basename;
    return { title, date, endDate, allDay, startTime, endTime, location: "", description: "" };
  }

  private async listRemote(ctx: GoogleCtx): Promise<Remote[]> {
    const { account, calendarId } = this.cfg;
    const out: Remote[] = [];
    let token = "";
    do {
      const q = new URLSearchParams({ privateExtendedProperty: "vaultSync=1", maxResults: "2500" });
      if (token) q.set("pageToken", token);
      const j = await api<{ items?: Remote[]; nextPageToken?: string }>(
        ctx,
        account,
        `${eventsUrl(calendarId)}?${q}`,
      );
      out.push(...(j.items ?? []));
      token = j.nextPageToken ?? "";
    } while (token);
    return out;
  }

  async sync(manual: boolean) {
    const { account, calendarId, enabled } = this.cfg;
    if (this.syncing || !enabled) return;
    if (!account || !calendarId) {
      if (manual) new Notice("Sync Google: scegli account e calendario nelle impostazioni");
      return;
    }
    this.syncing = true;
    try {
      const plugin = this.plugin;
      const ctx: GoogleCtx = { google: plugin.settings.google, save: () => plugin.saveSettings() };
      const want = await this.collect();
      const remote = new Map((await this.listRemote(ctx)).map((e) => [e.id, e]));
      let created = 0,
        updated = 0,
        deleted = 0;
      for (const [id, w] of want) {
        const r = remote.get(id);
        if (r && r.status !== "cancelled" && r.extendedProperties?.private?.h === w.hash) continue;
        const body = { ...w.body, id };
        if (r) {
          await api(ctx, account, eventsUrl(calendarId, id), "PATCH", { ...w.body, status: "confirmed" });
          updated++;
        } else {
          try {
            await api(ctx, account, eventsUrl(calendarId), "POST", body);
            created++;
          } catch (e) {
            // 409: id già usato da un evento cancellato in precedenza → lo riattiva
            if (!String(e).includes(" 409")) throw e;
            await api(ctx, account, eventsUrl(calendarId, id), "PATCH", { ...w.body, status: "confirmed" });
            updated++;
          }
        }
      }
      for (const [id, r] of remote) {
        if (want.has(id) || r.status === "cancelled") continue;
        await api(ctx, account, eventsUrl(calendarId, id), "DELETE");
        deleted++;
      }
      clearGoogleCache();
      if (manual || created + updated + deleted > 0)
        new Notice(`Google «Vault»: ${created} creati, ${updated} aggiornati, ${deleted} eliminati`);
    } catch (e) {
      console.error("Calendario Vault: sync Google", e);
      new Notice(`Sync Google fallito: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.syncing = false;
    }
  }
}
