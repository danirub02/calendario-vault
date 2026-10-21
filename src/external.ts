import ICAL from "ical.js";
import { Notice, requestUrl } from "obsidian";
import type { EventInput } from "@fullcalendar/core";
import { fetchGoogleEvents, GoogleCalendarRef, GoogleCtx } from "./google";

export interface IcsCalendar {
  type?: "ics";
  name: string;
  url: string;
  color: string;
  enabled: boolean;
}

export type ExternalCalendar = IcsCalendar | GoogleCalendarRef;

interface Parsed {
  fetchedAt: number;
  masters: ICAL.Event[];
}

const TTL_MS = 5 * 60 * 1000;
const MAX_OCCURRENCES = 1500;
const cache = new Map<string, Parsed>();

export function clearExternalCache(): void {
  cache.clear();
}

async function load(url: string): Promise<Parsed> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit;

  const res = await requestUrl({ url: url.replace(/^webcal:/i, "https:") });
  const root = new ICAL.Component(ICAL.parse(res.text));
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(vtz);
  }

  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  const singles: ICAL.Event[] = [];
  for (const vevent of root.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(vevent);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else if (ev.isRecurring()) masters.set(ev.uid, ev);
    else singles.push(ev);
  }
  for (const ex of exceptions) {
    const master = masters.get(ex.uid);
    if (master) master.relateException(ex);
    else singles.push(ex);
  }

  const parsed = { fetchedAt: Date.now(), masters: [...masters.values(), ...singles] };
  cache.set(url, parsed);
  return parsed;
}

function toInput(
  cal: IcsCalendar,
  ev: ICAL.Event,
  start: ICAL.Time,
  end: ICAL.Time,
  idx: number,
): EventInput {
  const allDay = start.isDate;
  return {
    id: `ext:${cal.name}:${ev.uid}:${idx}`,
    title: ev.summary || "(senza titolo)",
    start: start.toJSDate(),
    end: end.toJSDate(),
    allDay,
    backgroundColor: cal.color,
    borderColor: cal.color,
    textColor: contrast(cal.color),
    editable: false,
    extendedProps: {
      external: true,
      evColor: cal.color,
      evText: contrast(cal.color),
      calName: cal.name,
      location: ev.location || "",
      description: ev.description || "",
    },
  };
}

export function contrast(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum =
    (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#ffffff";
}

export async function loadExternalEvents(
  cals: ExternalCalendar[],
  rangeStart: Date,
  rangeEnd: Date,
  ctx: GoogleCtx,
): Promise<EventInput[]> {
  const out: EventInput[] = [];
  const rs = ICAL.Time.fromJSDate(rangeStart, true);
  const re = ICAL.Time.fromJSDate(rangeEnd, true);

  for (const cal of cals) {
    if (!cal.enabled) continue;
    if (cal.type === "google") {
      try {
        out.push(...(await fetchGoogleEvents(ctx, cal, rangeStart, rangeEnd, contrast)));
      } catch (e) {
        console.error(`Calendario Vault: errore Google "${cal.name}"`, e);
        new Notice(`Calendario Vault · ${cal.name}: ${(e as Error).message}`, 10000);
      }
      continue;
    }
    if (!cal.url) continue;
    let parsed: Parsed;
    try {
      parsed = await load(cal.url);
    } catch (e) {
      console.error(`Calendario Vault: errore caricando "${cal.name}"`, e);
      continue;
    }
    for (const ev of parsed.masters) {
      try {
        if (ev.component.getFirstPropertyValue("status") === "CANCELLED") continue;
        if (!ev.isRecurring()) {
          if (ev.endDate.compare(rs) < 0 || ev.startDate.compare(re) > 0) continue;
          out.push(toInput(cal, ev, ev.startDate, ev.endDate, 0));
          continue;
        }
        const it = ev.iterator();
        let next: ICAL.Time | null;
        let n = 0;
        while ((next = it.next()) && n < MAX_OCCURRENCES) {
          n++;
          if (next.compare(re) > 0) break;
          const d = ev.getOccurrenceDetails(next);
          if (d.endDate.compare(rs) < 0) continue;
          out.push(toInput(cal, ev, d.startDate, d.endDate, n));
        }
      } catch (e) {
        console.error(`Calendario Vault: evento non leggibile in "${cal.name}"`, e);
      }
    }
  }
  return out;
}
