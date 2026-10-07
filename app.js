const DATA_URL = "data/leaderboard.json";
const fmtScore = (n) => n.toFixed(5);
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "none");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const percentile = (e, c) => Math.max(0, 100 * (1 - (e.kaggle_rank - 1) / c.total_teams));

function standings(data) {
  // In each competition with N society members, 1st place earns N points, 2nd N-1, down to 1.
  const by = new Map();
  for (const c of data.competitions) {
    const ranked = [...c.entries].sort((a, b) => a.kaggle_rank - b.kaggle_rank);
    ranked.forEach((e, i) => {
      const row = by.get(e.member) || { member: e.member, points: 0, comps: 0, best: Infinity, tie: 0 };
      row.points += ranked.length - i;
      row.comps += 1;
      row.best = Math.min(row.best, i + 1);
      row.tie += percentile(e, c);
      by.set(e.member, row);
    });
  }
  // equal points are split by combined Kaggle percentile
  return [...by.values()].sort((a, b) => b.points - a.points || b.tie - a.tie);
}

function podium(items) {
  const top = items.slice(0, 3);
  const order = [1, 0, 2].filter((i) => top[i]);
  const cls = top.length === 3 ? "" : top.length === 2 ? "two" : "one";
  return `<div class="podium ${cls}">` + order.map((i) => {
    const t = top[i];
    return `<div class="pl p${i + 1}"><b>${esc(t.name)}</b><small>${esc(t.sub)}</small><div class="big">${esc(t.big)}</div><small>${esc(t.small)}</small><div class="step">${i + 1}</div></div>`;
  }).join("") + "</div>";
}

function renderOverall(data) {
  const all = standings(data);
  const items = all.map((r) => ({ name: r.member, sub: `${r.comps} competition${r.comps === 1 ? "" : "s"}`, big: String(r.points), small: r.points === 1 ? "point" : "points" }));
  const rows = all.slice(3).map((r, i) => `
    <tr>
      <td class="rank">${i + 4}</td>
      <td class="who">${esc(r.member)}</td>
      <td class="num">${r.comps}</td>
      <td class="num">${r.points}</td>
      <td class="num">${ordinal(r.best)}</td>
    </tr>`).join("");
  if (!all.length) return `<p class="empty">No society members on any leaderboard yet.</p>`;
  return podium(items) + (rows ? `<div class="table-wrap" tabindex="0"><table>
    <thead><tr><th>#</th><th>Member</th><th class="num">Comps</th><th class="num">Points</th><th class="num">Best finish</th></tr></thead>
    <tbody>${rows}</tbody></table></div>` : "");
}

function renderComp(c) {
  const entries = [...c.entries].sort((a, b) => a.kaggle_rank - b.kaggle_rank);
  const items = entries.map((e) => ({ name: e.member, sub: e.team, big: "#" + e.kaggle_rank.toLocaleString("en-GB"), small: `${fmtScore(e.score)} · ${fmtDate(e.last_submission)}` }));
  const rows = entries.slice(3).map((e, i) => `
    <tr>
      <td class="rank">${i + 4}</td>
      <td><span class="who">${esc(e.member)}</span><span class="team">${esc(e.team)}</span></td>
      <td class="num">${e.kaggle_rank.toLocaleString("en-GB")} / ${c.total_teams.toLocaleString("en-GB")}</td>
      <td class="num">${fmtScore(e.score)}</td>
      <td class="num">${fmtDate(e.last_submission)}</td>
      <td class="pct"><div class="bar"><i style="width:${percentile(e, c).toFixed(1)}%"></i></div></td>
    </tr>`).join("");
  const info = `<p class="comp-info">
    <span>Metric <strong>${esc(c.metric)}</strong> (${c.higher_is_better ? "higher" : "lower"} is better)</span>
    <span>Closes <strong>${fmtDate(c.deadline) === "none" ? "ongoing" : fmtDate(c.deadline)}</strong></span>
    <span>${c.total_teams.toLocaleString("en-GB")} teams</span>
    <a href="https://www.kaggle.com/competitions/${encodeURIComponent(c.slug)}/leaderboard" target="_blank" rel="noopener">View on Kaggle</a></p>`;
  if (!entries.length) return info + `<p class="empty">No society members on this leaderboard yet.</p>`;
  return info + podium(items) + (rows ? `<div class="table-wrap" tabindex="0"><table>
        <thead><tr><th>#</th><th>Member</th><th class="num">Kaggle rank</th><th class="num">Score</th><th class="num">Last submission</th><th>Percentile</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : "");
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
    data = await (window.__DATA__ ? Promise.resolve(window.__DATA__) : fetch(DATA_URL).then((r) => r.json()));
  } catch (_) {
    document.getElementById("panel").innerHTML = '<p class="empty">Could not load the leaderboard. Try again shortly.</p>';
    return;
  }
  document.getElementById("notice").hidden = !data.sample;
  document.getElementById("meta").textContent = "Updated " + new Date(data.updated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const tabs = document.getElementById("tabs");
  const keys = [["overall", "Season standings"], ...data.competitions.map((c) => [c.slug, c.title])];
  tabs.innerHTML = keys.map(([k, t]) => `<button class="tab" role="tab" data-key="${esc(k)}">${esc(t)}</button>`).join("");
  tabs.addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) show(data, b.dataset.key); });
  let start = "overall";
  try { const s = localStorage.getItem("qmml-tab"); if (keys.some(([k]) => k === s)) start = s; } catch (_) {}
  show(data, start);
}
init();
