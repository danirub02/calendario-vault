import { normalizePath, Notice, Plugin, TFile, TFolder } from "obsidian";
import { addStep, fmt, parse } from "./date-utils";

// Promemoria automatici: per ogni prova in SRC_FOLDER crea una nota in REM_FOLDER REM_DAYS giorni prima
// (13: l'iscrizione apre 15 giorni prima, e il giorno dopo è sicuramente già aperta).
const SRC_FOLDER = "Università/Esami Università";
const REM_FOLDER = "Università/Iscrizioni Esami";
const REM_PREFIX = "Iscrizione - ";
const REM_DAYS = 13;

export class ReminderSync {
  private syncTimer: number | undefined;
  private syncing = false;

  constructor(private plugin: Plugin) {}

  register() {
    const { plugin } = this;
    const { app } = plugin;
    plugin.addCommand({
      id: "sync-promemoria",
      name: "Sincronizza promemoria iscrizione esami",
      callback: () => void this.sync(true),
    });
    const inSrc = (path: string) => path.startsWith(SRC_FOLDER + "/");
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
    app.workspace.onLayoutReady(() => this.schedule());
  }

  unload() {
    window.clearTimeout(this.syncTimer);
  }

  private schedule() {
    window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => void this.sync(false), 1500);
  }

  // Allinea REM_FOLDER a SRC_FOLDER: crea/aggiorna i promemoria, elimina quelli orfani.
  // Nome file deterministico, così due dispositivi non creano doppioni.
  private async sync(manual: boolean) {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const { vault, metadataCache, fileManager } = this.plugin.app;
      const today = fmt(new Date());
      const want = new Map<string, { body: string; rem: string; exam: string }>();
      for (const f of vault.getMarkdownFiles()) {
        if (!f.path.startsWith(SRC_FOLDER + "/")) continue;
        const fm = metadataCache.getFileCache(f)?.frontmatter;
        if (!fm || !fm.date) continue;
        const d = fm.date instanceof Date ? fmt(fm.date) : String(fm.date).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        const rem = fmt(addStep(parse(d), "day", -REM_DAYS));
        const path = normalizePath(`${REM_FOLDER}/${REM_PREFIX}${f.basename}.md`);
        const label = fm.corso && fm.prova ? `${fm.corso} - ${fm.prova}` : f.basename;
        // Spunta «iscritto»: riga Tasks con scadenza = data promemoria. Lo stato (fatto o no) si conserva tra i sync.
        const ex0 = vault.getAbstractFileByPath(path);
        let doneLine = "";
        if (ex0 instanceof TFile) {
          const txt = await vault.read(ex0);
          if (/^- \[[xX]\] /m.test(txt)) {
            const m = txt.match(/^- \[[xX]\] .*?✅ (\d{4}-\d{2}-\d{2})/m);
            doneLine = `✅ ${m ? m[1] : today}`;
          }
        }
        const task = doneLine
          ? `- [x] Iscritto a **${label}** (${d}) 📅 ${rem} ⏳ ${d} ${doneLine}`
          : `- [ ] Iscriviti a **${label}** (${d}) 📅 ${rem} ⏳ ${d}`;
        const body = [
          "---",
          `promemoria-di: "[[${f.path.replace(/\.md$/, "")}]]"`,
          `date: ${rem}`,
          "allDay: true",
          "tags:",
          "  - iscrizione-esame",
          "---",
          task,
          "",
          "Promemoria generato in automatico. Dal 📅 compare nella Dashboard finché non spunti la riga; ⏳ = data prova, dopo la prova sparisce. Per cambiare la data modifica la nota della prova.",
          "",
        ].join("\n");
        want.set(path, { body, rem, exam: d });
      }
      let created = 0,
        updated = 0,
        removed = 0;
      if (!vault.getAbstractFileByPath(REM_FOLDER)) await vault.createFolder(REM_FOLDER).catch(() => {});
      for (const [path, { body, exam }] of want) {
        const ex = vault.getAbstractFileByPath(path);
        if (!(ex instanceof TFile)) {
          if (exam < today && !manual) continue;
          await vault.create(path, body);
          created++;
        } else if ((await vault.read(ex)) !== body) {
          await vault.modify(ex, body);
          updated++;
        }
      }
      const folder = vault.getAbstractFileByPath(REM_FOLDER);
      for (const f of folder instanceof TFolder ? folder.children : []) {
        if (f.path.endsWith(".md") && f.name.startsWith(REM_PREFIX) && !want.has(f.path)) {
          await fileManager.trashFile(f);
          removed++;
        }
      }
      if (manual || created || removed)
        new Notice(`Promemoria iscrizione: ${created} creati, ${updated} aggiornati, ${removed} rimossi`);
    } catch (e) {
      console.error("Calendario Vault: sync promemoria", e);
      new Notice("Errore sync promemoria iscrizione (vedi console)");
    } finally {
      this.syncing = false;
    }
  }
}
