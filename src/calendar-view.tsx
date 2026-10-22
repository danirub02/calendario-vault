import {
  BasesAllOptions,
  BasesEntry,
  BasesPropertyId,
  BasesView,
  DateValue,
  Menu,
  Modal,
  parsePropertyId,
  QueryController,
} from "obsidian";
import React, { StrictMode } from "react";
import { createRoot, Root } from "react-dom/client";
import { CalendarHandle, CalendarReactView } from "./CalendarReactView";
import { AppContext } from "./context";
import { DropPos, dropToFields } from "./date-utils";
import { EditGoogleEventModal } from "./google-modal";
import {
  clearGoogleCache,
  deleteGoogleEvent,
  formFromGoogle,
  GoogleEventRef,
  updateGoogleEvent,
} from "./google";
import type ObsidianCalendarPlugin from "./main";

export const CalendarViewType = "calendar";

interface CalendarEntry {
  entry: BasesEntry;
  startDate: Date;
  endDate?: Date;
}

export class CalendarView extends BasesView {
  type = CalendarViewType;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  root: Root | null = null;
  calendarHandleRef = React.createRef<CalendarHandle | null>();

  // Internal rendering data
  private entries: CalendarEntry[] = [];
  private startDateProp: BasesPropertyId | null = null;
  private endDateProp: BasesPropertyId | null = null;
  private weekStartDay: number = 1;
  private viewType: string = "month";
  private colorProp: BasesPropertyId | null = null;
  private colorMap: string = "";
  private showExternal: boolean = false;
  private externalFilter: string = "";

  constructor(
    controller: QueryController,
    scrollEl: HTMLElement,
    private plugin: ObsidianCalendarPlugin,
  ) {
    super(controller);
    this.scrollEl = scrollEl;
    this.containerEl = scrollEl.createDiv({
      cls: "bases-calendar-container is-loading",
      attr: { tabIndex: 0 },
    });
  }

  onload(): void {
    this.plugin.views.add(this);
  }

  refetchExternal(): void {
    this.calendarHandleRef.current?.refetch();
  }

  onunload() {
    this.plugin.views.delete(this);
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    this.entries = [];
  }

  onResize(): void {
    // Tell FullCalendar to recalculate dimensions (e.g. after tab switch)
    this.calendarHandleRef.current?.updateSize();
  }

  public focus(): void {
    this.containerEl.focus({ preventScroll: true });
  }

  public onDataUpdated(): void {
    this.containerEl.removeClass("is-loading");
    this.loadConfig();
    this.updateCalendar();
  }

  private loadConfig(): void {
    this.startDateProp = this.config.getAsPropertyId("startDate");
    this.endDateProp = this.config.getAsPropertyId("endDate");
    this.colorProp = this.config.getAsPropertyId("colorProperty");
    this.colorMap = (this.config.get("colorMap") as string) || "";
    this.showExternal = this.config.get("showExternal") === true;
    this.externalFilter = ((this.config.get("externalFilter") as string) || "").trim();
    this.viewType = (this.config.get("viewType") as string) || "month";
    const weekStartDayValue = this.config.get("weekStartDay") as string;

    const dayNameToNumber: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };

    this.weekStartDay = weekStartDayValue
      ? (dayNameToNumber[weekStartDayValue] ?? 1)
      : 1; // Default to Monday
  }

  private updateCalendar(): void {
    if (!this.data || !this.startDateProp) {
      this.root?.unmount();
      this.root = null;
      this.containerEl.empty();
      this.containerEl.createDiv("bases-calendar-empty").textContent =
        "Configure a start date property to display entries";
      return;
    }

    this.entries = [];
    for (const entry of this.data.data) {
      const startDate = this.extractDate(entry, this.startDateProp);
      if (startDate) {
        const endDate = this.endDateProp
          ? (this.extractDate(entry, this.endDateProp) ?? undefined)
          : undefined;
        this.entries.push({
          entry,
          startDate,
          endDate,
        });
      }
    }

    this.renderReactCalendar();
  }

  private renderReactCalendar(): void {
    if (!this.root) {
      this.root = createRoot(this.containerEl);
    }

    this.root.render(
      <StrictMode>
        <AppContext.Provider value={this.app}>
          <CalendarReactView
            entries={this.entries}
            weekStartDay={this.weekStartDay}
            viewType={this.viewType}
            colorProperty={this.colorProp}
            colorMap={this.colorMap}
            externalCalendars={this.externalCalendars()}
            googleCtx={{
              google: this.plugin.settings.google,
              save: () => this.plugin.saveSettings(),
            }}
            onExternalClick={(info) => this.showExternalDetails(info)}
            properties={this.config.getOrder() || []}
            onEntryClick={(entry, isModEvent) => {
              void this.app.workspace.openLinkText(
                entry.file.path,
                "",
                isModEvent,
              );
            }}
            onEntryContextMenu={(evt, entry) => {
              evt.preventDefault();
              this.showEntryContextMenu(evt.nativeEvent, entry);
            }}
            onEventDrop={(entry, drop) => this.updateEntryDates(entry, drop)}
            containerEl={this.containerEl}
            lockedFolder={this.plugin.settings.reminders.enabled ? this.plugin.settings.reminders.remFolder : undefined}
            calendarHandleRef={this.calendarHandleRef}
          />
        </AppContext.Provider>
      </StrictMode>,
    );
  }

  private externalCalendars() {
    if (!this.showExternal) return [];
    const names = this.externalFilter
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    return this.plugin.settings.calendars.filter(
      (c) => !names.length || names.includes(c.name.toLowerCase()),
    );
  }

  private showExternalDetails(info: {
    title: string;
    calName: string;
    when: string;
    location: string;
    description: string;
    htmlLink?: string;
    google?: GoogleEventRef;
  }): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText(info.title);
    modal.contentEl.createEl("p", { text: `${info.calName} · ${info.when}` });
    if (info.location) modal.contentEl.createEl("p", { text: `📍 ${info.location}` });
    if (info.description) modal.contentEl.createEl("p", { text: info.description });
    if (info.htmlLink) {
      modal.contentEl.createEl("a", { text: "Apri in Google Calendar", href: info.htmlLink });
    }
    const ref = info.google;
    if (ref) {
      const ctx = { google: this.plugin.settings.google, save: () => this.plugin.saveSettings() };
      const row = modal.contentEl.createDiv({ cls: "modal-button-container" });
      row.createEl("button", { text: "Modifica", cls: "mod-cta" }).onclick = () => {
        modal.close();
        new EditGoogleEventModal(
          this.app,
          formFromGoogle(ref, { location: info.location, description: info.description }),
          ref.recurring,
          async (f) => {
            await updateGoogleEvent(ctx, ref, f);
            this.plugin.refreshViews();
            window.setTimeout(() => { clearGoogleCache(); this.plugin.refreshViews(); }, 2500);
          },
          async () => {
            await deleteGoogleEvent(ctx, ref);
            this.plugin.refreshViews();
            window.setTimeout(() => { clearGoogleCache(); this.plugin.refreshViews(); }, 2500);
          },
        ).open();
      };
    }
    modal.open();
  }

  private extractDate(entry: BasesEntry, propId: BasesPropertyId): Date | null {
    try {
      const value = entry.getValue(propId);
      if (!value) return null;
      if (!(value instanceof DateValue)) return null;
      // Private API
      if ("date" in value && value.date && value.date instanceof Date) {
        return value.date;
      }

      return null;
    } catch (error) {
      console.error(`Error extracting date for ${entry.file.name}:`, error);
      return null;
    }
  }

  private showEntryContextMenu(evt: MouseEvent, entry: BasesEntry): void {
    const file = entry.file;
    const menu = Menu.forEvent(evt);

    this.app.workspace.handleLinkContextMenu(menu, file.path, "");

    menu.addItem((item) =>
      item
        .setSection("danger")
        .setTitle("Delete file")
        .setIcon("lucide-trash-2")
        .setWarning(true)
        .onClick(() => this.app.fileManager.promptForDeletion(file)),
    );
  }

  // Scrive la nuova posizione nel frontmatter. Con le note del vault (`date`, `endDate`, `startTime`,
  // `endTime`) funziona anche se la vista usa formule; altrimenti riscrive le proprietà `note.` configurate.
  private async updateEntryDates(entry: BasesEntry, drop: DropPos): Promise<void> {
    const f = dropToFields(drop);
    const startProp = this.startDateProp?.startsWith("note.") ? this.startDateProp.slice(5) : null;
    const endProp = this.endDateProp?.startsWith("note.") ? this.endDateProp.slice(5) : null;

    await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
      if (fm.date !== undefined) {
        fm.date = f.date;
        if (f.endDate) fm.endDate = f.endDate;
        else delete fm.endDate;
        if (f.allDay) {
          delete fm.startTime;
          delete fm.endTime;
        } else {
          fm.startTime = f.startTime;
          fm.endTime = f.endTime;
        }
        fm.allDay = f.allDay;
        // Proprietà «A to B» importata da Notion
        const key = ["Date", "Data"].find((k) => k in fm);
        if (key)
          fm[key] = f.allDay
            ? f.endDate
              ? `${f.date} to ${f.endDate}`
              : f.date
            : `${f.date}T${f.startTime}:00 to ${f.endDate || f.date}T${f.endTime}:00`;
        return;
      }
      if (!startProp || (this.endDateProp && !endProp)) throw new Error("proprietà data non modificabile");
      fm[startProp] = f.date;
      if (endProp) fm[endProp] = f.endDate || f.date;
    });
  }

  public setEphemeralState(state: unknown): void {
    // State management could be extended for React component
  }

  public getEphemeralState(): unknown {
    return {};
  }

  static getViewOptions(): BasesAllOptions[] {
    return [
      {
        displayName: "Date properties",
        type: "group",
        items: [
          {
            displayName: "Start date",
            type: "property",
            key: "startDate",
            placeholder: "Property",
          },
          {
            displayName: "End date (optional)",
            type: "property",
            key: "endDate",
            placeholder: "Property",
          },
        ],
      },
      {
        displayName: "External calendars",
        type: "group",
        items: [
          {
            displayName: "Show external calendars (Google)",
            type: "toggle",
            key: "showExternal",
            default: false,
          },
          {
            displayName: "Only these (names, comma separated; empty = all)",
            type: "text",
            key: "externalFilter",
            placeholder: "General, Università",
          },
        ],
      },
      {
        displayName: "Colors",
        type: "group",
        items: [
          {
            displayName: "Color by property",
            type: "property",
            key: "colorProperty",
            placeholder: "Property (e.g. tags)",
          },
          {
            displayName: "Colors (value=#hex, comma separated)",
            type: "text",
            key: "colorMap",
            placeholder: "ballo=#7c0909, palestra=#32b620",
          },
        ],
      },
      {
        displayName: "Calendar options",
        type: "group",
        items: [
          {
            displayName: "View",
            type: "dropdown",
            key: "viewType",
            default: "month",
            options: {
              month: "Month",
              week: "Week (hours)",
              weekdays: "Week (days only)",
              day: "Day (hours)",
              threedays: "3 days (hours)",
            },
          },
          {
            displayName: "Week starts on",
            type: "dropdown",
            key: "weekStartDay",
            default: "monday",
            options: {
              sunday: "Sunday",
              monday: "Monday",
              tuesday: "Tuesday",
              wednesday: "Wednesday",
              thursday: "Thursday",
              friday: "Friday",
              saturday: "Saturday",
            },
          },
        ],
      },
    ];
  }
}
