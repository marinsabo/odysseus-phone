/**
 * What the phone works out for itself, with no page or network in it, so it can be tested.
 *
 * The same rules as `daemon/odysseus/domain/intake.py`, on purpose: averages are over the days
 * that have a number, a blank day is not a zero, and no change is read off fewer than four
 * logged days on either side.
 */

export const WINDOWS = [7, 28];
export const MIN_LOGGED_FOR_TREND = 4;
export const BACKFILL_DAYS = 7;
/** Past this a day is reconstructed rather than rated, as in `domain/checkin.py`. */
export const SUBJECTIVE_RECALL_DAYS = 2;
/** The answer that means the planned session was replaced by another one. */
export const SWAPPED = -1;
/** What can be logged at the check-in. "training" reads as "Other training". */
export const WORKOUTS = ["gym", "kickboxing", "run", "training"];
const KEYS = ["calories_in", "protein_g"];
/** Long enough for any queue. A laptop gone longer than this has bigger news than a number. */
const KEEP_DAYS = 56;
export const LIMITS = {
  calories_in: [1, 15000],
  protein_g: [0, 1000],
  weight_kg: [30, 250],
};

const pad = (n) => String(n).padStart(2, "0");

export function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The moment with its own offset, which the laptop reads back as the day it was typed on. */
export function isoMoment(d) {
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hours}:${minutes}`;
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** A typed number. A comma is a decimal point here. Null when blank, NaN when it is not one. */
export function parseNumber(text) {
  const clean = String(text ?? "").trim().replace(",", ".");
  return clean === "" ? null : Number(clean);
}

/** The entry to send, or a code naming the field that cannot go. */
export function buildEntry({ id, date, now, fields, checkin }) {
  const entry = { id, date, entered_at: isoMoment(now) };
  let any = false;
  if (checkin) {
    entry.checkin = checkin;
    any = true;
  }
  for (const [key, [low, high]] of Object.entries(LIMITS)) {
    const value = parseNumber(fields[key]);
    if (value === null) continue;
    if (!Number.isFinite(value) || value < low || value > high) return { error: key };
    entry[key] = key === "weight_kg" ? Math.round(value * 10) / 10 : Math.round(value);
    any = true;
  }
  return any ? { entry } : { error: "empty" };
}

/**
 * The record as the phone should show it: the laptop's snapshot, with whatever was typed here
 * since laid over it, oldest first so the last thing typed for a day is the one that stands.
 */
export function mergeDays(snapshot, entries) {
  const applied = new Set(snapshot?.applied ?? []);
  const days = new Map((snapshot?.days ?? []).map((d) => [d.date, { ...d }]));
  const pending = entries
    .filter((e) => !applied.has(e.id))
    .sort((a, b) => a.entered_at.localeCompare(b.entered_at));
  for (const entry of pending) {
    const day = days.get(entry.date) ?? { date: entry.date };
    for (const key of [...KEYS, "weight_kg"]) {
      if (entry[key] !== undefined) day[key] = entry[key];
    }
    days.set(entry.date, day);
  }
  return days;
}

function mean(values) {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

function stretch(days, last, span) {
  const found = [];
  for (let i = 0; i < span; i += 1) {
    const day = days.get(addDays(last, -i));
    if (day && KEYS.some((k) => day[k] !== undefined)) found.push(day);
  }
  const read = (key) => mean(found.flatMap((d) => (d[key] === undefined ? [] : [d[key]])));
  return { days: span, days_logged: found.length, calories_in: read("calories_in"), protein_g: read("protein_g") };
}

export function averages(days, today) {
  return WINDOWS.map((span) => {
    const now = stretch(days, today, span);
    const before = stretch(days, addDays(today, -span), span);
    const comparable = Math.min(now.days_logged, before.days_logged) >= MIN_LOGGED_FOR_TREND;
    const change = (key) =>
      comparable && now[key] !== null && before[key] !== null ? now[key] - before[key] : null;
    return { ...now, before, change: { calories_in: change("calories_in"), protein_g: change("protein_g") } };
  });
}

export function latestWeight(days, snapshot) {
  let latest = snapshot?.latest_weight ?? null;
  for (const day of days.values()) {
    if (day.weight_kg !== undefined && (!latest || day.date >= latest.date)) {
      latest = { date: day.date, kg: day.weight_kg };
    }
  }
  return latest;
}

/** Entries still worth keeping: not sent yet, or sent and not yet in the laptop's snapshot. */
export function pruneEntries(entries, snapshot, today) {
  const applied = new Set(snapshot?.applied ?? []);
  const oldest = addDays(today, -KEEP_DAYS);
  return entries.filter((e) => !e.sent || (!applied.has(e.id) && e.date >= oldest));
}

/** The file an entry lives in. The laptop reads the id back out of the name. */
export function entryPath(entry) {
  return `inbox/${entry.date}_${entry.id}.json`;
}

export function publicEntry(entry) {
  const { sent: _sent, ...rest } = entry;
  return rest;
}

/** The laptop's form for the day, or an empty one: a day it knows nothing about still gets asked. */
export function checkinForm(snapshot, date) {
  return snapshot?.checkin?.find((f) => f.date === date) ?? { date, answered: false, planned: [], logged: [], unrated: [] };
}

/** Answered on the laptop, or here and on its way there. One check-in a day from the phone. */
export function checkinAnswered(snapshot, entries, date) {
  return checkinForm(snapshot, date).answered || entries.some((e) => e.date === date && e.checkin);
}

/**
 * The questions for the day, in the desktop's order (`shell/src/screens/CheckIn.tsx`). Only what
 * a sensor cannot see: a step is left out when nothing about the day needs it.
 */
export function checkinSteps(form, { today, day }) {
  const notIll = (a) => a.ill !== "ill";
  const steps = [{ id: "ill", kind: "ill" }];
  for (const session of form.unrated) {
    steps.push({ id: `rating:${session.id}`, kind: "session", type: session.session_type });
  }
  for (const planned of form.planned) {
    if (form.logged.includes(planned.session_type)) continue;
    const id = `planned:${planned.id}:${planned.session_type}`;
    steps.push({ id, kind: "planned", type: planned.session_type, when: notIll });
    steps.push({
      id: `swap:${planned.id}`,
      kind: "swap",
      types: WORKOUTS.filter((t) => t !== planned.session_type),
      when: (a) => notIll(a) && a[id] === SWAPPED,
    });
    steps.push({
      id: `swaprating:${planned.id}`,
      kind: "rating",
      when: (a) => notIll(a) && a[id] === SWAPPED && typeof a[`swap:${planned.id}`] === "string",
    });
  }
  steps.push({ id: "extra", kind: "extra" });
  steps.push({ id: "extrarating", kind: "rating", when: (a) => typeof a.extra === "string" });
  if (addDays(form.date, SUBJECTIVE_RECALL_DAYS) >= today) {
    steps.push({ id: "energy", kind: "energy" });
    steps.push({ id: "mood", kind: "mood" });
  }
  const missing = KEYS.filter((key) => day?.[key] === undefined);
  if (missing.length) steps.push({ id: "numbers", kind: "numbers", fields: missing });
  return steps;
}

/** The next step that applies given the answers so far, or -1 when there is none. */
export function nextStep(steps, index, answers) {
  for (let i = index + 1; i < steps.length; i += 1) {
    if (!steps[i].when || steps[i].when(answers)) return i;
  }
  return -1;
}

/** The answers as the laptop reads them. A planned session that did not happen is not logged. */
export function buildCheckin(answers) {
  const ratings = {};
  const sessions = [];
  for (const [id, value] of Object.entries(answers)) {
    if (typeof value !== "number") continue;
    if (id.startsWith("rating:")) ratings[id.slice(7)] = value;
    if (id.startsWith("planned:") && value !== SWAPPED) sessions.push({ session_type: id.split(":")[2], quality: value });
    if (id.startsWith("swaprating:")) {
      const plannedId = id.slice(11);
      const planned = Object.entries(answers).find(([k]) => k.startsWith(`planned:${plannedId}:`));
      const type = answers[`swap:${plannedId}`];
      if (planned?.[1] === SWAPPED && typeof type === "string") sessions.push({ session_type: type, quality: value });
    }
    if (id === "extrarating" && typeof answers.extra === "string") sessions.push({ session_type: answers.extra, quality: value });
  }
  return { ill: answers.ill === "ill", energy: answers.energy ?? null, mood: answers.mood ?? null, ratings, sessions };
}
