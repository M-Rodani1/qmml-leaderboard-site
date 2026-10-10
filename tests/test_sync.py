import importlib.util
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("sync", ROOT / "scripts" / "sync.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

UTC = timezone.utc
COMP = {"slug": "playground-series-s6e10", "title": "Predicting Airline Satisfaction", "metric": "ROC AUC",
        "higher_is_better": True, "deadline": "2026-10-31T23:59:00Z"}


def row(rank, name, score, team_id=None):
    return {"Rank": str(rank), "TeamId": str(team_id or rank), "TeamName": name,
            "LastSubmissionDate": "2026-10-05 12:00:00", "Score": str(score)}


def entry(member, rank, score):
    return {"member": member, "team": f"qmml-{member}", "kaggle_rank": rank, "score": score, "last_submission": "2026-10-05"}


class TeamNames(unittest.TestCase):
    def test_prefix_variants(self):
        cases = {"qmml-MoRo": "MoRo", "QMML - Manu": "Manu", "qmml-aisha-rahman": "Aisha Rahman",
                 "QMML-Loss-Cause": "Loss Cause", "Qmml-YAK": "YAK"}
        for name, expected in cases.items():
            self.assertTrue(sync.PREFIX_RE.match(name), name)
            self.assertEqual(sync.display_name(name), expected)

    def test_non_members(self):
        for name in ["qmml", "qmml-", "qmmlx", "my qmml-team", "QMML -  "]:
            self.assertIsNone(sync.PREFIX_RE.match(name.strip()), name)


class Ranking(unittest.TestCase):
    def test_build_keeps_members_and_best_team(self):
        rows = [row(1, "Someone", 0.97), row(5, "qmml-MoRo", 0.96), row(7, "QMML - Manu", 0.955),
                row(12, "MoRo backup", 0.95)]
        roster = [{"name": "MoRo", "team_names": ["moro backup"]}]
        res = sync.build_competition(COMP, rows, roster)
        self.assertEqual(res["total_teams"], 4)
        self.assertEqual([(e["member"], e["kaggle_rank"], e["team"]) for e in res["entries"]],
                         [("MoRo", 5, "qmml-MoRo"), ("Manu", 7, "QMML - Manu")])

    def test_ties_share_rank_without_rank_column(self):
        rows = [{"TeamName": n, "Score": s} for n, s in [("a", "0.9"), ("b", "0.95"), ("c", "0.95")]]
        self.assertEqual([r for r, _, _ in sync.rank_rows(rows, True)], [1, 1, 3])
        self.assertEqual([r for r, _, _ in sync.rank_rows(rows, False)], [1, 2, 2])

    def test_infer_direction(self):
        self.assertTrue(sync.infer_direction([row(1, "a", 0.97), row(2, "b", 0.5)]))
        self.assertFalse(sync.infer_direction([row(1, "a", 0.1), row(2, "b", 0.5)]))
        self.assertIsNone(sync.infer_direction([row(1, "a", 0.1)]))
        self.assertIsNone(sync.infer_direction([row(1, "a", 0.5), row(2, "b", 0.5)]))


class Competitions(unittest.TestCase):
    def test_status_over_time(self):
        d = sync.parse_deadline(COMP["deadline"])
        self.assertEqual(sync.status_for(d, datetime(2026, 10, 10, tzinfo=UTC)), "open")
        self.assertEqual(sync.status_for(d, datetime(2026, 11, 1, 12, tzinfo=UTC)), "closed")
        self.assertEqual(sync.status_for(d, datetime(2026, 11, 3, tzinfo=UTC)), "final")
        self.assertEqual(sync.status_for(None, datetime(2030, 1, 1, tzinfo=UTC)), "open")

    def test_date_only_deadline_is_end_of_day(self):
        self.assertEqual(sync.parse_deadline("2026-10-31"), datetime(2026, 10, 31, 23, 59, tzinfo=UTC))

    def test_metric_names_and_direction(self):
        self.assertEqual(sync.pretty_metric("Roc Auc Score"), "ROC AUC")
        self.assertEqual(sync.pretty_metric("Balanced Accuracy Score"), "Balanced Accuracy")
        self.assertTrue(sync.guess_higher_is_better("ROC AUC"))
        self.assertFalse(sync.guess_higher_is_better("Root Mean Squared Error"))
        self.assertFalse(sync.guess_higher_is_better("Log Loss"))

    def test_discover_only_new_running_playground_series(self):
        def comp(slug, deadline, metric="Roc Auc Score"):
            return SimpleNamespace(ref=f"https://www.kaggle.com/competitions/{slug}", title=slug.upper(),
                                   evaluation_metric=metric, deadline=deadline)
        api = SimpleNamespace(competitions_list=lambda **kw: SimpleNamespace(competitions=[
            comp("playground-series-s6e11", datetime(2026, 11, 30, 23, 59), "Root Mean Squared Error"),
            comp("playground-series-s6e10", datetime(2026, 10, 31, 23, 59)),  # already tracked
            comp("playground-series-s6e9", datetime(2026, 9, 30, 23, 59)),    # ended
            comp("playground-cirrhosis-multi-class-trial", datetime(2026, 12, 1)),  # not the series
        ]))
        found = sync.discover(api, [COMP], datetime(2026, 11, 1, tzinfo=UTC))
        self.assertEqual(found, [{"slug": "playground-series-s6e11", "title": "PLAYGROUND-SERIES-S6E11",
                                  "metric": "Root Mean Squared Error", "higher_is_better": False,
                                  "deadline": "2026-11-30T23:59:00Z"}])


class History(unittest.TestCase):
    def test_movement_since_previous_day(self):
        hist = {"2026-10-09": {"MoRo": [700, 0.959], "Seelie": [630, 0.96]}}
        entries = [entry("MoRo", 692, 0.95946), entry("Manu", 739, 0.95877)]
        hist, since = sync.add_history(entries, hist, "2026-10-10")
        self.assertEqual(since, "2026-10-09")
        self.assertEqual(entries[0]["rank_change"], 8)
        self.assertTrue(entries[1]["new"])
        self.assertEqual(entries[0]["history"], [["2026-10-09", 0.959], ["2026-10-10", 0.95946]])
        # a second run on the same day still compares with the previous day, not itself
        again = [entry("MoRo", 690, 0.95950)]
        _, since = sync.add_history(again, hist, "2026-10-10")
        self.assertEqual((since, again[0]["rank_change"]), ("2026-10-09", 10))

    def test_first_day_has_no_movement(self):
        entries = [entry("MoRo", 692, 0.95946)]
        _, since = sync.add_history(entries, {}, "2026-10-10")
        self.assertIsNone(since)
        self.assertNotIn("rank_change", entries[0])
        self.assertNotIn("new", entries[0])


class Freezing(unittest.TestCase):
    def test_final_results_are_frozen_and_not_refetched(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            comp = {**COMP, "deadline": "2026-10-01T00:00:00Z"}
            calls = []

            def fetch(slug, status):
                calls.append(status)
                return [row(1, "Someone", 0.97), row(3, "qmml-MoRo", 0.96)], "private"

            now = datetime(2026, 10, 5, tzinfo=UTC)
            res = sync.sync_one(comp, [], data_dir, now, fetch)
            self.assertEqual((res["status"], res["leaderboard"]), ("final", "private"))
            self.assertTrue((data_dir / "final" / f"{comp['slug']}.json").exists())

            def boom(slug, status):
                raise AssertionError("a frozen competition must not be fetched")

            again = sync.sync_one(comp, [], data_dir, now + timedelta(days=1), boom)
            self.assertEqual(again["entries"], res["entries"])
            self.assertEqual(calls, ["final"])

    def test_open_competition_uses_public_board_and_records_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            fetch = lambda slug, status: ([row(1, "a", 0.97), row(2, "qmml-MoRo", 0.96)], "public")
            res = sync.sync_one(COMP, [], data_dir, datetime(2026, 10, 10, tzinfo=UTC), fetch)
            self.assertEqual(res["status"], "open")
            self.assertTrue((data_dir / "history" / f"{COMP['slug']}.json").exists())
            self.assertFalse((data_dir / "final").exists())


class Announcements(unittest.TestCase):
    def board(self, entries, status="open"):
        return {"competitions": [{**COMP, "status": status, "entries": entries}]}

    def test_nothing_on_first_run(self):
        self.assertEqual(sync.events(None, self.board([entry("MoRo", 5, 0.96)])), [])

    def test_new_member_and_new_leader(self):
        prev = self.board([entry("MoRo", 5, 0.96)])
        new = self.board([entry("Seelie", 3, 0.961), entry("MoRo", 5, 0.96)])
        msgs = sync.events(prev, new)
        self.assertTrue(any("**Seelie** joined" in m for m in msgs))
        self.assertTrue(any("**Seelie** took 1st place" in m for m in msgs))

    def test_tie_at_the_top_is_not_a_takeover(self):
        prev = self.board([entry("MoRo", 5, 0.96), entry("Seelie", 9, 0.95)])
        new = self.board([entry("Seelie", 4, 0.96), entry("MoRo", 5, 0.96)])
        self.assertEqual(sync.events(prev, new), [])

    def test_final_podium_shares_medals_on_ties(self):
        entries = [entry("A", 1, 0.9), entry("B", 2, 0.9), entry("C", 3, 0.8), entry("D", 4, 0.7)]
        msgs = sync.events(self.board(entries, "closed"), self.board(entries, "final"))
        self.assertEqual(len(msgs), 1)
        self.assertIn("🥇 A", msgs[0])
        self.assertIn("🥇 B", msgs[0])
        self.assertIn("🥉 C", msgs[0])
        self.assertNotIn("D", msgs[0].split(":", 1)[1])

    def test_new_competition(self):
        msgs = sync.events({"competitions": []}, self.board([]))
        self.assertEqual(len(msgs), 1)
        self.assertIn("New competition", msgs[0])


if __name__ == "__main__":
    unittest.main()
