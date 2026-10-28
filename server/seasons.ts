// Seasonal windows: a set of titles that only some people see between two
// dates (Halloween movies from Oct 1 to Nov 1, every year). Times are local
// to the server (the container's TZ), written as "YYYY-MM-DDTHH:mm". A yearly
// season ignores the year and may wrap past New Year (Dec 20 → Jan 6).

export interface SeasonWindow {
  start_at: string;
  end_at: string;
  yearly: number | boolean;
}

export interface SeasonStatus {
  /** In season right now. */
  active: boolean;
  /** The current window, or the next one (the last one for an ended one-off). */
  start: Date;
  end: Date;
  /** A one-off season whose window has passed. */
  over: boolean;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function parseLocal(s: string): { y: number; mo: number; d: number; h: number; mi: number } | null {
  const m = LOCAL.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  // Rejects Feb 30 and the like (Feb 29 is fine: it's a real date some years).
  const probe = new Date(2000, mo - 1, d);
  if (probe.getMonth() !== mo - 1) return null;
  return { y, mo, d, h, mi };
}

export function seasonStatus(season: SeasonWindow, now = new Date()): SeasonStatus {
  const a = parseLocal(season.start_at);
  const b = parseLocal(season.end_at);
  if (!a || !b) return { active: false, start: now, end: now, over: true };
  const at = (p: NonNullable<typeof a>, year: number) => new Date(year, p.mo - 1, p.d, p.h, p.mi);

  if (!season.yearly) {
    const start = at(a, a.y);
    const end = at(b, b.y);
    return { active: start <= now && now < end, start, end, over: now >= end };
  }

  const windowFrom = (year: number) => {
    const start = at(a, year);
    let end = at(b, year);
    if (end <= start) end = at(b, year + 1);
    return { start, end };
  };
  const year = now.getFullYear();
  // Last year's window can still be running (Dec 20 → Jan 6, seen on Jan 2).
  for (const y of [year - 1, year]) {
    const w = windowFrom(y);
    if (w.start <= now && now < w.end) return { ...w, active: true, over: false };
  }
  const next = windowFrom(year).start > now ? windowFrom(year) : windowFrom(year + 1);
  return { ...next, active: false, over: false };
}

/** Checks a start/end pair; returns a message for the person, or null. */
export function checkWindow(start: string, end: string, yearly: boolean): string | null {
  const a = parseLocal(start);
  const b = parseLocal(end);
  if (!a) return "Pick when the season starts";
  if (!b) return "Pick when the season ends";
  if (yearly) {
    if (a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi) return "The season has to end at a different time than it starts";
    return null;
  }
  const s = new Date(a.y, a.mo - 1, a.d, a.h, a.mi);
  const e = new Date(b.y, b.mo - 1, b.d, b.h, b.mi);
  if (e <= s) return "The season has to end after it starts";
  return null;
}
