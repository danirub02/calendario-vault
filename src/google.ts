import { requestUrl } from "obsidian";
import type { EventInput } from "@fullcalendar/core";

export const REDIRECT_URI = "http://127.0.0.1:8765";
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export interface GoogleAccount {
  email: string;
  refreshToken: string;
  accessToken: string;
  expiry: number; // ms epoch
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  accounts: GoogleAccount[];
}

export interface GoogleCalendarRef {
  type: "google";
  name: string;
  color: string;
  enabled: boolean;
  account: string;
  calendarId: string;
}

export interface GoogleCtx {
  google: GoogleConfig;
  save(): Promise<void>;
}

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const randomString = (n = 32): string => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
};

export interface PendingAuth {
  verifier: string;
  state: string;
}

export async function buildAuthUrl(cfg: GoogleConfig): Promise<{ url: string; pending: PendingAuth }> {
  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = randomString(16);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    pending: { verifier, state },
  };
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await requestUrl({
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams(body).toString(),
    throw: false,
  });
  if (res.status >= 400) {
    const j = res.json as { error?: string; error_description?: string };
    throw new Error(`${j?.error ?? res.status}: ${j?.error_description ?? ""}`);
  }
  return res.json as Record<string, unknown>;
}

// Chiamata con l'URL a cui Google ha reindirizzato (contiene ?code=...&state=...)
export async function completeLogin(
  cfg: GoogleConfig,
  pending: PendingAuth,
  redirectedUrl: string,
): Promise<GoogleAccount> {
  // Tollerante: su iPhone la barra di Safari spesso copia l'URL senza «http://» o solo la parte dopo «?»
  const q = new URLSearchParams(redirectedUrl.trim().replace(/^[^?]*\?/, "").replace(/#.*$/, ""));
  const err = q.get("error");
  if (err) throw new Error(err);
  const code = q.get("code");
  if (!code)
    throw new Error(
      "Nell'URL incollato manca «code=...»: copia l'indirizzo intero della pagina (deve contenere ?state=...&code=...)",
    );
  if (q.get("state") !== pending.state) throw new Error("State non valido: riprova il login");

  const t = await tokenRequest({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
    code_verifier: pending.verifier,
  });
  const accessToken = t.access_token as string;
  const info = await requestUrl({
    url: "https://openidconnect.googleapis.com/v1/userinfo",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return {
    email: (info.json as { email: string }).email,
    refreshToken: (t.refresh_token as string) ?? "",
    accessToken,
    expiry: Date.now() + ((t.expires_in as number) ?? 3600) * 1000 - 60_000,
  };
}

async function accessToken(ctx: GoogleCtx, email: string): Promise<string> {
  const acc = ctx.google.accounts.find((a) => a.email === email);
  if (!acc) throw new Error(`Account Google non trovato: ${email}`);
  if (acc.accessToken && Date.now() < acc.expiry) return acc.accessToken;
  if (!acc.refreshToken) throw new Error(`Nessun refresh token per ${email}: rifai il login`);
  const t = await tokenRequest({
    client_id: ctx.google.clientId,
    client_secret: ctx.google.clientSecret,
    refresh_token: acc.refreshToken,
    grant_type: "refresh_token",
  });
  acc.accessToken = t.access_token as string;
  acc.expiry = Date.now() + ((t.expires_in as number) ?? 3600) * 1000 - 60_000;
  await ctx.save();
  return acc.accessToken;
}

async function api<T>(
  ctx: GoogleCtx,
  email: string,
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const token = await accessToken(ctx, email);
  const res = await requestUrl({
    url,
    method,
    headers: { Authorization: `Bearer ${token}` },
    contentType: body === undefined ? undefined : "application/json",
    body: body === undefined ? undefined : JSON.stringify(body),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`Google API ${res.status}: ${res.text.slice(0, 200)}`);
  return (res.status === 204 || !res.text ? {} : res.json) as T;
}

export async function listCalendars(
  ctx: GoogleCtx,
  email: string,
): Promise<{ id: string; summary: string; color: string }[]> {
  const j = await api<{ items: { id: string; summary: string; summaryOverride?: string; backgroundColor?: string }[] }>(
    ctx,
    email,
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader",
  );
  return j.items.map((c) => ({ id: c.id, summary: c.summaryOverride || c.summary, color: c.backgroundColor ?? "#4285f4" }));
}

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  recurringEventId?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
}

const cache = new Map<string, { t: number; events: GEvent[] }>();
const TTL_MS = 2 * 60 * 1000;

export function clearGoogleCache(): void {
  cache.clear();
}

export async function fetchGoogleEvents(
  ctx: GoogleCtx,
  cal: GoogleCalendarRef,
  rangeStart: Date,
  rangeEnd: Date,
  contrast: (c: string) => string,
): Promise<EventInput[]> {
  const key = `${cal.account}|${cal.calendarId}|${rangeStart.getTime()}|${rangeEnd.getTime()}`;
  let events = cache.get(key);
  if (!events || Date.now() - events.t > TTL_MS) {
    const all: GEvent[] = [];
    let pageToken = "";
    do {
      const q = new URLSearchParams({
        timeMin: rangeStart.toISOString(),
        timeMax: rangeEnd.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "2500",
      });
      if (pageToken) q.set("pageToken", pageToken);
      const j = await api<{ items?: GEvent[]; nextPageToken?: string }>(
        ctx,
        cal.account,
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.calendarId)}/events?${q}`,
      );
      all.push(...(j.items ?? []));
      pageToken = j.nextPageToken ?? "";
    } while (pageToken);
    events = { t: Date.now(), events: all };
    cache.set(key, events);
  }

  return events.events
    .filter((e) => e.status !== "cancelled" && (e.start.date || e.start.dateTime))
    .map((e) => ({
      id: `g:${cal.calendarId}:${e.id}`,
      title: e.summary || "(senza titolo)",
      start: e.start.dateTime ?? e.start.date,
      end: e.end.dateTime ?? e.end.date,
      allDay: !e.start.dateTime,
      backgroundColor: cal.color,
      borderColor: cal.color,
      textColor: contrast(cal.color),
      editable: false,
      extendedProps: {
        external: true,
        evColor: cal.color,
        evText: contrast(cal.color),
        calName: cal.name,
        location: e.location ?? "",
        description: e.description ?? "",
        htmlLink: e.htmlLink ?? "",
        google: {
          account: cal.account,
          calendarId: cal.calendarId,
          eventId: e.id,
          recurring: !!e.recurringEventId,
          start: e.start,
          end: e.end,
          summary: e.summary ?? "",
        } as GoogleEventRef,
      },
    }));
}

// --- Scrittura -------------------------------------------------------------

export interface GoogleEventRef {
  account: string;
  calendarId: string;
  eventId: string;
  recurring: boolean;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  summary: string;
}

// Dati del form. Le date sono YYYY-MM-DD, le ore HH:MM. `endDate` è inclusiva.
export interface GoogleEventForm {
  title: string;
  date: string;
  endDate: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  location: string;
  description: string;
  // Solo in creazione
  recurrence?: { unit: "day" | "week" | "month"; interval: number; count?: number; until?: string };
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s: string, n: number) => {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

// Da evento Google a valori del form (fine inclusiva per i "tutto il giorno")
export function formFromGoogle(
  ref: GoogleEventRef,
  extra: { location: string; description: string },
): GoogleEventForm {
  const allDay = !ref.start.dateTime;
  if (allDay) {
    const s = ref.start.date as string;
    const lastDay = addDays(ref.end.date as string, -1);
    return {
      title: ref.summary,
      date: s,
      endDate: lastDay > s ? lastDay : "",
      allDay,
      startTime: "09:00",
      endTime: "10:00",
      ...extra,
    };
  }
  const st = new Date(ref.start.dateTime as string);
  const en = new Date(ref.end.dateTime as string);
  const sd = ymd(st);
  const ed = ymd(en);
  return {
    title: ref.summary,
    date: sd,
    endDate: ed !== sd ? ed : "",
    allDay,
    startTime: `${pad(st.getHours())}:${pad(st.getMinutes())}`,
    endTime: `${pad(en.getHours())}:${pad(en.getMinutes())}`,
    ...extra,
  };
}

function rrule(r: NonNullable<GoogleEventForm["recurrence"]>, allDay: boolean): string {
  const freq = { day: "DAILY", week: "WEEKLY", month: "MONTHLY" }[r.unit];
  let rule = `RRULE:FREQ=${freq};INTERVAL=${Math.max(1, r.interval)}`;
  // Per eventi con ora Google richiede UNTIL in UTC con ora; per quelli "tutto il giorno" basta la data
  if (r.until) rule += `;UNTIL=${r.until.replace(/-/g, "")}${allDay ? "" : "T235959Z"}`;
  else if (r.count) rule += `;COUNT=${r.count}`;
  return rule;
}

function bodyFromForm(f: GoogleEventForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: f.title,
    location: f.location,
    description: f.description,
  };
  if (f.allDay) {
    body.start = { date: f.date };
    // Google vuole la fine esclusiva
    body.end = { date: addDays(f.endDate || f.date, 1) };
  } else {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let endDate = f.endDate || f.date;
    // Fine <= inizio nello stesso giorno: attraversa la mezzanotte
    if (endDate === f.date && f.endTime <= f.startTime) endDate = addDays(f.date, 1);
    body.start = { dateTime: `${f.date}T${f.startTime}:00`, timeZone: tz };
    body.end = { dateTime: `${endDate}T${f.endTime}:00`, timeZone: tz };
  }
  if (f.recurrence) body.recurrence = [rrule(f.recurrence, f.allDay)];
  return body;
}

const eventsUrl = (calendarId: string, eventId = "") =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${
    eventId ? "/" + encodeURIComponent(eventId) : ""
  }`;

export async function createGoogleEvent(
  ctx: GoogleCtx,
  cal: { account: string; calendarId: string },
  form: GoogleEventForm,
): Promise<void> {
  await api(ctx, cal.account, eventsUrl(cal.calendarId), "POST", bodyFromForm(form));
  clearGoogleCache();
}

// PATCH: aggiorna solo i campi inviati. Su un evento ricorrente (istanza) vale per quella occorrenza.
export async function updateGoogleEvent(
  ctx: GoogleCtx,
  ref: GoogleEventRef,
  form: GoogleEventForm,
): Promise<void> {
  await api(ctx, ref.account, eventsUrl(ref.calendarId, ref.eventId), "PATCH", bodyFromForm(form));
  clearGoogleCache();
}

export async function deleteGoogleEvent(ctx: GoogleCtx, ref: GoogleEventRef): Promise<void> {
  await api(ctx, ref.account, eventsUrl(ref.calendarId, ref.eventId), "DELETE");
  clearGoogleCache();
}
