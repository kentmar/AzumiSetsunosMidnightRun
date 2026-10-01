import * as THREE from 'three';

// Daily-return layer, fully client-side: one seeded Daily Route per local
// calendar day (same for every player), a streak of consecutive cleared days,
// per-day best + top-5 times, and an all-time best sprint. Everything persists
// to localStorage behind try/catch — private windows just lose the history.

/** credits for the first Daily Route clear of the day */
export const DAILY_BONUS = 3;
/** streak lengths that pay +1 extra credit, once each per streak */
export const STREAK_MILESTONES = [3, 7, 14, 30];
export const DAILY_CHECKPOINTS = 6;

// leg spacing (m): not the junction next door, not across the whole island
const LEG_MIN = 260;
const LEG_MAX = 720;
const MIN_REVISIT = 150; // no checkpoint this close to an earlier one
const KEEP_DAYS = 21; // older per-day records are pruned

const KEY_DAILY = 'nightrun-daily';
const KEY_BEST_SPRINT = 'nightrun-best-sprint';

// ---------- seeded randomness ----------

/** player's local calendar date, YYYY-MM-DD */
export function localDateKey(d = new Date()): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** whole days from a to b (both YYYY-MM-DD); DST-proof via UTC */
export function dayDiff(a: string, b: string): number {
  const t = (k: string) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / 86400000);
}

/** FNV-1a 32-bit string hash */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, good enough for picking junctions */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** seeded generator for one feature on one day ('route', 'sky', …) */
export function dailyRng(dateKey: string, salt: string): () => number {
  return mulberry32(hashString(`nightrun:${salt}:${dateKey}`));
}

/** weighted pick of an id from a seeded roll */
export function pickWeighted<T extends { id: string; weight: number }>(items: T[], r: number): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let x = r * total;
  for (const it of items) {
    x -= it.weight;
    if (x < 0) return it;
  }
  return items[items.length - 1];
}

// ---------- the route ----------

/**
 * Today's checkpoint sequence. Same pool rollCheckpoints uses; the pool is
 * sorted first so the result never depends on array order, only on the date.
 * Each leg is LEG_MIN..LEG_MAX from the previous point (the first from the
 * spawn); if the map runs out of candidates the window widens rather than fail.
 */
export function buildDailyRoute(
  dateKey: string,
  pool: THREE.Vector3[],
  start: THREE.Vector3,
  count = DAILY_CHECKPOINTS
): THREE.Vector3[] {
  const rng = dailyRng(dateKey, 'route');
  const left = [...pool].sort((a, b) => a.x - b.x || a.z - b.z);
  const out: THREE.Vector3[] = [];
  let prev = start;
  while (out.length < count && left.length) {
    let cands: number[] = [];
    for (let widen = 1; widen <= 4 && !cands.length; widen++) {
      const lo = LEG_MIN / widen, hi = LEG_MAX * widen;
      cands = [];
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        const d = Math.hypot(p.x - prev.x, p.z - prev.z);
        if (d < lo || d > hi) continue;
        if (out.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < MIN_REVISIT / widen)) continue;
        cands.push(i);
      }
    }
    const idx = cands.length ? cands[Math.floor(rng() * cands.length)] : Math.floor(rng() * left.length);
    prev = left.splice(idx, 1)[0].clone();
    out.push(prev);
  }
  return out;
}

// ---------- leaderboard ----------

export interface LeaderboardEntry {
  /** seconds */
  time: number;
  /** epoch ms the run finished */
  at: number;
  /** display name; local entries are always 'YOU' */
  name: string;
}

/**
 * Where Daily Route times go. Async on purpose: the local board resolves
 * immediately, a future server board can drop in behind the same shape
 * (submit then top) without touching the game or the HUD.
 */
export interface LeaderboardSource {
  readonly label: string;
  submit(dateKey: string, time: number): Promise<void>;
  top(dateKey: string, n: number): Promise<LeaderboardEntry[]>;
}

// ---------- persistence ----------

interface DayRecord {
  /** top personal times, ascending (max 5) */
  times: LeaderboardEntry[];
  /** first-clear bonus already paid */
  paid: boolean;
}

interface DailySave {
  days: Record<string, DayRecord>;
  streak: number;
  /** last date with a cleared Daily Route */
  lastClear: string | null;
  /** streak milestones already paid in the current streak */
  milestonesPaid: number[];
}

export interface DailyResult {
  time: number;
  firstClear: boolean;
  newDayBest: boolean;
  newAllTime: boolean;
  bonus: number;
  streakBonus: number;
  streak: number;
}

function loadSave(): DailySave {
  const empty: DailySave = { days: {}, streak: 0, lastClear: null, milestonesPaid: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_DAILY) ?? 'null');
    if (!raw || typeof raw !== 'object') return empty;
    return {
      days: raw.days && typeof raw.days === 'object' ? raw.days : {},
      streak: Number.isFinite(raw.streak) ? raw.streak : 0,
      lastClear: typeof raw.lastClear === 'string' ? raw.lastClear : null,
      milestonesPaid: Array.isArray(raw.milestonesPaid) ? raw.milestonesPaid : [],
    };
  } catch {
    return empty;
  }
}

export class DailyStore implements LeaderboardSource {
  readonly label = 'PERSONAL';
  private save = loadSave();
  bestSprint = (() => {
    try {
      const v = Number(localStorage.getItem(KEY_BEST_SPRINT));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  })();

  private persist() {
    // prune stale days so the save never grows without bound
    const today = localDateKey();
    for (const k of Object.keys(this.save.days)) {
      if (dayDiff(k, today) > KEEP_DAYS) delete this.save.days[k];
    }
    try {
      localStorage.setItem(KEY_DAILY, JSON.stringify(this.save));
    } catch { /* storage blocked: history lives for this session only */ }
  }

  /** current streak as of `today`: a missed day breaks it */
  streak(today = localDateKey()): number {
    const last = this.save.lastClear;
    if (!last) return 0;
    const gap = dayDiff(last, today);
    return gap === 0 || gap === 1 ? this.save.streak : 0;
  }

  dayBest(dateKey: string): number | null {
    return this.save.days[dateKey]?.times[0]?.time ?? null;
  }

  /** fold an arcade or daily sprint into the all-time best; true if it's a record */
  recordSprint(time: number): boolean {
    if (this.bestSprint !== null && time >= this.bestSprint) return false;
    this.bestSprint = time;
    try {
      localStorage.setItem(KEY_BEST_SPRINT, time.toFixed(3));
    } catch { /* ignore */ }
    return true;
  }

  /**
   * A finished Daily Route. Pays the first-clear bonus once per date and the
   * streak milestone at most once per streak — re-running the route the same
   * day only records the time. A clock wound back behind the last clear pays
   * nothing (cheap guard against date-hopping; this is all client-side).
   */
  completeDaily(dateKey: string, time: number): DailyResult {
    const s = this.save;
    const day = (s.days[dateKey] ??= { times: [], paid: false });
    const prevBest = day.times[0]?.time ?? null;
    this.pushTime(day, time);
    const newAllTime = this.recordSprint(time);

    let bonus = 0, streakBonus = 0;
    const firstClear = !day.paid;
    const clockOk = !s.lastClear || dayDiff(s.lastClear, dateKey) >= 0;
    if (firstClear && clockOk) {
      day.paid = true;
      bonus = DAILY_BONUS;
      const gap = s.lastClear ? dayDiff(s.lastClear, dateKey) : Infinity;
      if (gap === 1) s.streak += 1;
      else if (gap !== 0) {
        s.streak = 1;
        s.milestonesPaid = [];
      }
      s.lastClear = dateKey;
      if (STREAK_MILESTONES.includes(s.streak) && !s.milestonesPaid.includes(s.streak)) {
        s.milestonesPaid.push(s.streak);
        streakBonus = 1;
      }
    }
    this.persist();
    return {
      time,
      firstClear: bonus > 0,
      newDayBest: prevBest === null || time < prevBest,
      newAllTime,
      bonus,
      streakBonus,
      streak: this.streak(dateKey),
    };
  }

  private pushTime(day: DayRecord, time: number) {
    day.times.push({ time, at: Date.now(), name: 'YOU' });
    day.times.sort((a, b) => a.time - b.time);
    day.times.length = Math.min(day.times.length, 5);
  }

  // LeaderboardSource — completeDaily already stored the time locally
  async submit(): Promise<void> {}
  async top(dateKey: string, n: number): Promise<LeaderboardEntry[]> {
    return (this.save.days[dateKey]?.times ?? []).slice(0, n);
  }
}

/** m:ss.cc */
export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
