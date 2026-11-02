/**
 * The phone page: the evening check-in, calories, protein and a weigh-in, typed while the laptop
 * is somewhere else.
 *
 * There is no server. Each entry goes as one file into a private GitHub repository and the
 * laptop's importer (`daemon/odysseus/etl/phone.py`) reads it whenever it is next on; the
 * laptop writes `snapshot.json` back for the averages. The token lives in this browser's
 * storage and is sent to api.github.com and nowhere else, which the page's CSP also enforces.
 * The page holds no data of its own, so it is safe to serve publicly.
 *
 * Numbers only, the same as the desktop's Nutrition screen: targets stand beside the averages
 * as reminders, and nothing is coloured or graded against them.
 *
 * The words are all here rather than in `shell/src/strings.ts`, because this page is published
 * on its own and shares nothing with the shell at build time.
 */

import {
  BACKFILL_DAYS, LIMITS, SWAPPED, WORKOUTS, addDays, averages, buildCheckin, buildEntry, checkinAnswered, checkinForm, checkinSteps,
  entryPath, isoDate, latestWeight, mergeDays, nextStep, parseNumber, pruneEntries, publicEntry,
} from "./logic.js";

const API = "https://api.github.com";
const STORE = { repo: "odysseus.repo", token: "odysseus.token", entries: "odysseus.entries", snapshot: "odysseus.snapshot" };

const words = {
  setupTitle: "Connect",
  setupNote:
    "Your private data repository and a fine-grained token with Contents read and write on that repository only. The token stays on this phone.",
  repo: "Repository",
  repoPlaceholder: "owner/name",
  token: "Token",
  connect: "Connect",
  connecting: "Checking…",
  refused: "GitHub refused that repository or token.",
  offline: "No signal, so that could not be checked.",
  title: "Today",
  date: "Day",
  calories: "Calories",
  protein: "Protein",
  weight: "Weight",
  save: "Save",
  empty: "Nothing typed yet.",
  outOfRange: (name) => `${name} is out of range.`,
  queued: (n) => `Saved on this phone. ${n === 1 ? "1 entry waits" : `${n} entries wait`} for signal.`,
  sent: "Saved. The laptop reads it next time it is on.",
  tokenRefused: "GitHub refused the token. Saved here until it is fixed.",
  averages: "Averages",
  window: (days) => `Last ${days} days`,
  logged: (logged, days) => `${logged} of ${days} days logged`,
  before: (days, text) => `${days} days before: ${text}`,
  target: "Target",
  lastWeight: "Last weigh-in",
  goal: "Lean bulk",
  goalValue: (goal) => `+${goal.kg_per_week[0]}–${goal.kg_per_week[1]} kg/wk`,
  goalDetail: (goal) => `At ${goal.protein_g_per_kg[0].toFixed(1)}–${goal.protein_g_per_kg[1].toFixed(1)} g of protein per kilo`,
  laptop: (when) => `Laptop last sent its record on ${when}.`,
  laptopNever: "The laptop has not sent its record yet, so this is only what was typed here.",
  disconnect: "Disconnect this phone",
  disconnectSure: "Remove the token from this phone? Anything not yet sent is kept.",
  numbers: "Numbers",
  checkin: "Evening check-in",
  checkedIn: "Checked in for this day.",
  checkinTitle: (label) => `Check-in, ${label}`,
  backfillNote: "Recording an earlier day.",
  back: "Back",
  cancel: "Cancel",
  done: "Done",
  scale: "1 low, 5 high",
  ill: "Were you ill?",
  illFootnote: "Planned training on a day you were ill comes off this week's number.",
  illNo: "No",
  illYes: "Yes, I was ill",
  session: (type) => `${sessionNames[type] ?? type}. How did it go?`,
  sessionMissed: "Did not happen",
  sessionSwapped: "Did something else",
  swapWhich: "What was it instead?",
  extra: "Any other training today?",
  extraNone: "Nothing else",
  extraRating: "How did it go?",
  energy: "Energy",
  mood: "Mood",
  nutrition: "Calories and protein",
  recorded: "Recorded",
  ofFive: (label, value) => `${label} ${value} of 5`,
  illRecorded: "Ill",
};

const sessionNames = { gym: "Gym", kickboxing: "Kickboxing", run: "Run", training: "Other training", cycling: "Cycling", walking: "Walk", hiking: "Hike", swimming: "Swim" };

const fieldNames = { calories_in: words.calories, protein_g: words.protein, weight_kg: words.weight };
const format = (n) => Math.round(n).toLocaleString("en-US");
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${format(Math.abs(n))}`;
const line = (calories, protein) =>
  [calories === null || calories === undefined ? null : `${format(calories)} kcal`,
   protein === null || protein === undefined ? null : `${format(protein)} g`]
    .filter(Boolean)
    .join(" · ") || "—";
const shortDate = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));

class Refused extends Error {}

async function github(method, path, body) {
  const { repo, token } = { repo: read(STORE.repo), token: read(STORE.token) };
  const response = await fetch(`${API}/repos/${repo}${path}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401 || response.status === 403) throw new Refused();
  return response;
}

/** The file is already there, which is what a retry after a lost reply looks like: 422. */
async function flush() {
  const entries = read(STORE.entries, []);
  for (const entry of entries.filter((e) => !e.sent)) {
    const content = btoa(JSON.stringify(publicEntry(entry)));
    const response = await github("PUT", `/contents/${entryPath(entry)}`, { message: "Entry from the phone", content });
    if (!response.ok && response.status !== 422) throw new Error(String(response.status));
    entry.sent = true;
    write(STORE.entries, entries);
  }
}

async function loadSnapshot() {
  const response = await github("GET", "/contents/snapshot.json");
  if (response.status === 404) return;
  if (!response.ok) throw new Error(String(response.status));
  const found = await response.json();
  write(STORE.snapshot, JSON.parse(atob(found.content.replace(/\n/g, ""))));
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

const app = document.getElementById("app");
let resync = null;

function renderSetup(message = "") {
  const repo = el("input", { value: read(STORE.repo, ""), placeholder: words.repoPlaceholder, autocapitalize: "none", autocomplete: "off", spellcheck: false, "aria-label": words.repo });
  const token = el("input", { type: "password", autocomplete: "off", "aria-label": words.token });
  const status = el("p", { class: "status", role: "status" }, message);
  const button = el("button", {
    type: "button",
    onclick: async () => {
      if (!repo.value.trim() || !token.value.trim()) return;
      button.disabled = true;
      status.textContent = words.connecting;
      write(STORE.repo, repo.value.trim());
      write(STORE.token, token.value.trim());
      try {
        const response = await github("GET", "");
        if (!response.ok) throw new Refused();
        render();
      } catch (exc) {
        localStorage.removeItem(STORE.token);
        status.textContent = exc instanceof Refused ? words.refused : words.offline;
        button.disabled = false;
      }
    },
  }, words.connect);
  app.replaceChildren(
    el("h1", {}, words.setupTitle),
    el("div", { class: "card stack" },
      el("label", { class: "field" }, el("span", {}, words.repo), repo),
      el("label", { class: "field" }, el("span", {}, words.token), token)),
    button,
    status,
    el("p", { class: "note" }, words.setupNote),
  );
}

function renderSummary(root) {
  const snapshot = read(STORE.snapshot, null);
  const today = isoDate(new Date());
  const days = mergeDays(snapshot, read(STORE.entries, []));
  const rows = averages(days, today).map((w) => {
    const change = [
      w.change.calories_in === null ? null : `${signed(w.change.calories_in)} kcal`,
      w.change.protein_g === null ? null : `${signed(w.change.protein_g)} g`,
    ].filter(Boolean).join(", ");
    const hasBefore = w.before.calories_in !== null || w.before.protein_g !== null;
    return el("div", { class: "row" },
      el("div", { class: "row-head" }, el("span", {}, words.window(w.days)), el("span", { class: "row-value" }, line(w.calories_in, w.protein_g))),
      el("p", { class: "row-detail" }, [
        words.logged(w.days_logged, w.days),
        hasBefore ? words.before(w.days, line(w.before.calories_in, w.before.protein_g)) : null,
        change || null,
      ].filter(Boolean).join(" · ")));
  });
  const targets = snapshot?.targets;
  if (targets && (targets.calories_in !== null || targets.protein_g !== null)) {
    rows.push(el("div", { class: "row" },
      el("div", { class: "row-head" }, el("span", {}, words.target), el("span", { class: "row-value" }, line(targets.calories_in, targets.protein_g)))));
  }
  const weight = latestWeight(days, snapshot);
  if (weight) {
    rows.push(el("div", { class: "row" },
      el("div", { class: "row-head" }, el("span", {}, words.lastWeight), el("span", { class: "row-value" }, `${weight.kg} kg`)),
      el("p", { class: "row-detail" }, shortDate(weight.date))));
  }
  if (snapshot?.goal) {
    rows.push(el("div", { class: "row" },
      el("div", { class: "row-head" }, el("span", {}, words.goal), el("span", { class: "row-value" }, words.goalValue(snapshot.goal))),
      el("p", { class: "row-detail" }, words.goalDetail(snapshot.goal))));
  }
  root.replaceChildren(
    el("h2", {}, words.averages),
    el("div", { class: "card" }, ...rows),
    el("p", { class: "note" }, snapshot?.generated_at ? words.laptop(shortDate(snapshot.generated_at.slice(0, 10))) : words.laptopNever),
  );
}

/** One question at a time, a single tap each, as on the desktop. Nothing is sent until the end. */
function renderCheckin(day) {
  const today = isoDate(new Date());
  const snapshot = read(STORE.snapshot, null);
  const entries = read(STORE.entries, []);
  const steps = checkinSteps(checkinForm(snapshot, day), { today, day: mergeDays(snapshot, entries).get(day) });
  const answers = {};
  const trail = [];
  const header = [el("h1", {}, words.checkinTitle(shortDate(day))), day < today ? el("p", { class: "note" }, words.backfillNote) : null];

  function show(index) {
    const step = steps[index];
    const go = (update) => {
      Object.assign(answers, update);
      trail.push(index);
      const next = nextStep(steps, index, answers);
      if (next === -1) finish();
      else show(next);
    };
    const option = (label, value) => el("button", { type: "button", class: "option", onclick: () => go({ [step.id]: value }) }, label);
    const scale = () => el("div", { class: "scale" }, ...[1, 2, 3, 4, 5].map((n) => option(String(n), n)));
    const footnote = (text) => el("p", { class: "note" }, text);
    const body = {
      ill: () => [el("h2", { class: "question" }, words.ill), footnote(words.illFootnote), option(words.illNo, "well"), option(words.illYes, "ill")],
      session: () => [el("h2", { class: "question" }, words.session(step.type)), footnote(words.scale), scale()],
      planned: () => [el("h2", { class: "question" }, words.session(step.type)), footnote(words.scale), scale(), option(words.sessionMissed, null), option(words.sessionSwapped, SWAPPED)],
      swap: () => [el("h2", { class: "question" }, words.swapWhich), ...step.types.map((t) => option(sessionNames[t], t))],
      extra: () => [el("h2", { class: "question" }, words.extra), option(words.extraNone, null), ...WORKOUTS.map((t) => option(sessionNames[t], t))],
      rating: () => [el("h2", { class: "question" }, words.extraRating), footnote(words.scale), scale()],
      energy: () => [el("h2", { class: "question" }, words.energy), footnote(words.scale), scale()],
      mood: () => [el("h2", { class: "question" }, words.mood), footnote(words.scale), scale()],
      numbers: () => numbersStep(step, go),
    }[step.kind]();
    const leave = trail.length
      ? el("button", { type: "button", class: "quiet", onclick: () => show(trail.pop()) }, words.back)
      : el("button", { type: "button", class: "quiet", onclick: () => renderLog(day) }, words.cancel);
    app.replaceChildren(...header.filter(Boolean), ...body, leave);
  }

  function numbersStep(step, go) {
    const inputs = Object.fromEntries(step.fields.map((key) => [key, el("input", { type: "text", inputMode: "numeric", autocomplete: "off", "aria-label": fieldNames[key] })]));
    const status = el("p", { class: "status", role: "status" });
    return [
      el("h2", { class: "question" }, words.nutrition),
      el("div", { class: "card" }, ...step.fields.map((key) =>
        el("label", { class: "field", "data-field": key }, el("span", {}, fieldNames[key]), inputs[key], el("span", { class: "unit" }, key === "calories_in" ? "kcal" : "g")))),
      el("button", {
        type: "button",
        onclick: () => {
          for (const key of step.fields) {
            const value = parseNumber(inputs[key].value);
            if (value !== null && !(value >= LIMITS[key][0] && value <= LIMITS[key][1])) {
              status.textContent = words.outOfRange(fieldNames[key]);
              return;
            }
          }
          go(Object.fromEntries(step.fields.map((key) => [key, inputs[key].value])));
        },
      }, words.done),
      status,
    ];
  }

  async function finish() {
    const checkin = buildCheckin(answers);
    const fields = { calories_in: answers.calories_in, protein_g: answers.protein_g };
    const { entry } = buildEntry({ id: crypto.randomUUID(), date: day, now: new Date(), fields, checkin });
    write(STORE.entries, [...read(STORE.entries, []), { ...entry, sent: false }]);
    const status = el("p", { class: "status", role: "status" });
    const named = (type) => sessionNames[type] ?? type;
    const rated = Object.entries(checkin.ratings).map(([id, quality]) => {
      const found = steps.find((s) => s.id === `rating:${id}`);
      return words.ofFive(named(found.type), quality);
    });
    const lines = [
      checkin.ill ? words.illRecorded : null,
      ...rated,
      ...checkin.sessions.map((s) => words.ofFive(named(s.session_type), s.quality)),
      checkin.energy === null ? null : words.ofFive(words.energy, checkin.energy),
      checkin.mood === null ? null : words.ofFive(words.mood, checkin.mood),
      entry.calories_in === undefined ? null : `${words.calories} ${format(entry.calories_in)} kcal`,
      entry.protein_g === undefined ? null : `${words.protein} ${format(entry.protein_g)} g`,
    ].filter(Boolean);
    app.replaceChildren(
      el("h1", {}, words.recorded),
      el("div", { class: "card" }, ...lines.map((text) => el("div", { class: "row" }, text))),
      status,
      el("button", { type: "button", onclick: () => renderLog(day) }, words.done),
    );
    try {
      await flush();
      status.textContent = words.sent;
    } catch (exc) {
      status.textContent = exc instanceof Refused ? words.tokenRefused : words.queued(read(STORE.entries, []).filter((e) => !e.sent).length);
    }
  }

  show(0);
}

function renderLog(day) {
  const today = isoDate(new Date());
  const date = el("input", { type: "date", value: day ?? today, min: addDays(today, -BACKFILL_DAYS), max: today, "aria-label": words.date });
  const input = (mode, label) => el("input", { type: "text", inputMode: mode, enterKeyHint: "next", autocomplete: "off", "aria-label": label });
  const inputs = {
    calories_in: input("numeric", words.calories),
    protein_g: input("numeric", words.protein),
    weight_kg: input("decimal", words.weight),
  };
  const field = (key, unit) => el("label", { class: "field", "data-field": key }, el("span", {}, fieldNames[key]), inputs[key], el("span", { class: "unit" }, unit));
  const status = el("p", { class: "status", role: "status" });
  const summary = el("div");
  const begin = el("button", { type: "button", onclick: () => renderCheckin(date.value) }, words.checkin);
  const checkedIn = el("p", { class: "note" }, words.checkedIn);

  // What the day already holds shows as a placeholder: a blank field leaves it alone.
  function showDay() {
    const day = mergeDays(read(STORE.snapshot, null), read(STORE.entries, [])).get(date.value);
    for (const [key, node] of Object.entries(inputs)) node.placeholder = day?.[key] === undefined ? "" : String(day[key]);
    const answered = checkinAnswered(read(STORE.snapshot, null), read(STORE.entries, []), date.value);
    begin.hidden = answered;
    checkedIn.hidden = !answered;
  }

  async function sync(saved) {
    const waiting = () => read(STORE.entries, []).filter((e) => !e.sent).length;
    try {
      await flush();
      await loadSnapshot();
      write(STORE.entries, pruneEntries(read(STORE.entries, []), read(STORE.snapshot, null), today));
      if (saved) status.textContent = words.sent;
    } catch (exc) {
      if (exc instanceof Refused) status.textContent = words.tokenRefused;
      else if (saved || waiting()) status.textContent = words.queued(waiting());
    }
    showDay();
    renderSummary(summary);
  }

  const save = el("button", {
    type: "button",
    onclick: async () => {
      for (const node of app.querySelectorAll("[data-wrong]")) node.removeAttribute("data-wrong");
      const fields = Object.fromEntries(Object.entries(inputs).map(([key, node]) => [key, node.value]));
      const built = buildEntry({ id: crypto.randomUUID(), date: date.value, now: new Date(), fields });
      if (built.error === "empty") {
        status.textContent = words.empty;
        return;
      }
      if (built.error) {
        app.querySelector(`[data-field="${built.error}"]`).setAttribute("data-wrong", "");
        status.textContent = words.outOfRange(fieldNames[built.error]);
        return;
      }
      write(STORE.entries, [...read(STORE.entries, []), { ...built.entry, sent: false }]);
      for (const node of Object.values(inputs)) node.value = "";
      save.disabled = true;
      await sync(true);
      save.disabled = false;
    },
  }, words.save);

  date.addEventListener("change", () => {
    if (!date.value) date.value = today;
    showDay();
  });
  app.replaceChildren(
    el("h1", {}, words.title),
    el("div", { class: "card" },
      el("label", { class: "field" }, el("span", {}, words.date), date)),
    begin,
    checkedIn,
    el("h2", {}, words.numbers),
    el("div", { class: "card" },
      field("calories_in", "kcal"),
      field("protein_g", "g"),
      field("weight_kg", "kg")),
    save,
    status,
    summary,
    el("button", {
      type: "button",
      class: "quiet",
      onclick: () => {
        if (!confirm(words.disconnectSure)) return;
        localStorage.removeItem(STORE.token);
        render();
      },
    }, words.disconnect),
  );
  showDay();
  renderSummary(summary);
  sync(false);
  window.removeEventListener("online", resync);
  resync = () => sync(false);
  window.addEventListener("online", resync);
}

function render() {
  if (read(STORE.repo) && read(STORE.token)) renderLog();
  else renderSetup();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
