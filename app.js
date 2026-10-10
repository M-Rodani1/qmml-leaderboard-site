const DATA_URL = "data/leaderboard.json";
const fmtScore = (n) => n.toFixed(5);
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "none");
const fmtShort = (s) => new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const fmtInt = (n) => n.toLocaleString("en-GB");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const percentile = (e, c) => Math.max(0, 100 * (1 - (e.kaggle_rank - 1) / c.total_teams));
// '2026-10-31' means the end of that day (UTC), matching the sync script
const parseDeadline = (s) => (s ? new Date(s.length === 10 ? s + "T23:59:00Z" : s) : null);
const FINAL_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
const TIE_EPS = 5e-7;

// Equal keys share a place (1, 1, 3). `tied` marks every member of a shared place.
function withPlaces(sorted, key) {
  return sorted.map((item, i) => {
    const first = sorted.findIndex((o) => key(o) === key(item));
    const same = sorted.filter((o) => key(o) === key(item)).length > 1;
    return { item, place: first + 1, tied: same };
  });
}
const placeLabel = (p) => p.place + (p.tied ? "=" : "");

function standings(data) {
  // In each competition with N society members, 1st place earns N points, 2nd N-1, down to 1.
  // Members with the same score share a place and the points for it.
  const by = new Map();
  for (const c of data.competitions) {
    const ranked = [...c.entries].sort((a, b) => a.kaggle_rank - b.kaggle_rank);
    for (const { item: e, place } of withPlaces(ranked, (x) => x.score)) {
      const row = by.get(e.member) || { member: e.member, points: 0, comps: 0, best: Infinity, pct: 0 };
      row.points += ranked.length - place + 1;
      row.comps += 1;
      row.best = Math.min(row.best, place);
      row.pct += percentile(e, c);
      by.set(e.member, row);
    }
  }
  // equal points share a place; Kaggle percentile only decides the order they are listed in
  const sorted = [...by.values()].sort((a, b) => b.points - a.points || b.pct - a.pct);
  return withPlaces(sorted, (r) => r.points);
}

// What each member needs: the score gap to the society member directly above them.
function gapText(sorted, i, higherIsBetter) {
  const diff = (a, b) => Math.abs(a.score - b.score);
  if (i === 0) {
    if (sorted.length < 2) return "Only member so far";
    const lead = diff(sorted[0], sorted[1]);
    return lead < TIE_EPS ? `Tied with ${sorted[1].member}` : `Leads by ${lead.toFixed(5)}`;
  }
  const above = sorted[i - 1];
  const gap = higherIsBetter ? above.score - sorted[i].score : sorted[i].score - above.score;
  return Math.abs(gap) < TIE_EPS ? `Tied with ${above.member}` : `${Math.abs(gap).toFixed(5)} behind ${above.member}`;
}

function fmtCountdown(ms) {
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const unit = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (d > 0) return `${unit(d, "day")} ${unit(h, "hour")}`;
  if (h > 0) return `${unit(h, "hour")} ${unit(m, "minute")}`;
  return unit(Math.max(m, 1), "minute");
}

function compStatus(c, now = Date.now()) {
  if (c.status) return c.status;
  const d = parseDeadline(c.deadline);
  return !d || now < d ? "open" : "closed";
}

function moveBadge(e, since) {
  if (e.new) return `<span class="move new" title="New since ${since ? fmtShort(since) : "the last snapshot"}">New</span>`;
  if (e.rank_change == null) return "";
  const when = since ? ` since ${fmtShort(since)}` : "";
  if (e.rank_change === 0) return `<span class="move same" title="No change in Kaggle rank${when}">–</span>`;
  const up = e.rank_change > 0, n = Math.abs(e.rank_change);
  return `<span class="move ${up ? "up" : "down"}" title="${up ? "Up" : "Down"} ${fmtInt(n)} Kaggle place${n === 1 ? "" : "s"}${when}">${up ? "▲" : "▼"} ${fmtInt(n)}</span>`;
}

// Daily score trend; better scores always sit higher, whichever way the metric runs.
function sparkline(points, higherIsBetter) {
  if (!points || points.length < 2) return `<span class="muted">–</span>`;
  const W = 84, H = 24, P = 4;
  const ys = points.map((p) => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const x = (i) => P + (i * (W - 2 * P)) / (points.length - 1);
  const y = (v) => {
    if (hi === lo) return H / 2;
    const t = (v - lo) / (hi - lo);
    return H - P - (higherIsBetter ? t : 1 - t) * (H - 2 * P);
  };
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const first = points[0], last = points[points.length - 1];
  const label = `Score ${fmtScore(first[1])} on ${fmtShort(first[0])}, ${fmtScore(last[1])} on ${fmtShort(last[0])}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}"><title>${label}</title>` +
    `<polyline points="${line}" fill="none"></polyline><circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="3"></circle></svg>`;
}

function podium(items) {
  const top = items.slice(0, 3);
  const order = [1, 0, 2].filter((i) => top[i]);
  const cls = top.length === 3 ? "" : top.length === 2 ? "two" : "one";
  return `<div class="podium ${cls}">` + order.map((i) => {
    const t = top[i];
    return `<div class="pl p${Math.min(t.place, 3)}"><b>${esc(t.name)}</b><small>${esc(t.sub)}${t.tied ? " · tied" : ""}</small>` +
      `<div class="big">${esc(t.big)}${t.badge || ""}</div><small>${esc(t.small)}</small>` +
      (t.gap ? `<small class="gap">${esc(t.gap)}</small>` : "") +
      `<div class="step">${t.place}</div></div>`;
  }).join("") + "</div>";
}

function renderOverall(data) {
  const all = standings(data);
  const items = all.map((p) => ({ place: p.place, tied: p.tied, name: p.item.member, sub: `${p.item.comps} competition${p.item.comps === 1 ? "" : "s"}`, big: String(p.item.points), small: p.item.points === 1 ? "point" : "points" }));
  const rows = all.slice(3).map((p) => `
    <tr>
      <td class="rank">${placeLabel(p)}</td>
      <td class="who">${esc(p.item.member)}</td>
      <td class="num">${p.item.comps}</td>
      <td class="num">${p.item.points}</td>
      <td class="num">${ordinal(p.item.best)}</td>
    </tr>`).join("");
  if (!all.length) return `<p class="empty">No society members on any leaderboard yet.</p>`;
  return podium(items) + (rows ? `<div class="table-wrap" tabindex="0"><table>
    <thead><tr><th>#</th><th>Member</th><th class="num">Comps</th><th class="num">Points</th><th class="num">Best finish</th></tr></thead>
    <tbody>${rows}</tbody></table></div>` : "");
}

function compInfo(c) {
  const status = compStatus(c);
  const deadline = parseDeadline(c.deadline);
  let when;
  if (status === "final") when = `<span class="chip final">Final results</span>`;
  else if (status === "closed") when = `<span class="chip closed">Closed · provisional</span><span>Final from <strong>${fmtShort(new Date(deadline.getTime() + FINAL_AFTER_MS))}</strong></span>`;
  else if (deadline) when = `<span>Closes in <strong data-deadline="${esc(c.deadline)}">${fmtCountdown(deadline - Date.now())}</strong> · ${fmtDate(deadline)}</span>`;
  else when = `<span>Ongoing</span>`;
  return `<p class="comp-info">
    ${when}
    <span>Metric <strong>${esc(c.metric)}</strong> (${c.higher_is_better ? "higher" : "lower"} is better)</span>
    <span>${fmtInt(c.total_teams)} teams</span>
    <a href="https://www.kaggle.com/competitions/${encodeURIComponent(c.slug)}/leaderboard" target="_blank" rel="noopener">View on Kaggle</a></p>`;
}

function renderComp(c) {
  const sorted = [...c.entries].sort((a, b) => a.kaggle_rank - b.kaggle_rank);
  const entries = withPlaces(sorted, (e) => e.score);
  const since = c.movement_since;
  const items = entries.map((p, i) => ({
    place: p.place, tied: p.tied, name: p.item.member, sub: p.item.team,
    big: "#" + fmtInt(p.item.kaggle_rank), badge: moveBadge(p.item, since),
    small: `${fmtScore(p.item.score)} · ${fmtDate(p.item.last_submission)}`,
    gap: gapText(sorted, i, c.higher_is_better),
  }));
  const rows = entries.slice(3).map((p, j) => { const e = p.item, i = j + 3; return `
    <tr>
      <td class="rank">${placeLabel(p)}</td>
      <td><span class="who">${esc(e.member)}</span><span class="team">${esc(e.team)}</span></td>
      <td class="num">${fmtInt(e.kaggle_rank)} / ${fmtInt(c.total_teams)}${moveBadge(e, since)}</td>
      <td class="num">${fmtScore(e.score)}</td>
      <td class="gap-cell">${esc(gapText(sorted, i, c.higher_is_better))}</td>
      <td>${sparkline(e.history, c.higher_is_better)}</td>
      <td class="num">${fmtDate(e.last_submission)}</td>
    </tr>`; }).join("");
  if (!entries.length) return compInfo(c) + `<p class="empty">No society members on this leaderboard yet.</p>`;
  return compInfo(c) + podium(items) + (rows ? `<div class="table-wrap" tabindex="0"><table>
        <thead><tr><th>#</th><th>Member</th><th class="num">Kaggle rank</th><th class="num">Score</th><th>Gap to next</th><th>Trend</th><th class="num">Last submission</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : "");
}

function tickCountdowns() {
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    el.textContent = fmtCountdown(parseDeadline(el.dataset.deadline) - Date.now());
  });
}

function show(data, key) {
  const panel = document.getElementById("panel");
  panel.innerHTML = key === "overall" ? renderOverall(data) : renderComp(data.competitions.find((c) => c.slug === key));
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.key === key)));
  try { localStorage.setItem("qmml-tab", key); } catch (_) {}
}

async function init() {
  let data;
  try {
    data = await (window.__DATA__ ? Promise.resolve(window.__DATA__) : fetch(DATA_URL, { cache: "no-cache" }).then((r) => r.json()));
  } catch (_) {
    document.getElementById("panel").innerHTML = '<p class="empty">Could not load the leaderboard. Try again shortly.</p>';
    return;
  }
  document.getElementById("notice").hidden = !data.sample;
  document.getElementById("meta").textContent = "Updated " + new Date(data.updated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  // newest competition first
  const comps = [...data.competitions].sort((a, b) => (parseDeadline(b.deadline) || 0) - (parseDeadline(a.deadline) || 0));
  const tabs = document.getElementById("tabs");
  const keys = [["overall", "Season standings"], ...comps.map((c) => [c.slug, c.title])];
  tabs.innerHTML = keys.map(([k, t]) => `<button class="tab" role="tab" data-key="${esc(k)}">${esc(t)}</button>`).join("");
  tabs.addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) show(data, b.dataset.key); });
  let start = "overall";
  try { const s = localStorage.getItem("qmml-tab"); if (keys.some(([k]) => k === s)) start = s; } catch (_) {}
  show(data, start);
  setInterval(tickCountdowns, 60000);
}

if (typeof module !== "undefined") module.exports = { withPlaces, standings, gapText, fmtCountdown, compStatus, sparkline, parseDeadline };
if (typeof document !== "undefined" && document.getElementById("panel")) init();
