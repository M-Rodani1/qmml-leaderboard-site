#!/usr/bin/env python3
"""Download Kaggle leaderboards, keep society members, write data/leaderboard.json.

Usage:
  python scripts/sync.py                       # live, needs KAGGLE_API_TOKEN
  python scripts/sync.py --from-csv DIR        # offline, reads DIR/<slug>.csv (testing)

Next to the output file it also keeps:
  history/<slug>.json   one snapshot per day, for movement arrows and score trends
  final/<slug>.json     frozen final results once a competition has closed
Set DISCORD_WEBHOOK_URL to post new members, leader changes and final podiums.
"""
import argparse, csv, io, json, os, re, sys, tempfile, urllib.request, zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PREFIX_RE = re.compile(r"^qmml\s*-\s*(?=\S)", re.I)  # "qmml-x" or "QMML - x" belongs to the society
PLAYGROUND_RE = re.compile(r"^playground-series-s\d+e\d+$")
FINAL_AFTER = timedelta(days=2)  # time for Kaggle to settle the private leaderboard
HISTORY_DAYS = 31
LOWER_IS_BETTER = ("error", "loss", "rmse", "rmsle", "mae", "mse", "mape", "smape", "deviance")
ACRONYMS = {"roc", "auc", "rmse", "rmsle", "mae", "mse", "mape", "smape", "map", "f1", "r2", "qwk", "mcc"}
MEDALS = ["🥇", "🥈", "🥉"]


def norm(s):
    return re.sub(r"\s+", " ", str(s)).strip().lower()


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return default


def write_if_changed(path, obj):
    text = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return True


def load_csv_text(text):
    return list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))


# --- competitions ---------------------------------------------------------

def parse_deadline(s):
    """'2026-10-31' means the end of that day (UTC); full timestamps are UTC."""
    if not s:
        return None
    if len(s) == 10:
        return datetime.fromisoformat(s).replace(hour=23, minute=59, tzinfo=timezone.utc)
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def status_for(deadline, now):
    """open: before the deadline; closed: provisional final results; final: frozen."""
    if deadline is None or now < deadline:
        return "open"
    return "closed" if now < deadline + FINAL_AFTER else "final"


def pretty_metric(name):
    """'Roc Auc Score' -> 'ROC AUC'."""
    words = re.sub(r"\s+score$", "", name.strip(), flags=re.I).split()
    return " ".join(w.upper() if w.lower() in ACRONYMS else w.capitalize() for w in words) or name


def guess_higher_is_better(metric):
    """Only a first guess for a new competition; infer_direction corrects it from real ranks."""
    m = metric.lower()
    return not any(k in m for k in LOWER_IS_BETTER)


def discover(api, comps, now):
    """Running Playground Series competitions that are not in competitions.json yet."""
    known = {c["slug"] for c in comps}
    found = []
    resp = api.competitions_list(search="playground-series", sort_by="recentlyCreated")
    for c in getattr(resp, "competitions", None) or []:
        slug = c.ref.rstrip("/").rsplit("/", 1)[-1]
        deadline = c.deadline
        if deadline is not None and deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        if not PLAYGROUND_RE.match(slug) or slug in known or deadline is None or deadline <= now:
            continue
        metric = pretty_metric(c.evaluation_metric or "Score")
        found.append({
            "slug": slug,
            "title": c.title,
            "metric": metric,
            "higher_is_better": guess_higher_is_better(metric),
            "deadline": iso(deadline),
        })
    return found


# --- fetching -------------------------------------------------------------

def fetch_public(api, slug):
    """The full public leaderboard as one CSV download."""
    with tempfile.TemporaryDirectory() as tmp:
        api.competition_leaderboard_download(slug, tmp)
        zips = list(Path(tmp).glob("*.zip"))
        if not zips:
            raise RuntimeError(f"no leaderboard zip downloaded for {slug}")
        with zipfile.ZipFile(zips[0]) as z:
            names = [n for n in z.namelist() if n.endswith(".csv")]
            pick = next((n for n in names if "public" in n.lower()), names[0])
            return load_csv_text(z.read(pick).decode("utf-8"))


def fetch_final(api, slug, max_pages=500):
    """The leaderboard as Kaggle shows it. After the deadline this is the private
    (final) one, which the CSV download does not offer. Paged 200 teams at a time."""
    from kagglesdk.competitions.types.competition_api_service import ApiGetLeaderboardRequest
    rows, token = [], None
    for _ in range(max_pages):
        with api.build_kaggle_client() as kaggle:
            req = ApiGetLeaderboardRequest()
            req.competition_name = slug
            req.page_size = 200
            if token:
                req.page_token = token
            resp = kaggle.competitions.competition_api_client.get_leaderboard(req)
        for s in resp.submissions or []:
            rows.append({
                "Rank": str(len(rows) + 1),
                "TeamId": str(s.team_id),
                "TeamName": s.team_name or "",
                "LastSubmissionDate": s.submission_date.strftime("%Y-%m-%d %H:%M:%S") if s.submission_date else "",
                "Score": s.score,
            })
        token = resp.next_page_token
        if not token:
            return rows
    raise RuntimeError(f"{slug}: leaderboard longer than {max_pages} pages")


# --- building a board -----------------------------------------------------

def display_name(team_name):
    """'qmml-aisha-rahman' -> 'Aisha Rahman'; mixed case like 'qmml-MoRo' is kept as written."""
    rest = PREFIX_RE.sub("", team_name.strip())
    rest = re.sub(r"[-_\s]+", " ", rest).strip()
    return rest.title() if rest == rest.lower() else rest


def infer_direction(rows):
    """True if Kaggle ranks higher scores first, False if lower, None if it can't tell."""
    ranked = []
    for r in rows:
        try:
            ranked.append((int(r["Rank"]), float(r["Score"])))
        except (KeyError, TypeError, ValueError):
            continue
    if len(ranked) < 2:
        return None
    ranked.sort()
    top, bottom = ranked[0][1], ranked[-1][1]
    return None if top == bottom else top > bottom


def rank_rows(rows, higher_is_better):
    """Competition ranking (ties share the best rank) from the score column."""
    scored = []
    for r in rows:
        try:
            scored.append((float(r["Score"]), r))
        except (KeyError, TypeError, ValueError):
            continue
    if scored and all(str(r.get("Rank", "")).isdigit() for _, r in scored):
        # Kaggle's export carries the official rank (it breaks ties on unrounded scores)
        return sorted(((int(r["Rank"]), score, r) for score, r in scored), key=lambda t: t[0])
    scored.sort(key=lambda t: t[0], reverse=higher_is_better)
    out, prev, rank = [], None, 0
    for i, (score, r) in enumerate(scored, 1):
        if score != prev:
            rank, prev = i, score
        out.append((rank, score, r))
    return out


def build_competition(comp, rows, roster):
    by_id = {str(i): m["name"] for m in roster for i in m.get("team_ids", [])}
    by_name = {norm(n): m["name"] for m in roster for n in m.get("team_names", [])}
    ranked = rank_rows(rows, comp["higher_is_better"])
    best = {}
    for rank, score, r in ranked:
        team = norm(r.get("TeamName", ""))
        member = by_id.get(str(r.get("TeamId", ""))) or by_name.get(team)
        if not member and PREFIX_RE.match(r.get("TeamName", "").strip()):
            member = display_name(r.get("TeamName", ""))
        if not member:
            continue
        # a member may appear under several teams; keep their best entry
        if member not in best or rank < best[member]["kaggle_rank"]:
            best[member] = {
                "member": member,
                "team": r.get("TeamName", ""),
                "kaggle_rank": rank,
                "score": score,
                "last_submission": (r.get("LastSubmissionDate") or r.get("SubmissionDate") or "")[:10] or None,
            }
    entries = sorted(best.values(), key=lambda e: e["kaggle_rank"])
    return {**comp, "total_teams": len(ranked), "entries": entries}


def add_history(entries, history, today):
    """Record today's snapshot, then attach to each entry its Kaggle rank movement
    since the latest earlier day and its daily score trend."""
    history = dict(history)
    history[today] = {e["member"]: [e["kaggle_rank"], e["score"]] for e in entries}
    days = sorted(history)[-HISTORY_DAYS:]
    history = {d: history[d] for d in days}
    earlier = [d for d in days if d < today]
    base = history[earlier[-1]] if earlier else None
    for e in entries:
        if base is not None:
            if e["member"] in base:
                e["rank_change"] = base[e["member"]][0] - e["kaggle_rank"]  # positive = moved up
            else:
                e["new"] = True
        e["history"] = [[d, history[d][e["member"]][1]] for d in days if e["member"] in history[d]]
    return history, (earlier[-1] if earlier else None)


def sync_one(comp, roster, data_dir, now, fetch):
    """Build one competition's board. fetch(slug, status) returns (rows, 'public'|'private').
    A competition past its settling time is frozen in final/<slug>.json and never fetched again."""
    slug = comp["slug"]
    final_path = data_dir / "final" / f"{slug}.json"
    frozen = load_json(final_path, None)
    if frozen:
        return frozen
    status = status_for(parse_deadline(comp.get("deadline")), now)
    rows, source = fetch(slug, status)
    res = build_competition(comp, rows, roster)
    direction = infer_direction(rows)
    if direction is not None:
        res["higher_is_better"] = direction
    res["status"], res["leaderboard"] = status, source
    hist_path = data_dir / "history" / f"{slug}.json"
    history, since = add_history(res["entries"], load_json(hist_path, {}), now.strftime("%Y-%m-%d"))
    res["movement_since"] = since
    write_if_changed(hist_path, history)
    if status == "final":
        res["finalized_at"] = iso(now)
        write_if_changed(final_path, res)
    return res


# --- announcements --------------------------------------------------------

def society_places(entries):
    """1, 1, 3: members with the same score share a place."""
    places = []
    for i, e in enumerate(entries):
        places.append(places[-1] if i and e["score"] == entries[i - 1]["score"] else i + 1)
    return places


def events(prev, new):
    """Things worth announcing, found by comparing the previous output with the new one."""
    if not prev or prev.get("sample"):
        return []
    old = {c["slug"]: c for c in prev.get("competitions", [])}
    out = []
    for c in new["competitions"]:
        url = f"https://www.kaggle.com/competitions/{c['slug']}/leaderboard"
        o = old.get(c["slug"])
        if o is None:
            out.append(f"New competition on the QMML leaderboard: **{c['title']}** <{url}>. "
                       f"Name your Kaggle team `qmml-yourname` to take part.")
            continue
        entries = c.get("entries", [])
        if c.get("status") == "final" and o.get("status") != "final":
            podium = ", ".join(f"{MEDALS[p - 1]} {e['member']} (Kaggle #{e['kaggle_rank']:,})"
                               for p, e in zip(society_places(entries), entries) if p <= 3)
            out.append(f"Final results for **{c['title']}**: {podium or 'no society members took part'}.")
            continue
        if c.get("status", "open") != "open":
            continue
        seen = {e["member"] for e in o.get("entries", [])}
        for e in entries:
            if e["member"] not in seen:
                out.append(f"**{e['member']}** joined the {c['title']} leaderboard at Kaggle #{e['kaggle_rank']:,}.")
        if entries and o.get("entries"):
            leader, old_leader = entries[0], o["entries"][0]["member"]
            old_now = next((e for e in entries if e["member"] == old_leader), None)
            # a new leader on the same score as the old one is a tie, not a takeover
            if leader["member"] != old_leader and (old_now is None or old_now["score"] != leader["score"]):
                out.append(f"**{leader['member']}** took 1st place in {c['title']} "
                           f"(Kaggle #{leader['kaggle_rank']:,}, score {leader['score']}).")
    return out


def notify(messages):
    url = os.environ.get("DISCORD_WEBHOOK_URL")
    if not url or not messages:
        return
    text = "\n".join(messages)
    for chunk in (text[i:i + 1900] for i in range(0, len(text), 1900)):
        body = json.dumps({"content": chunk, "allowed_mentions": {"parse": []}}).encode()
        req = urllib.request.Request(url, data=body, headers={
            "Content-Type": "application/json", "User-Agent": "qmml-leaderboard"})
        try:
            urllib.request.urlopen(req, timeout=10)
        except Exception as exc:  # an announcement failing must not fail the sync
            print(f"discord: FAILED ({exc})", file=sys.stderr)


# --- main -----------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-csv", type=Path)
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "leaderboard.json")
    ap.add_argument("--no-discover", action="store_true", help="don't add new Playground competitions")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    data_dir = args.out.parent
    comps_path = ROOT / "competitions.json"
    comps = json.loads(comps_path.read_text())
    roster = load_json(ROOT / "members.json", [])
    prev = load_json(args.out, None)
    config_changed = False

    api = None
    if not args.from_csv:
        from kaggle.api.kaggle_api_extended import KaggleApi
        api = KaggleApi()
        api.authenticate()
        if not args.no_discover:
            try:
                added = discover(api, comps, now)
            except Exception as exc:
                print(f"discover: FAILED ({exc})", file=sys.stderr)
                added = []
            for c in added:
                print(f"{c['slug']}: added to competitions.json")
            comps += added
            config_changed = bool(added)

    def fetch(slug, status):
        if args.from_csv:
            return load_csv_text((args.from_csv / f"{slug}.csv").read_text()), "public"
        if status == "open":
            return fetch_public(api, slug), "public"
        return fetch_final(api, slug), "private"

    old = {c["slug"]: c for c in (prev or {}).get("competitions", [])}
    results = []
    for comp in comps:
        try:
            res = sync_one(comp, roster, data_dir, now, fetch)
        except Exception as exc:  # keep going, one bad competition must not wipe the board
            print(f"{comp['slug']}: FAILED ({exc})", file=sys.stderr)
            if comp["slug"] in old:
                results.append(old[comp["slug"]])
            continue
        if res.get("higher_is_better") != comp.get("higher_is_better"):
            comp["higher_is_better"] = res["higher_is_better"]
            config_changed = True
        results.append(res)
        print(f"{comp['slug']}: {len(res['entries'])} members of {res['total_teams']} teams ({res.get('status')})")

    if config_changed:
        comps_path.write_text(json.dumps(comps, indent=2) + "\n")
    if not results:
        sys.exit("no competitions synced, leaving leaderboard.json unchanged")

    new = {"sample": bool(args.from_csv), "updated_at": iso(now), "competitions": results}
    if not args.from_csv:
        notify(events(prev, new))
        if prev and not prev.get("sample") and prev.get("competitions") == results:
            age = now - datetime.fromisoformat(prev["updated_at"].replace("Z", "+00:00"))
            if age < timedelta(minutes=50):
                print("no change, leaving leaderboard.json as is")
                return
    write_if_changed(args.out, new)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
