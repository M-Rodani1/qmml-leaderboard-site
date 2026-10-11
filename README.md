# QMML Kaggle Leaderboard

Static site showing how QMUL ML Society members rank on Kaggle competitions.


## How it works
`scripts/sync.py` runs from a GitHub Action, trying every 15 minutes (GitHub often delays scheduled runs, so gaps of an hour or two happen). Each run:

- **Finds new competitions.** Any running Playground Series competition (`playground-series-sXeY`) not yet in `competitions.json` is added, so each month's competition appears on its own. Whether higher or lower scores win is read from Kaggle's own ranking.
- **Reads each leaderboard.** Before the deadline it uses the public leaderboard. After the deadline it reads the final (private) leaderboard, shown as provisional for 2 days, then saves it to `data/final/<slug>.json` and never fetches that competition again.
- **Keeps the society's teams** and writes `data/leaderboard.json`, which `index.html` renders.
- **Records a daily snapshot** in `data/history/<slug>.json`, used for the rank movement arrows and score trend lines.
- **Announces changes on Discord** (optional): new members, a new 1st place, new competitions and final podiums.

It commits when the data changes, or at least hourly to refresh the "Updated" time.

## Setup
1. Create a Kaggle API token (Kaggle > Settings > API) and add it as the repo secret `KAGGLE_API_TOKEN`.
2. Enable GitHub Pages for the repo root.
3. Optional Discord announcements: in Discord, open the channel's settings > Integrations > Webhooks, create a webhook, and add its URL as the repo secret `DISCORD_WEBHOOK_URL`.
4. Optional: `members.json` maps people whose team does not start with `qmml-`: `{"name": ..., "team_names": [...], "team_ids": [...]}`.

To track a competition that is not in the Playground Series, add it to `competitions.json` by hand (slug, title, metric, `higher_is_better`, deadline as `YYYY-MM-DDTHH:MM:SSZ`).

## Refresh now
    gh workflow run sync.yml --repo M-Rodani1/qmml-leaderboard-site

## Local use
    pip install -r requirements.txt
    export KAGGLE_API_TOKEN=...
    python scripts/sync.py                           # live
    python -m http.server                            # then open http://localhost:8000

## Tests
    python -m unittest discover -s tests             # sync script
    node --test tests/app.test.js                    # site logic

Both run on every push.
