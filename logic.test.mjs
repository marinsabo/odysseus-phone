// node --test phone/logic.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  averages, buildEntry, entryPath, isoMoment, latestWeight, mergeDays, parseNumber, pruneEntries, publicEntry,
} from "./logic.js";

const TODAY = "2026-11-01";
const day = (date, calories_in, protein_g) => ({ date, calories_in, protein_g });

test("a comma is a decimal point, blank is nothing, and junk is not a number", () => {
  assert.equal(parseNumber("80,4"), 80.4);
  assert.equal(parseNumber("  "), null);
  assert.ok(Number.isNaN(parseNumber("abc")));
});

test("an entry carries only what was typed, rounded the way it is stored", () => {
  const { entry } = buildEntry({
    id: "a", date: TODAY, now: new Date(2026, 10, 1, 20), fields: { calories_in: "2800.4", protein_g: "", weight_kg: "80,44" },
  });
  assert.equal(entry.calories_in, 2800);
  assert.equal(entry.weight_kg, 80.4);
  assert.equal("protein_g" in entry, false);
});

test("nothing typed, or a number out of range, does not go", () => {
  const base = { id: "a", date: TODAY, now: new Date() };
  assert.equal(buildEntry({ ...base, fields: {} }).error, "empty");
  assert.equal(buildEntry({ ...base, fields: { protein_g: "5000" } }).error, "protein_g");
  assert.equal(buildEntry({ ...base, fields: { weight_kg: "abc" } }).error, "weight_kg");
});

test("the last thing typed for a day stands, and what the laptop has read is not laid over twice", () => {
  const snapshot = { days: [day(TODAY, 2000, 100)], applied: ["old"] };
  const days = mergeDays(snapshot, [
    { id: "b", date: TODAY, entered_at: "2026-11-01T21:00:00+01:00", protein_g: 170 },
    { id: "a", date: TODAY, entered_at: "2026-11-01T20:00:00+01:00", protein_g: 120 },
    { id: "old", date: TODAY, entered_at: "2026-11-01T08:00:00+01:00", calories_in: 1 },
  ]);
  assert.deepEqual(days.get(TODAY), day(TODAY, 2000, 170));
});

test("your real two-logged-days week: an average with its count, and no change read off it", () => {
  const days = new Map(
    [day("2026-10-26", 2682, 175), day("2026-10-27", 3100, 185),
     day("2026-10-19", 3367, 163), day("2026-10-20", 3060, 144), day("2026-10-21", 2900, 180),
     day("2026-10-22", 3000, 195), day("2026-10-24", 2339, 70)].map((d) => [d.date, d]),
  );
  const [week] = averages(days, TODAY);
  assert.equal(week.calories_in, 2891);
  assert.equal(week.protein_g, 180);
  assert.equal(week.days_logged, 2);
  assert.equal(week.before.calories_in, 2933);
  assert.equal(week.before.protein_g, 150);
  assert.deepEqual(week.change, { calories_in: null, protein_g: null });
});

test("a change appears once both sides have four logged days", () => {
  const rows = [];
  for (let i = 1; i <= 4; i += 1) rows.push(day(`2026-10-${String(i + 25).padStart(2, "0")}`, 3000, 170));
  for (let i = 1; i <= 4; i += 1) rows.push(day(`2026-10-${String(i + 18).padStart(2, "0")}`, 2800, 150));
  const [week] = averages(new Map(rows.map((d) => [d.date, d])), TODAY);
  assert.deepEqual(week.change, { calories_in: 200, protein_g: 20 });
});

test("a weigh-in typed here is the latest until a later one comes", () => {
  const snapshot = { latest_weight: { date: "2026-10-15", kg: 80 } };
  const days = mergeDays(snapshot, [{ id: "a", date: "2026-10-30", entered_at: "2026-10-30T09:00:00+01:00", weight_kg: 80.6 }]);
  assert.deepEqual(latestWeight(days, snapshot), { date: "2026-10-30", kg: 80.6 });
});

test("an unsent entry is never dropped, and a read one is", () => {
  const entries = [
    { id: "queued", date: "2026-01-01", sent: false },
    { id: "read", date: TODAY, sent: true },
    { id: "waiting", date: TODAY, sent: true },
  ];
  assert.deepEqual(pruneEntries(entries, { applied: ["read"] }, TODAY).map((e) => e.id), ["queued", "waiting"]);
});

test("the file name carries the id, and the moment carries its offset", () => {
  assert.equal(entryPath({ date: TODAY, id: "abc-1" }), "inbox/2026-11-01_abc-1.json");
  assert.match(isoMoment(new Date(2026, 10, 1, 20, 5, 9)), /^2026-11-01T20:05:09[+-]\d\d:\d\d$/);
  assert.equal("sent" in publicEntry({ id: "a", sent: true }), false);
});
