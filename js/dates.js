// Local calendar dates as 'YYYY-MM-DD' strings, shared by maintenance and
// warranty tracking. Parsed as local midnight so day counts don't drift with
// the time zone.

const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const today = () => isoOf(new Date());
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86_400_000);
export const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function addInterval(iso, n, unit) {
  const d = parse(iso);
  n = Number(n) || 1;
  if (unit === 'days') d.setDate(d.getDate() + n);
  else if (unit === 'weeks') d.setDate(d.getDate() + 7 * n);
  else if (unit === 'months' || unit === 'years') {
    const months = unit === 'years' ? 12 * n : n;
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); // Jan 31 + 1 month -> Feb 28/29
  }
  return isoOf(d);
}
