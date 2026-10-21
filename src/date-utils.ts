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
