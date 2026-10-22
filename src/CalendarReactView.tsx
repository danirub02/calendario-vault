import type {
  EventApi,
  EventInput,
  EventClickArg,
  EventContentArg,
  EventDropArg,
} from "@fullcalendar/core";
import itLocale from "@fullcalendar/core/locales/it";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import FullCalendar from "@fullcalendar/react";
import { BasesEntry, BasesPropertyId, DateValue, Notice, Value } from "obsidian";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { useApp } from "./hooks";
import { ExternalCalendar, loadExternalEvents } from "./external";
import { DropPos, dropToFields } from "./date-utils";
import { formFromGoogle, GoogleCtx, GoogleEventRef, updateGoogleEvent } from "./google";

const NARROW_PX = 600;

export interface CalendarHandle {
  updateSize(): void;
  refetch(): void;
}

interface CalendarReactViewProps {
  entries: CalendarEntry[];
  weekStartDay: number;
  viewType: string;
  colorProperty: BasesPropertyId | null;
  colorMap: string;
  externalCalendars: ExternalCalendar[];
  googleCtx: GoogleCtx;
  onExternalClick: (info: {
    htmlLink?: string;
    google?: GoogleEventRef;
    title: string;
    calName: string;
    when: string;
    location: string;
    description: string;
  }) => void;
  properties: BasesPropertyId[];
  onEntryClick: (entry: BasesEntry, isModEvent: boolean) => void;
  onEntryContextMenu: (evt: React.MouseEvent, entry: BasesEntry) => void;
  onEventDrop?: (entry: BasesEntry, drop: DropPos) => Promise<void>;
  // Note in questa cartella non si trascinano (es. promemoria generati)
  lockedFolder?: string;
  containerEl: HTMLElement;
  calendarHandleRef?: React.RefObject<CalendarHandle | null>;
}

export const CalendarReactView: React.FC<CalendarReactViewProps> = ({
  entries,
  weekStartDay,
  viewType,
  colorProperty,
  colorMap,
  externalCalendars,
  googleCtx,
  onExternalClick,
  properties,
  onEntryClick,
  onEntryContextMenu,
  onEventDrop,
  lockedFolder,
  containerEl,
  calendarHandleRef,
}) => {
  const app = useApp();
  const calendarRef = useRef<FullCalendar>(null);
  // Shared hover parent so Page Preview can manage popover lifecycle —
  // when a new popover opens, the old one on the same parent is dismissed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hoverParentRef = useRef<{ hoverPopover: any }>({ hoverPopover: null });

  // Pannello stretto (iPhone, split piccolo): layout compatto, navigazione a tocco e swipe
  const [narrow, setNarrow] = useState(containerEl.clientWidth > 0 && containerEl.clientWidth < NARROW_PX);
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const w = containerEl.clientWidth;
      if (w > 0) setNarrow(w < NARROW_PX);
    });
    ro.observe(containerEl);
    return () => ro.disconnect();
  }, [containerEl]);
  useEffect(() => {
    containerEl.toggleClass("is-narrow", narrow);
    return () => containerEl.removeClass("is-narrow");
  }, [containerEl, narrow]);
  // Swipe orizzontale = periodo precedente/successivo (non se parte da un evento: lì c'è il trascinamento)
  useEffect(() => {
    if (!narrow) return;
    let x0 = 0,
      y0 = 0,
      t0 = 0,
      active = false;
    const down = (e: TouchEvent) => {
      active = e.touches.length === 1 && !(e.target as HTMLElement).closest(".fc-event, .fc-popover");
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      t0 = Date.now();
    };
    const up = (e: TouchEvent) => {
      if (!active) return;
      active = false;
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) / 2 || Date.now() - t0 > 600) return;
      const api = calendarRef.current?.getApi();
      if (dx < 0) api?.next();
      else api?.prev();
    };
    containerEl.addEventListener("touchstart", down, { passive: true });
    containerEl.addEventListener("touchend", up, { passive: true });
    return () => {
      containerEl.removeEventListener("touchstart", down);
      containerEl.removeEventListener("touchend", up);
    };
  }, [containerEl, narrow]);

  // Expose updateSize to the parent view for resize/tab-switch handling
  useEffect(() => {
    if (calendarHandleRef) {
      (calendarHandleRef as React.RefObject<CalendarHandle | null>).current = {
        updateSize: () => calendarRef.current?.getApi().updateSize(),
        refetch: () => calendarRef.current?.getApi().refetchEvents(),
      };
    }
    return () => {
      if (calendarHandleRef) {
        (calendarHandleRef as React.RefObject<CalendarHandle | null>).current = null;
      }
    };
  }, [calendarHandleRef]);

  const hasTime = (d?: Date) =>
    !!d && (d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0);

  const colors = parseColorMap(colorMap);
  const colorFor = (entry: BasesEntry): Record<string, string> => {
    if (!colorProperty) return {};
    const v = tryGetValue(entry, colorProperty);
    if (!v || !v.isTruthy()) return {};
    const keys = v
      .toString()
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (!keys.length) return {};
    const mapped = keys.map((k) => colors[k]).find(Boolean);
    const bg = mapped ?? hashColor(keys[0]);
    return { backgroundColor: bg, borderColor: bg, textColor: contrastText(bg) };
  };

  const events = entries.map((calEntry) => {
    const color = colorFor(calEntry.entry);
    const locked = !!lockedFolder && calEntry.entry.file.path.startsWith(lockedFolder + "/");
    const timed = hasTime(calEntry.startDate) || hasTime(calEntry.endDate);
    if (timed) {
      // Evento che attraversa la mezzanotte (es. 23:00 → 06:00 senza endDate):
      // la fine risulta prima dell'inizio, quindi la spostiamo al giorno dopo.
      let end = calEntry.endDate;
      if (end && end <= calEntry.startDate) {
        end = new Date(end);
        while (end <= calEntry.startDate) end.setDate(end.getDate() + 1);
      }
      return {
        id: calEntry.entry.file.path,
        title: calEntry.entry.file.basename,
        start: calEntry.startDate,
        end,
        allDay: false,
        editable: !locked,
        extendedProps: {
          entry: calEntry.entry,
          originalEndDate: calEntry.endDate,
          evColor: color.backgroundColor,
          evText: color.textColor,
        },
      };
    }
    // FullCalendar treats end dates as exclusive when allDay is true
    // We need to add one day to the end date to make it inclusive
    // But if start and end are the same day, we don't set an end date (single day event)
    let adjustedEndDate = calEntry.endDate;
    if (calEntry.endDate) {
      const startDateOnly = new Date(
        calEntry.startDate.getFullYear(),
        calEntry.startDate.getMonth(),
        calEntry.startDate.getDate(),
      );
      const endDateOnly = new Date(
        calEntry.endDate.getFullYear(),
        calEntry.endDate.getMonth(),
        calEntry.endDate.getDate(),
      );

      if (startDateOnly.getTime() === endDateOnly.getTime()) {
        // Same day event - don't set end date to avoid showing as multi-day
        adjustedEndDate = undefined;
      } else {
        // Multi-day event - add one day to make end date inclusive
        adjustedEndDate = new Date(calEntry.endDate);
        adjustedEndDate.setDate(adjustedEndDate.getDate() + 1);
      }
    }

    return {
      id: calEntry.entry.file.path,
      title: calEntry.entry.file.basename,
      start: calEntry.startDate,
      end: adjustedEndDate,
      allDay: true,
      editable: !locked,
      extendedProps: {
        evColor: color.backgroundColor,
        evText: color.textColor,
        entry: calEntry.entry,
        originalEndDate: calEntry.endDate, // Keep track of original end date for drag operations
      },
    };
  });

  const viewTypeRef = useRef(viewType);
  viewTypeRef.current = viewType;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const extRef = useRef(externalCalendars);
  extRef.current = externalCalendars;
  const ctxRef = useRef(googleCtx);
  ctxRef.current = googleCtx;
  const extKey = JSON.stringify(externalCalendars);

  const fetchEvents = useCallback(
    async (info: { start: Date; end: Date }) => {
      const ext = extRef.current.length
        ? await loadExternalEvents(extRef.current, info.start, info.end, ctxRef.current)
        : [];
      console.debug(`Calendario Vault: ${ext.length} eventi esterni da ${extRef.current.length} calendari`);
      // Orario originale (prima dell'eventuale divisione a mezzanotte) per l'etichetta
      const extWithTime = ext.map((e) => ({
        ...e,
        editable: !!e.extendedProps?.google,
        extendedProps: { ...e.extendedProps, origStart: e.start, origEnd: e.end },
      }));
      const all = [...eventsRef.current, ...extWithTime];
      // Nelle viste a giorni (mese / settimana a giorni) un evento con ora che
      // attraversa la mezzanotte viene diviso in un pezzo per giorno, così ogni
      // pezzo si ordina per la sua ora e non finisce in cima come un blocco.
      return viewTypeRef.current === "month" || viewTypeRef.current === "weekdays"
        ? all.flatMap(splitAtMidnight)
        : all;
    },
    [],
  );

  useEffect(() => {
    calendarRef.current?.getApi().refetchEvents();
  }, [events, extKey]);

  const handleEventClick = useCallback(
    (clickInfo: EventClickArg) => {
      if (clickInfo.event.extendedProps.external) {
        clickInfo.jsEvent.preventDefault();
        const ev = clickInfo.event;
        onExternalClick({
          title: ev.title,
          calName: ev.extendedProps.calName as string,
          when: ev.allDay
            ? ev.start?.toLocaleDateString() ?? ""
            : `${ev.start?.toLocaleString() ?? ""}${ev.end ? " – " + ev.end.toLocaleTimeString() : ""}`,
          location: ev.extendedProps.location as string,
          description: ev.extendedProps.description as string,
          htmlLink: ev.extendedProps.htmlLink as string | undefined,
          google: ev.extendedProps.google as GoogleEventRef | undefined,
        });
        return;
      }
      const target = clickInfo.jsEvent.target as HTMLElement;
      const entry = clickInfo.event.extendedProps.entry as BasesEntry;
      const isModEvent = clickInfo.jsEvent.ctrlKey || clickInfo.jsEvent.metaKey;

      // Let interactive elements inside the event handle the click instead of opening the note
      const clickedTag = target.closest("a.tag");
      if (clickedTag) {
        return;
      }

      const clickedLink = target.closest(".internal-link") as HTMLElement | null;
      if (clickedLink) {
        return;
      }

      const clickedExternal = target.closest("a.external-link") as
        | HTMLAnchorElement
        | undefined;
      if (clickedExternal?.href) {
        return;
      }

      // Default: open the event's note
      clickInfo.jsEvent.preventDefault();
      onEntryClick(entry, isModEvent);
    },
    [app, onEntryClick, onExternalClick],
  );

  // Track contextmenu listeners per element to prevent duplicates across hover cycles
  const contextMenuListenersRef = useRef(new WeakMap<HTMLElement, (evt: Event) => void>());

  const handleEventMouseEnter = useCallback(
    (mouseEnterInfo: { event: EventApi; el: HTMLElement; jsEvent: MouseEvent }) => {
      if (mouseEnterInfo.event.extendedProps.external) return;
      const entry = mouseEnterInfo.event.extendedProps.entry as BasesEntry;
      const el = mouseEnterInfo.el;

      if (app) {
        app.workspace.trigger("hover-link", {
          event: mouseEnterInfo.jsEvent,
          source: "bases",
          hoverParent: hoverParentRef.current,
          targetEl: el,
          linktext: entry.file.path,
        });
      }

      // Remove previous contextmenu listener if one exists (prevents duplicates)
      const prevHandler = contextMenuListenersRef.current.get(el);
      if (prevHandler) {
        el.removeEventListener("contextmenu", prevHandler);
      }

      const contextMenuHandler = (evt: Event) => {
        evt.preventDefault();
        const syntheticEvent = {
          nativeEvent: evt as MouseEvent,
          currentTarget: el,
          target: evt.target as HTMLElement,
          preventDefault: () => evt.preventDefault(),
          stopPropagation: () => evt.stopPropagation(),
        } as unknown as React.MouseEvent;
        onEntryContextMenu(syntheticEvent, entry);
      };
      contextMenuListenersRef.current.set(el, contextMenuHandler);
      el.addEventListener("contextmenu", contextMenuHandler);
    },
    [app, onEntryContextMenu],
  );

  const handleEventDrop = useCallback(
    async (dropInfo: EventDropArg) => {
      const ev = dropInfo.event;
      if (!ev.start) {
        dropInfo.revert();
        return;
      }
      const drop: DropPos = { start: ev.start, end: ev.end, allDay: ev.allDay };
      try {
        if (ev.extendedProps.external) {
          const ref = ev.extendedProps.google as GoogleEventRef | undefined;
          if (!ref) throw new Error("evento non modificabile");
          const form = {
            ...formFromGoogle(ref, {
              location: ev.extendedProps.location as string,
              description: ev.extendedProps.description as string,
            }),
            ...dropToFields(drop),
          };
          await updateGoogleEvent(ctxRef.current, ref, form);
          calendarRef.current?.getApi().refetchEvents();
        } else {
          if (!onEventDrop) throw new Error("trascinamento non disponibile");
          await onEventDrop(ev.extendedProps.entry as BasesEntry, drop);
        }
      } catch (e) {
        dropInfo.revert();
        new Notice(`Spostamento fallito: ${(e as Error).message}`, 6000);
      }
    },
    [onEventDrop],
  );

  const hasNonEmptyValue = useCallback((value: Value): boolean => {
    if (!value || !value.isTruthy()) return false;
    const str = value.toString();
    return Boolean(str && str.trim().length > 0);
  }, []);

  const PropertyValue: React.FC<{ value: Value }> = ({ value }) => {
    const elementRef = useCallback(
      (node: HTMLElement | null) => {
        if (node && app) {
          // Remove previous content (due to React strict mode causing double calls)
          while (node.firstChild) {
            node.removeChild(node.firstChild);
          }

          if (!(value instanceof DateValue)) {
            value.renderTo(node, app.renderContext);
            return;
          }

          // Special handling for DateValue to show in a more compact format
          if ("date" in value && value.date && value.date instanceof Date) {
            if ("time" in value && value.time) {
              node.appendChild(
                document.createTextNode(
                  value.date.toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                ),
              );
            } else {
              node.appendChild(
                document.createTextNode(
                  value.date.toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  }),
                ),
              );
            }

            return;
          }
        }
      },
      [value],
    );

    return <span ref={elementRef} />;
  };

  const renderEventContent = useCallback(
    (eventInfo: EventContentArg) => {
      if (!app) return null;

      if (eventInfo.event.extendedProps.external) {
        const p = eventInfo.event.extendedProps;
        const hm = (v: unknown) =>
          v
            ? new Date(v as string | Date).toLocaleTimeString("it-IT", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })
            : "";
        const time = eventInfo.event.allDay
          ? ""
          : [hm(p.origStart), hm(p.origEnd)].filter(Boolean).join(" – ");
        return (
          <div className="bases-calendar-event-content">
            <div className="bases-calendar-event-title">{eventInfo.event.title}</div>
            {time && <div className="bases-calendar-event-properties">{time}</div>}
          </div>
        );
      }

      const entry = eventInfo.event.extendedProps.entry as BasesEntry;
      const validProperties: { propertyId: BasesPropertyId; value: Value }[] =
        [];
      for (const prop of properties) {
        const value = tryGetValue(entry, prop);
        if (value && hasNonEmptyValue(value)) {
          validProperties.push({ propertyId: prop, value });
        }
      }

      if (validProperties.length > 0) {
        const firstProperty = validProperties[0];
        // Stretto: solo il titolo, le altre proprietà non entrano nello schermo
        const remainingProperties = narrow ? [] : validProperties.slice(1);

        return (
          <div className="bases-calendar-event-content">
            <div className="bases-calendar-event-title">
              <PropertyValue value={firstProperty.value} />
            </div>
            {remainingProperties.length > 0 && (
              <div className="bases-calendar-event-properties">
                {remainingProperties.map(({ propertyId: prop, value }) => (
                  <div key={prop} className="bases-calendar-event-property">
                    <span className="bases-calendar-event-property-value">
                      <PropertyValue value={value} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      } else {
        // Fallback to file basename if no properties
        return (
          <div className="bases-calendar-event-content">
            <div className="bases-calendar-event-title">
              {entry.file.basename}
            </div>
          </div>
        );
      }
    },
    [properties, app, hasNonEmptyValue, narrow],
  );

  // Viste a ore: altezza fissa, così scorrono solo le fasce orarie e la riga
  // «Tutto il giorno» resta bloccata in cima.
  const isTimeView = viewType === "week" || viewType === "day" || viewType === "threedays";

  return (
    <FullCalendar
      ref={calendarRef}
      key={viewType}
      plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
      initialView={
        viewType === "week"
          ? "timeGridWeek"
          : viewType === "weekdays"
            ? "dayGridWeek"
            : viewType === "day"
              ? "timeGridDay"
              : viewType === "threedays"
                ? "timeGridThreeDay"
                : "dayGridMonth"
      }
      views={{ timeGridThreeDay: { type: "timeGrid", duration: { days: 3 }, buttonText: "3 giorni" } }}
      scrollTime="07:00:00"
      eventOrder="-allDay,start,-duration,title"
      nowIndicator={true}
      allDaySlot={true}
      slotEventOverlap={false}
      slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
      eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
      firstDay={weekStartDay}
      locale={itLocale}
      headerToolbar={
        narrow
          ? { left: "prev,next", center: "title", right: "today" }
          : { left: "", center: "title", right: "prev,today,next" }
      }
      footerToolbar={narrow ? { center: "dayGridMonth,timeGridWeek,timeGridThreeDay,timeGridDay" } : false}
      buttonText={{
        today: "Oggi",
        dayGridMonth: "Mese",
        timeGridWeek: "Settimana",
        timeGridDay: "Giorno",
      }}
      dayHeaderFormat={narrow ? { weekday: "narrow" } : undefined}
      navLinks={narrow}
      navLinkDayClick="timeGridDay"
      longPressDelay={400}
      eventLongPressDelay={400}
      allDayText="Tutto il giorno"
      events={fetchEvents}
      eventDidMount={(info) => {
        const bg = info.event.extendedProps.evColor as string | undefined;
        const fg = info.event.extendedProps.evText as string | undefined;
        if (bg) info.el.style.setProperty("--ev-bg", bg);
        if (fg) info.el.style.setProperty("--ev-fg", fg);
      }}
      eventContent={renderEventContent}
      eventClick={handleEventClick}
      eventMouseEnter={handleEventMouseEnter}
      eventDrop={(info) => void handleEventDrop(info)}
      height={isTimeView ? "calc(100vh - 220px)" : "auto"}
      fixedWeekCount={viewType === "month"}
      fixedMirrorParent={document.body ?? undefined}
      eventDurationEditable={false}
      editable={true}
    />
  );
};

interface CalendarEntry {
  entry: BasesEntry;
  startDate: Date;
  endDate?: Date;
}

function tryGetValue(entry: BasesEntry, propId: BasesPropertyId): Value | null {
  try {
    return entry.getValue(propId);
  } catch {
    return null;
  }
}

function parseColorMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text || "").split(/[,;\n]/)) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const c = part.slice(i + 1).trim();
    if (k && c) out[k] = c;
  }
  return out;
}

function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 55%, 45%)`;
}

function contrastText(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#ffffff";
}

function splitAtMidnight(ev: EventInput): EventInput[] {
  if (ev.allDay || !ev.start || !ev.end) return [ev];
  const start = new Date(ev.start as string | Date);
  const end = new Date(ev.end as string | Date);
  const nextMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  if (!(end > start) || end <= nextMidnight(start)) return [ev];

  const out: EventInput[] = [];
  let from = start;
  let i = 0;
  while (from < end) {
    const mid = nextMidnight(from);
    const to = mid < end ? mid : end;
    out.push({ ...ev, id: `${ev.id}#${i++}`, start: from, end: to, editable: false });
    from = mid;
  }
  return out;
}
