const test = require("node:test");
const assert = require("node:assert");
const app = require("../app.js");

const e = (member, kaggle_rank, score) => ({ member, kaggle_rank, score, team: `qmml-${member}` });

test("members with the same score share a place", () => {
  const places = app.withPlaces([e("A", 1, 0.9), e("B", 2, 0.9), e("C", 3, 0.8)], (x) => x.score);
  assert.deepStrictEqual(places.map((p) => [p.place, p.tied]), [[1, true], [1, true], [3, false]]);
});

test("season points: N for 1st down to 1, shared on ties, summed", () => {
  const data = { competitions: [
    { total_teams: 100, entries: [e("A", 5, 0.9), e("B", 6, 0.9), e("C", 20, 0.8)] },
    { total_teams: 100, entries: [e("B", 3, 0.7), e("A", 50, 0.6), e("C", 51, 0.6), e("D", 60, 0.5)] },
  ] };
  const got = app.standings(data).map((p) => [p.item.member, p.item.points, p.place]);
  assert.deepStrictEqual(got, [["B", 7, 1], ["A", 6, 2], ["C", 4, 3], ["D", 1, 4]]);
});

test("equal season points share a place", () => {
  const data = { competitions: [
    { total_teams: 10, entries: [e("A", 1, 0.9), e("B", 2, 0.8)] },
    { total_teams: 10, entries: [e("B", 1, 0.9), e("A", 2, 0.8)] },
  ] };
  assert.deepStrictEqual(app.standings(data).map((p) => p.place), [1, 1]);
});

test("gap to the member above, for both metric directions", () => {
  const auc = [e("Seelie", 1, 0.96009), e("MoRo", 2, 0.95946), e("YAK", 3, 0.95946)];
  assert.strictEqual(app.gapText(auc, 0, true), "Leads by 0.00063");
  assert.strictEqual(app.gapText(auc, 1, true), "0.00063 behind Seelie");
  assert.strictEqual(app.gapText(auc, 2, true), "Tied with MoRo");
  const rmse = [e("A", 1, 0.1), e("B", 2, 0.125)];
  assert.strictEqual(app.gapText(rmse, 1, false), "0.02500 behind A");
  assert.strictEqual(app.gapText([e("A", 1, 0.9)], 0, true), "Only member so far");
});

test("countdown wording", () => {
  const H = 3600e3;
  assert.strictEqual(app.fmtCountdown(21 * 24 * H + 4 * H + 60e3), "21 days 4 hours");
  assert.strictEqual(app.fmtCountdown(1 * 24 * H), "1 day 0 hours");
  assert.strictEqual(app.fmtCountdown(2 * H + 5 * 60e3), "2 hours 5 minutes");
  assert.strictEqual(app.fmtCountdown(30e3), "1 minute");
  assert.strictEqual(app.fmtCountdown(-1), "now");
});

test("status falls back to the deadline for older data", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  assert.strictEqual(app.compStatus({ deadline: "2026-10-31" }, now), "closed");
  assert.strictEqual(app.compStatus({ deadline: "2026-11-30T23:59:00Z" }, now), "open");
  assert.strictEqual(app.compStatus({ status: "final", deadline: "2026-10-31" }, now), "final");
});

test("sparkline needs two days and puts better scores higher", () => {
  assert.match(app.sparkline([["2026-10-10", 0.9]], true), /–/);
  const up = app.sparkline([["2026-10-09", 0.1], ["2026-10-10", 0.2]], true);
  const down = app.sparkline([["2026-10-09", 0.1], ["2026-10-10", 0.2]], false);
  const lastY = (svg) => Number(svg.match(/cy="([\d.]+)"/)[1]);
  assert.ok(lastY(up) < lastY(down), "a rising AUC ends high; a rising RMSE ends low");
});

test("season standings keep each competition's points and place", () => {
  const data = { competitions: [
    { slug: "oct", total_teams: 10, entries: [e("A", 1, 0.9), e("B", 2, 0.8)] },
    { slug: "nov", total_teams: 10, entries: [e("B", 1, 0.9)] },
  ] };
  const b = app.standings(data).find((p) => p.item.member === "B").item.byComp;
  assert.deepStrictEqual(b, { oct: { points: 1, place: 2 }, nov: { points: 1, place: 1 } });
});

test("this month is the running competition closing soonest, else the latest", () => {
  const now = Date.parse("2026-11-05T00:00:00Z");
  const oct = { slug: "oct", deadline: "2026-10-31T23:59:00Z", status: "final" };
  const nov = { slug: "nov", deadline: "2026-11-30T23:59:00Z", status: "open" };
  const forever = { slug: "forever", deadline: "2030-01-01T00:00:00Z", status: "open" };
  assert.strictEqual(app.pickCurrent([oct, nov, forever], now).slug, "nov");
  assert.strictEqual(app.pickCurrent([oct], now).slug, "oct");
  assert.strictEqual(app.pickCurrent([], now), null);
});

test("relative update time", () => {
  assert.strictEqual(app.fmtAgo(20e3), "just now");
  assert.strictEqual(app.fmtAgo(12 * 60e3), "12 min ago");
  assert.strictEqual(app.fmtAgo(3 * 3600e3 + 60e3), "3 hours ago");
  assert.strictEqual(app.fmtAgo(26 * 3600e3), "1 day ago");
});

test("member links and team names", () => {
  assert.strictEqual(app.memberSlug("Loss Cause"), "m-loss-cause");
  assert.strictEqual(app.memberSlug("MoRo"), "m-moro");
  assert.strictEqual(app.teamName("  Aisha Rahman "), "qmml-aisha-rahman");
  assert.strictEqual(app.teamName(""), "qmml-your-name");
});

test("rank axis ticks are whole, positive and cover the data", () => {
  const { lo, hi, ticks } = app.niceTicks(638, 1226);
  assert.ok(lo <= 638 && hi >= 1226);
  assert.ok(ticks.every((t) => Number.isInteger(t) && t > 0));
  assert.ok(app.niceTicks(1, 1).ticks.every((t) => t > 0));
});

test("race chart needs two days and highlights you, else the leader", () => {
  const h = (r1, r2) => [["2026-10-09", 0.9, r1], ["2026-10-10", 0.9, r2]];
  const c = { slug: "oct", entries: [
    { ...e("Seelie", 600, 0.96), history: h(590, 600) },
    { ...e("MoRo", 700, 0.95), history: h(740, 700) },
  ] };
  assert.match(app.raceChart(c, null), /Society leader \(Seelie\)/);
  assert.match(app.raceChart(c, "MoRo"), /You \(MoRo\)/);
  const oneDay = { slug: "oct", entries: [{ ...e("A", 1, 0.9), history: [["2026-10-10", 0.9, 1]] }] };
  assert.strictEqual(app.raceChart(oneDay, null), "");
});

test("last-day countdown is a clock", () => {
  assert.strictEqual(app.fmtClock(5 * 3600e3 + 12 * 60e3 + 9e3), "05:12:09");
  assert.strictEqual(app.fmtClock(59e3), "00:00:59");
  assert.strictEqual(app.fmtClock(-5), "00:00:00");
});
