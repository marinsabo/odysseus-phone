/**
 * The phone page: calories, protein and a weigh-in, typed while the laptop is somewhere else.
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
  BACKFILL_DAYS, addDays, averages, buildEntry, entryPath, isoDate, latestWeight, mergeDays, pruneEntries, publicEntry,
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
};

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

function renderLog() {
  const today = isoDate(new Date());
  const date = el("input", { type: "date", value: today, min: addDays(today, -BACKFILL_DAYS), max: today, "aria-label": words.date });
  const input = (mode, label) => el("input", { type: "text", inputMode: mode, enterKeyHint: "next", autocomplete: "off", "aria-label": label });
  const inputs = {
    calories_in: input("numeric", words.calories),
    protein_g: input("numeric", words.protein),
    weight_kg: input("decimal", words.weight),
  };
  const field = (key, unit) => el("label", { class: "field", "data-field": key }, el("span", {}, fieldNames[key]), inputs[key], el("span", { class: "unit" }, unit));
  const status = el("p", { class: "status", role: "status" });
  const summary = el("div");

  // What the day already holds shows as a placeholder: a blank field leaves it alone.
  function showDay() {
    const day = mergeDays(read(STORE.snapshot, null), read(STORE.entries, [])).get(date.value);
    for (const [key, node] of Object.entries(inputs)) node.placeholder = day?.[key] === undefined ? "" : String(day[key]);
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
      el("label", { class: "field" }, el("span", {}, words.date), date),
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
  window.addEventListener("online", () => sync(false));
}

function render() {
  if (read(STORE.repo) && read(STORE.token)) renderLog();
  else renderSetup();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
