import { App, Modal, normalizePath, Notice, Setting } from "obsidian";
import { addStep, fmt, parse, RepeatUnit } from "./date-utils";
import { GoogleCalendarRef, GoogleEventForm } from "./google";

interface NoteCalendar {
  folder: string;
  base: string;
  tag: string;
  dateKey: string;
  extra?: "palestra";
}

const CALENDARS: Record<string, NoteCalendar> = {
  Ballo: { folder: "Ballo", base: "Ballo.base", tag: "ballo", dateKey: "Date" },
  Palestra: { folder: "Palestra", base: "Palestra.base", tag: "palestra", dateKey: "Date", extra: "palestra" },
  Dentista: { folder: "Dentista", base: "Dentista.base", tag: "dentista", dateKey: "Date" },
  "Proloco Eventi": { folder: "Proloco/Eventi", base: "Proloco Eventi.base", tag: "proloco", dateKey: "Date" },
  "Studio Università": {
    folder: "Studio Università",
    base: "Studio Università.base",
    tag: "studio-universita",
    dateKey: "Data",
  },
  "Esami Università": {
    folder: "Università/Esami Università",
    base: "Esami Università.base",
    tag: "esame-universita",
    dateKey: "Data",
  },
};

interface EventDraft {
  calendar: string;
  title: string;
  date: string;
  endDate: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  repeat: "none" | RepeatUnit;
  interval: number;
  endMode: "count" | "until";
  count: number;
  until: string;
  location: string;
  description: string;
  priority: string;
  completed: boolean;
}

export interface NuovoEventoHost {
  app: App;
  googleCalendars(): GoogleCalendarRef[];
  createGoogleEvent(cal: GoogleCalendarRef, form: GoogleEventForm): Promise<void>;
}

function buildNote(cal: NoteCalendar, ev: EventDraft, start: Date, end: Date): string {
  const lines = ["---", `base: "[[${cal.base}]]"`];
  const startD = fmt(start),
    endD = fmt(end);
  const multi = startD !== endD;
  if (ev.allDay) lines.push(`${cal.dateKey}: ${multi ? `${startD} to ${endD}` : startD}`);
  else lines.push(`${cal.dateKey}: ${startD}T${ev.startTime}:00 to ${endD}T${ev.endTime}:00`);
  lines.push(`date: ${startD}`);
  if (multi) lines.push(`endDate: ${endD}`);
  if (!ev.allDay) lines.push(`startTime: ${ev.startTime}`, `endTime: ${ev.endTime}`);
  // Proprietà extra di Palestra
  if (cal.extra === "palestra") {
    if (ev.priority) lines.push(`Priorità: ${ev.priority}`);
    lines.push(`Completato: ${ev.completed}`);
  }
  lines.push(`allDay: ${ev.allDay}`, "tags:", `  - ${cal.tag}`, "---", "");
  return lines.join("\n");
}

// Stessa convenzione dell'importer Notion: "Titolo", "Titolo 1", "Titolo 2"...
function freePath(app: App, folder: string, title: string): string {
  let p = normalizePath(`${folder}/${title}.md`);
  for (let i = 1; app.vault.getAbstractFileByPath(p); i++) p = normalizePath(`${folder}/${title} ${i}.md`);
  return p;
}

export class EventModal extends Modal {
  private ev: EventDraft;

  constructor(
    app: App,
    private host: NuovoEventoHost,
  ) {
    super(app);
    this.ev = {
      calendar: "Ballo",
      title: "",
      date: fmt(new Date()),
      endDate: "",
      allDay: false,
      startTime: "09:00",
      endTime: "10:00",
      repeat: "none",
      interval: 1,
      endMode: "count",
      count: 10,
      until: "",
      location: "",
      description: "",
      priority: "",
      completed: false,
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("Nuovo evento");
    const ev = this.ev;

    // Calendari Google collegati nelle impostazioni del plugin
    const gcals = this.host.googleCalendars();
    new Setting(contentEl).setName("Calendario").addDropdown((d) => {
      Object.keys(CALENDARS).forEach((k) => d.addOption(k, k));
      gcals.forEach((c, i) => d.addOption(`g:${i}`, `Google · ${c.name} (${c.account})`));
      d.setValue(ev.calendar).onChange((v) => {
        ev.calendar = v;
        extraBox.style.display = v.startsWith("g:") ? "" : "none";
        palBox.style.display = CALENDARS[v]?.extra === "palestra" ? "" : "none";
      });
    });
    new Setting(contentEl).setName("Titolo").addText((t) => {
      t.setPlaceholder("es. Cena").onChange((v) => (ev.title = v));
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    const palBox = contentEl.createDiv();
    palBox.style.display = CALENDARS[ev.calendar].extra === "palestra" ? "" : "none";
    new Setting(palBox).setName("Priorità").addDropdown((d) => {
      d.addOption("", "—").addOption("Alta", "Alta").addOption("Media", "Media").addOption("Bassa", "Bassa");
      d.setValue(ev.priority).onChange((v) => (ev.priority = v));
    });
    new Setting(palBox)
      .setName("Completato")
      .addToggle((t) => t.setValue(ev.completed).onChange((v) => (ev.completed = v)));
    const extraBox = contentEl.createDiv();
    extraBox.style.display = "none";
    new Setting(extraBox).setName("Luogo (Google)").addText((t) => t.onChange((v) => (ev.location = v)));
    new Setting(extraBox).setName("Descrizione (Google)").addTextArea((t) => t.onChange((v) => (ev.description = v)));
    new Setting(contentEl).setName("Data").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(ev.date).onChange((v) => (ev.date = v));
    });
    new Setting(contentEl).setName("Data fine (opzionale, più giorni)").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(ev.endDate).onChange((v) => (ev.endDate = v));
    });
    new Setting(contentEl).setName("Tutto il giorno").addToggle((t) =>
      t.setValue(ev.allDay).onChange((v) => {
        ev.allDay = v;
        timeBox.style.display = v ? "none" : "";
      }),
    );

    const timeBox = contentEl.createDiv();
    new Setting(timeBox).setName("Ora inizio").addText((t) => {
      t.inputEl.type = "time";
      t.setValue(ev.startTime).onChange((v) => (ev.startTime = v));
    });
    new Setting(timeBox).setName("Ora fine").addText((t) => {
      t.inputEl.type = "time";
      t.setValue(ev.endTime).onChange((v) => (ev.endTime = v));
    });

    new Setting(contentEl).setName("Ripeti").addDropdown((d) => {
      d.addOption("none", "Mai")
        .addOption("day", "Ogni N giorni")
        .addOption("week", "Ogni N settimane")
        .addOption("month", "Ogni N mesi");
      d.setValue(ev.repeat).onChange((v) => {
        ev.repeat = v as EventDraft["repeat"];
        repBox.style.display = v === "none" ? "none" : "";
      });
    });
    const repBox = contentEl.createDiv();
    repBox.style.display = "none";
    new Setting(repBox).setName("Ogni N").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.min = "1";
      t.setValue(String(ev.interval)).onChange((v) => (ev.interval = Math.max(1, parseInt(v) || 1)));
    });
    new Setting(repBox).setName("Fine ricorrenza").addDropdown((d) => {
      d.addOption("count", "Dopo N occorrenze").addOption("until", "Fino a data");
      d.setValue(ev.endMode).onChange((v) => {
        ev.endMode = v as EventDraft["endMode"];
        cntSet.settingEl.style.display = v === "count" ? "" : "none";
        untSet.settingEl.style.display = v === "until" ? "" : "none";
      });
    });
    const cntSet = new Setting(repBox).setName("Occorrenze").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.min = "1";
      t.setValue(String(ev.count)).onChange((v) => (ev.count = Math.max(1, parseInt(v) || 1)));
    });
    const untSet = new Setting(repBox).setName("Fino al").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(ev.until).onChange((v) => (ev.until = v));
    });
    untSet.settingEl.style.display = "none";

    new Setting(contentEl).addButton((b) => b.setButtonText("Crea").setCta().onClick(() => void this.submit()));
  }

  private async submit() {
    const ev = this.ev;
    const title = ev.title.trim().replace(/[\\/:*?"<>|#^[\]]/g, "");
    if (!title) return new Notice("Titolo mancante");
    if (!ev.date) return new Notice("Data mancante");
    if (ev.endDate && ev.endDate < ev.date) return new Notice("Data fine prima di data inizio");
    if (ev.repeat !== "none" && ev.endMode === "until" && !ev.until) return new Notice("Data fine ricorrenza mancante");

    if (ev.calendar.startsWith("g:")) return this.submitGoogle();

    const start0 = parse(ev.date);
    let span = ev.endDate ? Math.round((parse(ev.endDate).getTime() - start0.getTime()) / 86400000) : 0;
    // fine <= inizio senza data fine: l'evento attraversa la mezzanotte
    if (!ev.allDay && span === 0 && ev.endTime <= ev.startTime) span = 1;
    const starts: Date[] = [];
    if (ev.repeat === "none") starts.push(start0);
    else {
      const limit = ev.endMode === "until" ? parse(ev.until) : null;
      for (let i = 0; i < 500; i++) {
        const d = addStep(start0, ev.repeat, i * ev.interval);
        if (limit ? d > limit : i >= ev.count) break;
        starts.push(d);
      }
    }
    if (!starts.length) return new Notice("Nessuna occorrenza");

    const cal = CALENDARS[ev.calendar];
    let created = 0;
    for (const s of starts) {
      const e = new Date(s);
      e.setDate(e.getDate() + span);
      await this.app.vault.create(freePath(this.app, cal.folder, title), buildNote(cal, ev, s, e));
      created++;
    }
    new Notice(`Creati ${created} eventi in ${ev.calendar}`);
    this.close();
  }

  // Evento su Google Calendar: la ricorrenza va a Google come RRULE (una sola voce, non una nota per occorrenza)
  private async submitGoogle() {
    const ev = this.ev;
    const cal = this.host.googleCalendars()[parseInt(ev.calendar.slice(2))];
    if (!cal) return new Notice("Calendario Google non trovato");
    const form: GoogleEventForm = {
      title: ev.title.trim(),
      date: ev.date,
      endDate: ev.endDate,
      allDay: ev.allDay,
      startTime: ev.startTime,
      endTime: ev.endTime,
      location: ev.location,
      description: ev.description,
    };
    if (ev.repeat !== "none") {
      form.recurrence = { unit: ev.repeat, interval: ev.interval };
      if (ev.endMode === "until") form.recurrence.until = ev.until;
      else form.recurrence.count = ev.count;
    }
    try {
      await this.host.createGoogleEvent(cal, form);
      new Notice(`Evento creato su Google · ${cal.name}`);
      this.close();
    } catch (e) {
      new Notice(`Creazione su Google fallita: ${(e as Error).message}`, 8000);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
