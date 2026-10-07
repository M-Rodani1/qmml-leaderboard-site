# QMML Kaggle Leaderboard

Static site showing how QMUL ML Society members rank on Kaggle competitions.

## How it works
`scripts/sync.py` downloads each public leaderboard listed in `competitions.json`, keeps every team whose name starts with `qmml-` (so `qmml-aisha-rahman` shows as Aisha Rahman), and writes `data/leaderboard.json`. `index.html` renders that file. A GitHub Action runs the sync hourly and commits the result.

## Setup
1. Create a Kaggle API token (Kaggle > Settings > API) and add it as the repo secret `KAGGLE_API_TOKEN` (locally: `export KAGGLE_API_TOKEN=...`).
2. Enable GitHub Pages for the repo root.
3. Edit `competitions.json` (slug, metric, direction). `members.json` is optional: add `{name, team_names, team_ids}` only for someone whose team does not start with `qmml-`.
4. Optional: set `REPO` in `register.html` to get the "Open as GitHub issue" button.

## Local use
    pip install -r requirements.txt
    python scripts/sync.py                           # live, needs Kaggle credentials
    python -m http.server                            # then open http://localhost:8000

Members join by naming their Kaggle team `qmml-yourname`. Kaggle exposes team names, not usernames, so the prefix is the only signal. Anyone can use it, so check the board occasionally.
