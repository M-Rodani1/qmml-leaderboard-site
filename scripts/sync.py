#!/usr/bin/env python3
"""Download Kaggle leaderboards, keep society members, write data/leaderboard.json.

Usage:
  python scripts/sync.py                       # live, needs Kaggle credentials
  python scripts/sync.py --from-csv DIR        # offline, reads DIR/<slug>.csv (testing)
"""
import argparse, csv, io, json, re, sys, tempfile, zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


PREFIX = "qmml-"  # any team whose name starts with this belongs to the society


def norm(s):
    return re.sub(r"\s+", " ", str(s)).strip().lower()


def load_csv_text(text):
    return list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))


def fetch_live(api, slug, tmp):
    api.competition_leaderboard_download(slug, tmp)
    zips = list(Path(tmp).glob("*.zip"))
    if not zips:
        raise RuntimeError(f"no leaderboard zip downloaded for {slug}")
    with zipfile.ZipFile(zips[0]) as z:
        names = [n for n in z.namelist() if n.endswith(".csv")]
        pick = next((n for n in names if "public" in n.lower()), names[0])
        text = z.read(pick).decode("utf-8")
    zips[0].unlink()
    return load_csv_text(text)


def display_name(team_name):
    """'qmml-aisha-rahman' -> 'Aisha Rahman'; mixed case like 'qmml-MoRo' is kept as written."""
    rest = team_name.strip()[len(PREFIX):]
    rest = re.sub(r"[-_\s]+", " ", rest).strip()
    return rest.title() if rest == rest.lower() else rest


def rank_rows(rows, higher_is_better):
    """Competition ranking (ties share the best rank) from the score column."""
    scored = []
    for r in rows:
        try:
            scored.append((float(r["Score"]), r))
        except (KeyError, ValueError):
            continue
    if scored and all(r.get("Rank", "").isdigit() for _, r in scored):
        # newer Kaggle exports carry the official rank (it breaks ties on unrounded scores)
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
        if not member and team.startswith(PREFIX) and len(team) > len(PREFIX):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-csv", type=Path)
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "leaderboard.json")
    args = ap.parse_args()

    comps = json.loads((ROOT / "competitions.json").read_text())
    roster = json.loads((ROOT / "members.json").read_text())

    api = None
    if not args.from_csv:
        from kaggle.api.kaggle_api_extended import KaggleApi
        api = KaggleApi()
        api.authenticate()

    results, failed = [], []
    for comp in comps:
        try:
            if args.from_csv:
                rows = load_csv_text((args.from_csv / f"{comp['slug']}.csv").read_text())
            else:
                with tempfile.TemporaryDirectory() as tmp:
                    rows = fetch_live(api, comp["slug"], tmp)
            res = build_competition(comp, rows, roster)
            results.append(res)
            print(f"{comp['slug']}: {len(res['entries'])} members of {res['total_teams']} teams")
        except Exception as exc:  # keep going, one bad competition must not wipe the board
            failed.append(comp["slug"])
            print(f"{comp['slug']}: FAILED ({exc})", file=sys.stderr)

    if not results:
        sys.exit("no competitions synced, leaving leaderboard.json unchanged")

    # a failed competition keeps its previous data
    if failed and args.out.exists():
        old = {c["slug"]: c for c in json.loads(args.out.read_text()).get("competitions", [])}
        results += [old[s] for s in failed if s in old]
        order = {c["slug"]: i for i, c in enumerate(comps)}
        results.sort(key=lambda c: order.get(c["slug"], 99))

    args.out.write_text(json.dumps({
        "sample": bool(args.from_csv),
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "competitions": results,
    }, indent=2) + "\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
