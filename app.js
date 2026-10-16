const DATA_URL = "data/leaderboard.json";
const fmtScore = (n) => n.toFixed(5);
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "none");
const fmtShort = (s) => new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const fmtInt = (n) => n.toLocaleString("en-GB");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const percentile = (e, c) => Math.max(0, 100 * (1 - (e.kaggle_rank - 1) / c.total_teams));
// '2026-10-31' means the end of that day (UTC), matching the sync script
const parseDeadline = (s) => (s ? new Date(s.length === 10 ? s + "T23:59:00Z" : s) : null);
const byDeadline = (a, b) => (parseDeadline(a.deadline) || Infinity) - (parseDeadline(b.deadline) || Infinity);
const FINAL_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const motionOK = () => !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
const TIE_EPS = 5e-7;
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const memberSlug = (name) => "m-" + slugify(name);
const teamName = (name) => "qmml-" + (slugify(name) || "your-name");
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} },
};

// ---- ranking logic ----------------------------------------------------------

// Equal keys share a place (1, 1, 3). `tied` marks every member of a shared place.
function withPlaces(sorted, key) {
  return sorted.map((item, i) => {
    const first = sorted.findIndex((o) => key(o) === key(item));
    const same = sorted.filter((o) => key(o) === key(item)).length > 1;
    return { item, place: first + 1, tied: same };
  });
}
const placeLabel = (p) => p.place + (p.tied ? "=" : "");
const byRank = (entries) => [...entries].sort((a, b) => a.kaggle_rank - b.kaggle_rank);

function standings(data) {
  // In each competition with N society members, 1st place earns N points, 2nd N-1, down to 1.
  // Members with the same score share a place and the points for it.
  const by = new Map();
  for (const c of data.competitions) {
    const ranked = byRank(c.entries);
    for (const { item: e, place } of withPlaces(ranked, (x) => x.score)) {
      const row = by.get(e.member) || { member: e.member, points: 0, comps: 0, best: Infinity, pct: 0, byComp: {} };
      const points = ranked.length - place + 1;
      row.points += points;
      row.comps += 1;
      row.best = Math.min(row.best, place);
      row.pct += percentile(e, c);
      row.byComp[c.slug] = { points, place };
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

function compStatus(c, now = Date.now()) {
  if (c.status) return c.status;
  const d = parseDeadline(c.deadline);
  return !d || now < d ? "open" : "closed";
}

// "This month": the running competition closing soonest, else the most recent one.
function pickCurrent(comps, now = Date.now()) {
  const open = comps.filter((c) => compStatus(c, now) === "open").sort(byDeadline);
  return open[0] || [...comps].sort(byDeadline).pop() || null;
}

// ---- formatting -------------------------------------------------------------

function fmtCountdown(ms) {
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `${plural(d, "day")} ${plural(h, "hour")}`;
  if (h > 0) return `${plural(h, "hour")} ${plural(m, "minute")}`;
  return plural(Math.max(m, 1), "minute");
}

// The last day before a deadline counts down to the second: "05:12:09".
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, "0")).join(":");
}

function fmtAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${plural(h, "hour")} ago`;
  return `${plural(Math.floor(h / 24), "day")} ago`;
}

const compShort = (c) => {
  const d = parseDeadline(c.deadline);
  return d ? d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : c.title;
};
const statusWord = (c) => ({ open: "live", closed: "provisional", final: "final" })[compStatus(c)];

function moveBadge(e, since) {
  if (e.new) return `<span class="move new" title="New since ${since ? fmtShort(since) : "the last snapshot"}">New</span>`;
  if (e.rank_change == null) return "";
  const when = since ? ` since ${fmtShort(since)}` : "";
  if (e.rank_change === 0) return `<span class="move same" title="No change in Kaggle rank${when}">–</span>`;
  const up = e.rank_change > 0, n = Math.abs(e.rank_change);
  return `<span class="move ${up ? "up" : "down"}" title="${up ? "Up" : "Down"} ${plural(n, "Kaggle place")}${when}">${up ? "▲" : "▼"} ${fmtInt(n)}</span>`;
}

// Small daily trend; better values always sit higher, whichever way the measure runs.
function sparkline(points, higherIsBetter, fmt = fmtScore, noun = "Score") {
  if (!points || points.length < 2) return `<span class="muted">–</span>`;
  const W = 96, H = 28, P = 4;
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
  const label = `${noun} ${fmt(first[1])} on ${fmtShort(first[0])}, ${fmt(last[1])} on ${fmtShort(last[0])}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}"><title>${label}</title>` +
    `<polyline points="${line}" fill="none"></polyline><circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="3"></circle></svg>`;
}

// Clean axis ticks for Kaggle ranks (whole numbers, never 0).
function niceTicks(lo, hi, count = 4) {
  if (hi === lo) { lo = Math.max(1, lo - 1); hi += 1; }
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw));
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = start; v <= end; v += step) if (v > 0) ticks.push(v);
  return { lo: start, hi: end, ticks };
}

// ---- views ------------------------------------------------------------------

const nameBtn = (name) => `<button class="name-link" type="button" data-member="${esc(name)}">${esc(name)}</button>`;
const youBox = (html) => `<div class="you"><span class="you-tag">You</span><span class="you-text">${html}</span><button class="link" type="button" data-act="not-me">Not you?</button></div>`;
const youHint = () => `<p class="you-hint">Tip: click your name and choose “This is me” to follow your place.</p>`;

function podium(items) {
  const top = items.slice(0, 3);
  const order = [1, 0, 2].filter((i) => top[i]);
  const cls = top.length === 3 ? "" : top.length === 2 ? "two" : "one";
  return `<div class="podium ${cls}">` + order.map((i) => {
    const t = top[i];
    const big = /^#?[\d,]+$/.test(t.big)
      ? `<span class="count" data-to="${t.big.replace(/[#,]/g, "")}" data-prefix="${t.big.startsWith("#") ? "#" : ""}">${esc(t.big)}</span>`
      : esc(t.big);
    return `<div class="pl p${Math.min(t.place, 3)}${t.me ? " me" : ""}"><b>${nameBtn(t.name)}</b><small>${esc(t.sub)}${t.tied ? " · tied" : ""}</small>` +
      `<div class="big">${big}${t.badge || ""}</div><small>${esc(t.small)}</small>` +
      (t.gap ? `<small class="gap">${esc(t.gap)}</small>` : "") +
      `<div class="step">${t.place}</div></div>`;
  }).join("") + "</div>";
}

function renderSeason(data, me) {
  const all = standings(data);
  if (!all.length) return `<p class="empty">No society members on any leaderboard yet.</p>`;
  const comps = [...data.competitions].sort(byDeadline);
  const mine = all.find((p) => p.item.member === me);
  const you = !me ? youHint() : mine
    ? youBox(`<b>${ordinal(mine.place)}${mine.tied ? " (tied)" : ""}</b> in the season · ${plural(mine.item.points, "point")} · ${plural(mine.item.comps, "competition")}`)
    : youBox(`You aren't on a leaderboard yet. Name your Kaggle team <code>qmml-yourname</code> to join.`);
  const items = all.map((p) => ({ place: p.place, tied: p.tied, name: p.item.member, me: p.item.member === me,
    sub: plural(p.item.comps, "competition"), big: String(p.item.points), small: p.item.points === 1 ? "point" : "points" }));
  const head = comps.map((c) => `<th class="num" title="${esc(c.title)}">${esc(compShort(c))}</th>`).join("");
  const rows = all.map((p) => {
    const r = p.item;
    const cells = comps.map((c) => {
      const b = r.byComp[c.slug];
      return b ? `<td class="num">${b.points}<span class="sub-place">${ordinal(b.place)}</span></td>` : `<td class="num muted">–</td>`;
    }).join("");
    return `<tr class="${r.member === me ? "me" : ""}"><td class="rank">${placeLabel(p)}</td><td class="who">${nameBtn(r.member)}</td>${cells}<td class="num total">${r.points}</td><td class="num">${ordinal(r.best)}</td></tr>`;
  }).join("");
  return you + podium(items) +
    `<h3 class="section-title">Points by competition</h3><div class="table-wrap" tabindex="0"><table class="season">
    <thead><tr><th>#</th><th>Member</th>${head}<th class="num">Total</th><th class="num">Best</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function compInfo(c) {
  const status = compStatus(c);
  const deadline = parseDeadline(c.deadline);
  let when;
  if (status === "final") when = `<span class="chip final">Final results</span>`;
  else if (status === "closed") when = `<span class="chip closed">Closed · provisional</span><span>Final from <strong>${fmtShort(new Date(deadline.getTime() + FINAL_AFTER_MS))}</strong></span>`;
  else if (deadline) {
    const left = deadline - Date.now();
    when = `<span>Closes in <strong data-deadline="${esc(c.deadline)}">${left > 0 && left < DAY_MS ? fmtClock(left) : fmtCountdown(left)}</strong> · ${fmtDate(deadline)}</span>`;
  }
  else when = `<span>Ongoing</span>`;
  return `<p class="comp-info">
    ${when}
    <span>Metric <strong>${esc(c.metric)}</strong> (${c.higher_is_better ? "higher" : "lower"} is better)</span>
    <span>${fmtInt(c.total_teams)} teams</span>
    <a href="https://www.kaggle.com/competitions/${encodeURIComponent(c.slug)}/leaderboard" target="_blank" rel="noopener">View on Kaggle</a></p>`;
}

function joinCard(c) {
  if (compStatus(c) !== "open") return `<p class="empty">No society members took part in this competition.</p>`;
  return `<div class="join-card">
    <h3>No society members on this leaderboard yet</h3>
    <p>Be the first. It takes a couple of minutes:</p>
    <ol>
      <li>Join the competition on <a href="https://www.kaggle.com/competitions/${encodeURIComponent(c.slug)}" target="_blank" rel="noopener">Kaggle</a>.</li>
      <li><label for="join-name">Type your name</label> <input id="join-name" placeholder="Aisha Rahman" autocomplete="off"> to get your team name
        <span class="join-out"><code id="join-out">qmml-your-name</code> <button class="btn small" type="button" data-act="copy-team">Copy</button></span></li>
      <li>Rename your Kaggle team to it and make a submission. You'll appear here within the hour.</li>
    </ol></div>`;
}

function youComp(c, sorted, placed, me) {
  if (!me) return youHint();
  const i = sorted.findIndex((e) => e.member === me);
  if (i < 0) {
    return youBox(compStatus(c) === "open"
      ? `You're not on this leaderboard yet. Name your Kaggle team <code>qmml-yourname</code> to join.`
      : `You didn't take part in this competition.`);
  }
  const p = placed[i], e = sorted[i];
  return youBox(`<b>${ordinal(p.place)}${p.tied ? " (tied)" : ""}</b> of ${sorted.length} · Kaggle #${fmtInt(e.kaggle_rank)}${moveBadge(e, c.movement_since)} · ${esc(gapText(sorted, i, c.higher_is_better))}`);
}

function renderComp(c, me, width) {
  const head = `<div class="comp-head"><h2>${esc(c.title)}</h2>${compInfo(c)}</div>`;
  if (!c.entries.length) return head + joinCard(c);
  const sorted = byRank(c.entries);
  const placed = withPlaces(sorted, (e) => e.score);
  const since = c.movement_since;
  const items = placed.map((p, i) => ({
    place: p.place, tied: p.tied, name: p.item.member, sub: p.item.team, me: p.item.member === me,
    big: "#" + fmtInt(p.item.kaggle_rank), badge: moveBadge(p.item, since),
    small: `${fmtScore(p.item.score)} · ${fmtDate(p.item.last_submission)}`,
    gap: gapText(sorted, i, c.higher_is_better),
  }));
  const rows = placed.slice(3).map((p, j) => {
    const e = p.item, i = j + 3;
    const base = e.new ? 1e9 : e.rank_change != null ? e.kaggle_rank + e.rank_change : null; // yesterday's Kaggle rank
    return `
    <tr class="${e.member === me ? "me" : ""}"${base != null ? ` data-base="${base}"` : ""}>
      <td class="rank c-rank">${placeLabel(p)}</td>
      <td class="c-who">${nameBtn(e.member)}<span class="team">${esc(e.team)}</span></td>
      <td class="num c-krank">${fmtInt(e.kaggle_rank)} / ${fmtInt(c.total_teams)}${moveBadge(e, since)}</td>
      <td class="num c-score">${fmtScore(e.score)}</td>
      <td class="gap-cell c-gap">${esc(gapText(sorted, i, c.higher_is_better))}</td>
      <td class="c-trend">${sparkline((e.history || []).map((h) => [h[0], h[1]]), c.higher_is_better)}</td>
      <td class="num c-date"><span class="lbl">Last submission </span>${fmtDate(e.last_submission)}</td>
    </tr>`; }).join("");
  return head + youComp(c, sorted, placed, me) + podium(items) + (rows ? `<div class="table-wrap" tabindex="0"><table class="comp">
        <thead><tr><th>#</th><th>Member</th><th class="num">Kaggle rank</th><th class="num">Score</th><th>Gap to next</th><th>Trend</th><th class="num">Last submission</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : "") + raceChart(c, me, width);
}

// ---- race chart: everyone's Kaggle rank by day, one member emphasised -----------

const raceModels = new Map();

function raceChart(c, me, width = 640) {
  const series = c.entries
    .map((e) => ({ name: e.member, pts: (e.history || []).filter((h) => h[2] != null).map((h) => ({ d: h[0], r: h[2] })) }))
    .filter((s) => s.pts.length);
  const days = [...new Set(series.flatMap((s) => s.pts.map((p) => p.d)))].sort();
  if (days.length < 2) return "";
  const focus = series.some((s) => s.name === me) ? me : byRank(c.entries)[0].member;
  const narrow = width < 480;
  const W = Math.max(300, Math.round(width)), H = narrow ? 240 : 300;
  const M = { l: 62, r: narrow ? 16 : 150, t: narrow ? 30 : 16, b: 32 };
  const ranks = series.flatMap((s) => s.pts.map((p) => p.r));
  const { lo, hi, ticks } = niceTicks(Math.min(...ranks), Math.max(...ranks));
  const x = (i) => M.l + (i * (W - M.l - M.r)) / (days.length - 1);
  const y = (r) => M.t + ((r - lo) / (hi - lo)) * (H - M.t - M.b); // best rank at the top
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const path = (s) => s.pts.map((p, k) => `${k ? "L" : "M"}${x(dayIndex.get(p.d)).toFixed(1)},${y(p.r).toFixed(1)}`).join("");
  const grid = ticks.map((t) => `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"></line>` +
    `<text class="tick" x="${M.l - 8}" y="${y(t).toFixed(1)}" dy="0.32em" text-anchor="end">#${fmtInt(t)}</text>`).join("");
  const xIdx = days.length > 4 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : [0, days.length - 1];
  const xLabels = xIdx.map((i) => `<text class="tick" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="${i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}">${fmtShort(days[i])}</text>`).join("");
  const others = series.filter((s) => s.name !== focus)
    .map((s, k) => `<path class="line other" pathLength="1" style="--k:${k}" d="${path(s)}"></path>`).join("");
  const f = series.find((s) => s.name === focus);
  const end = f.pts[f.pts.length - 1];
  const ex = x(dayIndex.get(end.d)), ey = y(end.r);
  const label = `${esc(focus)} #${fmtInt(end.r)}`;
  const endLabel = narrow
    ? `<text class="end-label" x="${ex.toFixed(1)}" y="${(ey - 14).toFixed(1)}" text-anchor="end">${label}</text>`
    : `<text class="end-label" x="${(ex + 10).toFixed(1)}" y="${ey.toFixed(1)}" dy="0.32em">${label}</text>`;
  const id = "race-" + slugify(c.slug);
  raceModels.set(id, { days, series, x, W, M, focus });
  const who = focus === me ? `You (${focus})` : `Society leader (${focus})`;
  return `<section class="race">
    <div class="race-head"><h3 class="section-title">Kaggle rank by day</h3>
      <p class="race-legend"><span><i class="key focus"></i>${esc(who)}</span><span><i class="key other"></i>Other members</span><span class="muted">Higher is better</span></p></div>
    <div class="race-chart" id="${id}" tabindex="0" aria-label="Kaggle rank by day for every society member. Use the left and right arrow keys to step through days.">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Kaggle rank by day. ${esc(who)} is highlighted.">
        ${grid}${xLabels}${others}
        <path class="line focus" pathLength="1" d="${path(f)}"></path>
        <circle class="end" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4"></circle>${endLabel}
        <line class="cross" x1="0" x2="0" y1="${M.t}" y2="${H - M.b}" visibility="hidden"></line>
        <rect class="hit" x="${M.l}" y="0" width="${W - M.l - M.r}" height="${H}" fill="transparent"></rect>
      </svg>
      <div class="tip" hidden></div>
    </div></section>`;
}

function wireRace(root) {
  root.querySelectorAll(".race-chart").forEach((el) => {
    const m = raceModels.get(el.id);
    if (!m) return;
    const svg = el.querySelector("svg"), cross = svg.querySelector(".cross"), tip = el.querySelector(".tip");
    let idx = m.days.length - 1;
    const show = (i) => {
      idx = Math.max(0, Math.min(m.days.length - 1, i));
      const day = m.days[idx], cx = m.x(idx);
      cross.setAttribute("x1", cx);
      cross.setAttribute("x2", cx);
      cross.setAttribute("visibility", "visible");
      const rows = m.series.map((s) => ({ name: s.name, p: s.pts.find((p) => p.d === day) }))
        .filter((r) => r.p).sort((a, b) => a.p.r - b.p.r);
      // names come from Kaggle team names: build with textContent, never innerHTML
      tip.replaceChildren();
      const h = document.createElement("div");
      h.className = "tip-day";
      h.textContent = fmtShort(day);
      tip.append(h);
      for (const r of rows) {
        const row = document.createElement("div");
        row.className = "tip-row" + (r.name === m.focus ? " is-focus" : "");
        const key = document.createElement("i");
        key.className = "key " + (r.name === m.focus ? "focus" : "other");
        const v = document.createElement("b");
        v.textContent = "#" + fmtInt(r.p.r);
        const n = document.createElement("span");
        n.textContent = r.name;
        row.append(key, v, n);
        tip.append(row);
      }
      tip.hidden = false;
      const scale = svg.getBoundingClientRect().width / m.W, left = cx * scale;
      tip.style.left = Math.max(0, left > el.clientWidth / 2 ? left - tip.offsetWidth - 12 : left + 12) + "px";
    };
    const hide = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
    svg.addEventListener("pointermove", (ev) => {
      const box = svg.getBoundingClientRect();
      const vx = ((ev.clientX - box.left) / box.width) * m.W;
      show(Math.round(((vx - m.M.l) / (m.W - m.M.l - m.M.r)) * (m.days.length - 1)));
    });
    svg.addEventListener("pointerleave", hide);
    el.addEventListener("focus", () => show(idx));
    el.addEventListener("blur", hide);
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { ev.preventDefault(); show(idx + (ev.key === "ArrowRight" ? 1 : -1)); }
      else if (ev.key === "Escape") hide();
    });
  });
}

// ---- member page ------------------------------------------------------------

function memberView(data, name, me) {
  const season = standings(data).find((p) => p.item.member === name);
  const comps = [...data.competitions].sort(byDeadline).reverse().map((c) => {
    const sorted = byRank(c.entries);
    const i = sorted.findIndex((e) => e.member === name);
    if (i < 0) return "";
    const p = withPlaces(sorted, (e) => e.score)[i], e = sorted[i];
    const points = sorted.length - p.place + 1;
    const ranks = (e.history || []).filter((h) => h[2] != null).map((h) => [h[0], h[2]]);
    return `<li class="m-comp">
      <div><b>${esc(c.title)}</b><small>${esc(compShort(c))} · ${statusWord(c)} · team ${esc(e.team)}</small></div>
      <div class="m-stats"><span><b>${ordinal(p.place)}${p.tied ? "=" : ""}</b> of ${sorted.length}</span>
        <span>Kaggle <b>#${fmtInt(e.kaggle_rank)}</b> / ${fmtInt(c.total_teams)}${moveBadge(e, c.movement_since)}</span>
        <span>Score <b>${fmtScore(e.score)}</b></span><span><b>${points}</b> ${points === 1 ? "point" : "points"}</span></div>
      <div class="m-trend"><span class="muted">Kaggle rank by day</span>${sparkline(ranks, false, (v) => "#" + fmtInt(v), "Kaggle rank")}</div>
    </li>`;
  }).join("");
  const url = location.href.split("#")[0] + "#" + memberSlug(name);
  return `<div class="m-head"><h2 id="member-name">${esc(name)}</h2><button class="close" type="button" data-act="close" aria-label="Close">×</button></div>
    <p class="m-sub">${season ? `${ordinal(season.place)}${season.tied ? " (tied)" : ""} in the season · ${plural(season.item.points, "point")} · ${plural(season.item.comps, "competition")}` : ""}</p>
    <div class="m-me">${name === me
      ? `<span class="chip you-chip">This is you</span><button class="link" type="button" data-act="not-me">Not you?</button>`
      : `<button class="btn" type="button" data-act="me" data-member="${esc(name)}">This is me</button>`}</div>
    <h3 class="section-title">Competitions</h3><ul class="m-comps">${comps}</ul>
    <h3 class="section-title">Share</h3>
    <div class="share"><label class="visually-hidden" for="share-url">Link to this page</label><input id="share-url" readonly value="${esc(url)}"><button class="btn small" type="button" data-act="copy-link">Copy link</button></div>`;
}

// ---- animation ----------------------------------------------------------------
// Intro effects play when a view opens; all of them respect "reduce motion".

function countUp(root) {
  root.querySelectorAll(".count").forEach((el) => {
    const to = Number(el.dataset.to), prefix = el.dataset.prefix || "";
    const pl = el.closest(".pl");
    const delay = 450 + (pl && pl.classList.contains("p1") ? 400 : pl && pl.classList.contains("p2") ? 200 : 0);
    const dur = 900, start = performance.now() + delay;
    el.textContent = prefix + "0";
    const frame = (now) => {
      const k = Math.min(1, Math.max(0, (now - start) / dur));
      el.textContent = prefix + fmtInt(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

// Table rows start in yesterday's order, then slide to today's.
function replayMoves(root) {
  const rows = [...root.querySelectorAll("table.comp tbody tr")];
  if (rows.length < 2 || rows.some((r) => r.dataset.base == null)) return;
  const yesterday = [...rows].sort((a, b) => Number(a.dataset.base) - Number(b.dataset.base));
  if (yesterday.every((r, i) => r === rows[i])) return;
  const tops = rows.map((r) => r.getBoundingClientRect().top);
  yesterday.forEach((r, yi) => {
    const dy = tops[yi] - tops[rows.indexOf(r)];
    if (dy) r.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
      { duration: 900, delay: 900, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
  });
}

function confetti(originEl) {
  if (!motionOK()) return;
  const cv = document.createElement("canvas");
  cv.className = "confetti";
  cv.setAttribute("aria-hidden", "true");
  document.body.append(cv);
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = innerWidth, H = innerHeight;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const colors = ["--gold", "--silver", "--bronze", "--accent"].map((v) => css.getPropertyValue(v).trim());
  const box = originEl ? originEl.getBoundingClientRect() : { left: W / 2, top: H / 3, width: 0 };
  const ox = box.left + box.width / 2, oy = Math.max(40, box.top);
  const bits = Array.from({ length: 150 }, () => ({
    x: ox, y: oy, vx: (Math.random() - 0.5) * 11, vy: -(Math.random() * 10 + 5),
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
    w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now(), LIFE = 2800;
  const frame = (now) => {
    const age = now - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.max(0, 1 - age / LIFE);
    for (const b of bits) {
      b.vy += 0.28; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
    }
    if (age < LIFE) requestAnimationFrame(frame); else cv.remove();
  };
  requestAnimationFrame(frame);
}

// Celebrate final results, or you holding 1st place, once per view per visit.
const cheered = new Set();
function placeOfMe() {
  if (!state.me) return null;
  if (state.view === "season") {
    const p = standings(state.data).find((x) => x.item.member === state.me);
    return p ? p.place : null;
  }
  const c = state.data.competitions.find((x) => x.slug === state.view);
  const sorted = c ? byRank(c.entries) : [];
  const i = sorted.findIndex((e) => e.member === state.me);
  return i < 0 ? null : withPlaces(sorted, (e) => e.score)[i].place;
}
function maybeCelebrate(delay) {
  const c = state.data.competitions.find((x) => x.slug === state.view);
  const reason = placeOfMe() === 1 ? "me" : c && compStatus(c) === "final" && c.entries.length ? "final" : null;
  if (!reason || cheered.has(state.view + reason)) return;
  cheered.add(state.view + reason);
  setTimeout(() => confetti(document.querySelector("#panel .pl.p1")), delay);
}

// A faint drifting network behind the header, echoing the society logo.
function startNetwork() {
  const head = document.querySelector(".head");
  if (!head) return;
  const cv = document.createElement("canvas");
  cv.className = "net";
  cv.setAttribute("aria-hidden", "true");
  head.prepend(cv);
  const ctx = cv.getContext("2d");
  let W = 0, H = 0, nodes = [], color = "#6ccff0", pointer = null, visible = true, frameNo = 0;
  const readColor = () => { color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || color; };
  const size = () => {
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(70, (W * H) / 9000));
    nodes = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3 }));
  };
  const LINK = 110, REACH = 160;
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < LINK) { ctx.globalAlpha = (1 - d / LINK) * 0.28; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      }
      if (pointer) {
        const d = Math.hypot(a.x - pointer.x, a.y - pointer.y);
        if (d < REACH) { ctx.globalAlpha = (1 - d / REACH) * 0.55; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(pointer.x, pointer.y); ctx.stroke(); }
      }
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.arc(a.x, a.y, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  const tick = () => {
    if (!visible || document.hidden) return;
    if (++frameNo % 90 === 0) readColor();
    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > W) n.vx *= -1;
      if (n.y < 0 || n.y > H) n.vy *= -1;
    }
    draw();
    requestAnimationFrame(tick);
  };
  readColor();
  size();
  draw();
  if (!motionOK()) return; // one still frame
  head.addEventListener("pointermove", (e) => { const r = cv.getBoundingClientRect(); pointer = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  head.addEventListener("pointerleave", () => { pointer = null; });
  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { size(); draw(); }, 200); });
  document.getElementById("theme").addEventListener("click", () => requestAnimationFrame(readColor));
  const resume = () => { if (visible && !document.hidden) requestAnimationFrame(tick); };
  document.addEventListener("visibilitychange", resume);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([en]) => { const was = visible; visible = en.isIntersecting; if (!was && visible) resume(); }).observe(head);
  }
  requestAnimationFrame(tick);
}

// Flip-clock digits: each changed digit flips in.
function setClock(el, text) {
  if (!el.classList.contains("clock")) { el.textContent = ""; el.classList.add("clock"); }
  [...text].forEach((ch, i) => {
    let d = el.children[i];
    if (!d) { d = document.createElement("span"); el.append(d); }
    if (d.textContent === ch) return;
    d.textContent = ch;
    if (ch !== ":" && motionOK()) { d.classList.remove("flip"); void d.offsetWidth; d.classList.add("flip"); }
  });
}

function tickCountdowns() {
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    const left = parseDeadline(el.dataset.deadline) - Date.now();
    if (left > 0 && left < DAY_MS) { setClock(el, fmtClock(left)); return; }
    const text = fmtCountdown(left);
    if (el.classList.contains("clock") || el.textContent !== text) { el.classList.remove("clock"); el.textContent = text; }
  });
}

// ---- page state, routing and events -------------------------------------------

const state = { data: null, view: "season", me: null, current: null, past: [], width: 0, rendered: null };
const isView = (k) => k === "season" || (state.data && state.data.competitions.some((c) => c.slug === k));
const members = () => [...new Set(state.data.competitions.flatMap((c) => c.entries.map((e) => e.member)))];

function renderTabs() {
  const cur = state.current;
  const defs = [["season", "Season standings"]];
  if (cur) defs.push([cur.slug, compStatus(cur) === "open" ? "This month" : "Latest"]);
  const tabs = document.getElementById("tabs");
  tabs.innerHTML = defs.map(([k, label]) => {
    const sel = state.view === k;
    const live = cur && k === cur.slug && compStatus(cur) === "open" ? `<span class="live-dot" aria-hidden="true"></span>` : "";
    return `<button class="tab" role="tab" id="tab-${esc(k)}" type="button" data-key="${esc(k)}" aria-selected="${sel}" aria-controls="panel" tabindex="${sel ? 0 : -1}">${esc(label)}${live}</button>`;
  }).join("");
  if (!defs.some(([k]) => k === state.view)) tabs.querySelector(".tab").tabIndex = 0;
  const past = document.getElementById("past");
  document.getElementById("past-wrap").hidden = !state.past.length;
  past.innerHTML = `<option value="">Past competitions</option>` + state.past.map((c) =>
    `<option value="${esc(c.slug)}"${c.slug === state.view ? " selected" : ""}>${esc(compShort(c))} · ${esc(c.title)}</option>`).join("");
  past.classList.toggle("active", state.past.some((c) => c.slug === state.view));
}

function render(animate = false) {
  // re-rendering replaces the tab buttons, so carry keyboard focus over to the new selected tab
  const tabFocused = document.activeElement && document.activeElement.classList.contains("tab");
  renderTabs();
  if (tabFocused) document.getElementById("tab-" + state.view)?.focus();
  const panel = document.getElementById("panel");
  state.width = panel.clientWidth;
  const comp = state.view === "season" ? null : state.data.competitions.find((c) => c.slug === state.view);
  const play = animate && motionOK();
  panel.classList.toggle("animate", play);
  panel.innerHTML = comp ? renderComp(comp, state.me, state.width) : renderSeason(state.data, state.me);
  const tab = document.getElementById("tab-" + state.view);
  if (tab) panel.setAttribute("aria-labelledby", tab.id); else panel.removeAttribute("aria-labelledby");
  wireRace(panel);
  tickTimes();
  tickCountdowns();
  if (play) { countUp(panel); replayMoves(panel); }
  if (animate) maybeCelebrate(play ? 1300 : 0);
  state.rendered = state.view;
  store.set("qmml-tab", state.view);
}

function openMember(name) {
  const dlg = document.getElementById("member");
  document.getElementById("member-body").innerHTML = memberView(state.data, name, state.me);
  dlg.dataset.member = name;
  if (!dlg.open) dlg.showModal();
}

function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  const dlg = document.getElementById("member");
  if (h.startsWith("m-")) {
    const name = members().find((n) => memberSlug(n) === h);
    if (name) { if (state.rendered !== state.view) render(true); openMember(name); return; }
  }
  if (isView(h)) state.view = h;
  if (dlg.open) dlg.close();
  render(state.rendered !== state.view); // animate only when the view changes
}

function setMe(name) {
  state.me = name;
  store.set("qmml-me", name);
  render();
  const dlg = document.getElementById("member");
  if (dlg.open) openMember(dlg.dataset.member);
  if (name && placeOfMe() === 1) maybeCelebrate(250);
}

async function copyText(text, btn, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch (_) {
    if (fallbackEl.select) fallbackEl.select();
    else { const r = document.createRange(); r.selectNodeContents(fallbackEl); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    btn.textContent = "Press Ctrl/Cmd+C";
  }
}

function tickTimes() {
  if (!state.data) return;
  const meta = document.getElementById("meta");
  const t = new Date(state.data.updated_at), age = Date.now() - t;
  meta.textContent = "Updated " + fmtAgo(age) + (age > STALE_MS ? " · may be out of date" : "");
  meta.title = t.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  meta.classList.toggle("stale", age > STALE_MS);
}

const THEMES = ["system", "light", "dark"];
function setTheme(mode, apply = true) {
  const root = document.documentElement;
  if (apply) {
    if (mode === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", mode);
    store.set("qmml-theme", mode === "system" ? null : mode);
  }
  document.getElementById("theme").textContent = "Theme: " + mode[0].toUpperCase() + mode.slice(1);
}

function wire() {
  const tabs = document.getElementById("tabs");
  tabs.addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) location.hash = b.dataset.key; });
  tabs.addEventListener("keydown", (e) => {
    const list = [...tabs.querySelectorAll(".tab")];
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    location.hash = list[(next + list.length) % list.length].dataset.key;
  });
  document.getElementById("past").addEventListener("change", (e) => { if (e.target.value) location.hash = e.target.value; });

  const panel = document.getElementById("panel");
  panel.addEventListener("click", (e) => {
    const name = e.target.closest(".name-link");
    if (name) { location.hash = memberSlug(name.dataset.member); return; }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "not-me") setMe(null);
    if (act.dataset.act === "copy-team") copyText(document.getElementById("join-out").textContent, act, document.getElementById("join-out"));
  });
  panel.addEventListener("input", (e) => {
    if (e.target.id === "join-name") document.getElementById("join-out").textContent = teamName(e.target.value);
  });

  const dlg = document.getElementById("member");
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) { dlg.close(); return; } // backdrop
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "close") dlg.close();
    if (act.dataset.act === "me") setMe(act.dataset.member);
    if (act.dataset.act === "not-me") setMe(null);
    if (act.dataset.act === "copy-link") copyText(document.getElementById("share-url").value, act, document.getElementById("share-url"));
  });
  dlg.addEventListener("close", () => {
    if (location.hash.startsWith("#m-")) history.replaceState(null, "", "#" + state.view);
  });

  document.getElementById("theme").addEventListener("click", () => {
    const now = store.get("qmml-theme") || "system";
    setTheme(THEMES[(THEMES.indexOf(now) + 1) % THEMES.length]);
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.abs(document.getElementById("panel").clientWidth - state.width) > 40) render();
    }, 150);
  });
  window.addEventListener("hashchange", route);
  setInterval(tickTimes, 60000);
  setInterval(tickCountdowns, 1000);
}

async function init() {
  setTheme(store.get("qmml-theme") || "system", false);
  let data;
  try {
    data = await (window.__DATA__ ? Promise.resolve(window.__DATA__) : fetch(DATA_URL, { cache: "no-cache" }).then((r) => r.json()));
  } catch (_) {
    document.getElementById("panel").innerHTML = '<p class="empty">Could not load the leaderboard. Try again shortly.</p>';
    return;
  }
  state.data = data;
  state.me = store.get("qmml-me");
  state.current = pickCurrent(data.competitions);
  state.past = data.competitions.filter((c) => c !== state.current).sort(byDeadline).reverse();
  document.getElementById("notice").hidden = !data.sample;
  const h = decodeURIComponent(location.hash.slice(1)), saved = store.get("qmml-tab");
  state.view = isView(h) ? h : isView(saved) ? saved : "season";
  wire();
  route();
  startNetwork();
}

if (typeof module !== "undefined") {
  module.exports = { withPlaces, standings, gapText, fmtCountdown, fmtClock, fmtAgo, compStatus, pickCurrent, sparkline,
    parseDeadline, niceTicks, memberSlug, teamName, raceChart };
}
if (typeof document !== "undefined" && document.getElementById("panel")) init();
