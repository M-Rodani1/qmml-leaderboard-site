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
