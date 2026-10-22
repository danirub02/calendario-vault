import { Plugin } from "obsidian";
import { CalendarView, CalendarViewType } from "./calendar-view";
import { clearGoogleCache, createGoogleEvent, GoogleEventForm, GoogleCalendarRef } from "./google";
import { EventModal, NoteCalendar } from "./nuovo-evento";
import { DEFAULT_REMINDERS, ReminderSync } from "./promemoria";
import { VaultSync } from "./vault-sync";
import { CalendarioSettings, CalendarioSettingTab, DEFAULT_SETTINGS } from "./settings";

export default class ObsidianCalendarPlugin extends Plugin {
  settings: CalendarioSettings = DEFAULT_SETTINGS;
  // Viste calendario aperte: servono per ricaricare gli eventi Google dopo una scrittura
  views = new Set<CalendarView>();

  refreshViews() {
    this.views.forEach((v) => v.refetchExternal());
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<CalendarioSettings> | null;
    this.settings = {
      calendars: data?.calendars ?? [],
      noteCalendars: data?.noteCalendars ?? [],
      reminders: { ...DEFAULT_REMINDERS, ...(data?.reminders ?? {}) },
      google: { ...DEFAULT_SETTINGS.google, ...(data?.google ?? {}) },
      vaultSync: { ...DEFAULT_SETTINGS.vaultSync, ...(data?.vaultSync ?? {}), map: data?.vaultSync?.map ?? {} },
    };
    this.settings.google.accounts = data?.google?.accounts ?? [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  noteCalendars(): NoteCalendar[] {
    return this.settings.noteCalendars;
  }

  googleCalendars(): GoogleCalendarRef[] {
    // I calendari sincronizzati dalle note sono una copia: mostrarli darebbe doppioni
    const mirrored = Object.values(this.settings.vaultSync.map);
    return this.settings.calendars.filter(
      (c): c is GoogleCalendarRef => c.type === "google" && c.enabled && !mirrored.includes(c.calendarId),
    );
  }

  async createGoogleEvent(cal: GoogleCalendarRef, form: GoogleEventForm) {
    await createGoogleEvent({ google: this.settings.google, save: () => this.saveSettings() }, cal, form);
    this.refreshViews();
    // Google a volte restituisce la lista con qualche secondo di ritardo
    window.setTimeout(() => {
      clearGoogleCache();
      this.refreshViews();
    }, 2500);
  }

  // Chiamato dalle impostazioni dopo aver attivato il sync o collegato i calendari
  runVaultSync() {
    void this.vaultSync.sync(true);
  }

  private reminders = new ReminderSync(this);
  private vaultSync = new VaultSync(this);

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CalendarioSettingTab(this.app, this));
    // Register "bases" as a hover source that doesn't require CMD/CTRL
    // so Page Preview shows on regular hover over calendar events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.app.workspace as any).hoverLinkSources["bases"] = {
      display: "Calendar Bases",
      defaultMod: false,
    };

    const openForm = () => new EventModal(this.app, this).open();
    this.addCommand({ id: "nuovo-evento", name: "Crea nuovo evento", callback: openForm });
    this.addRibbonIcon("calendar-plus", "Nuovo evento", openForm);
    this.reminders.register();
    this.vaultSync.register();

    this.registerBasesView(CalendarViewType, {
      name: "Calendar",
      icon: "lucide-calendar",
      factory: (controller, containerEl) =>
        new CalendarView(controller, containerEl, this),
      options: () => CalendarView.getViewOptions(),
    });
  }

  onunload() {
    this.reminders.unload();
    this.vaultSync.unload();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (this.app.workspace as any).hoverLinkSources["bases"];
  }
}
