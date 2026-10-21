export const pad = (n: number) => String(n).padStart(2, "0");
export const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export type RepeatUnit = "day" | "week" | "month";

export function addStep(d: Date, unit: RepeatUnit, n: number): Date {
  const r = new Date(d);
  if (unit === "day") r.setDate(r.getDate() + n);
  else if (unit === "week") r.setDate(r.getDate() + 7 * n);
  else r.setMonth(r.getMonth() + n);
  return r;
}

export interface DropPos {
  start: Date;
  end: Date | null;
  allDay: boolean;
}

const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Posizione dopo il trascinamento in campi del form. `endDate` è inclusiva ("" se evento di un giorno).
// FullCalendar dà la fine esclusiva per gli eventi «tutto il giorno».
export function dropToFields(d: DropPos) {
  const date = fmt(d.start);
  if (d.allDay) {
    let endDate = "";
    if (d.end) {
      const e = new Date(d.end);
      e.setDate(e.getDate() - 1);
      if (fmt(e) > date) endDate = fmt(e);
    }
    return { allDay: true, date, endDate, startTime: "09:00", endTime: "10:00" };
  }
  const end = d.end ?? new Date(d.start.getTime() + 3600000);
  return {
    allDay: false,
    date,
    endDate: fmt(end) !== date ? fmt(end) : "",
    startTime: hm(d.start),
    endTime: hm(end),
  };
}
