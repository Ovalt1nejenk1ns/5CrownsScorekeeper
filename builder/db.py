"""Game archive: every finished Five Crowns game, kept in data/games.db (SQLite).

In the scorekeeper, open Game History and tap "Export all games (CSV)". Then:

    python builder/db.py import ~/Downloads/five-crowns-history-2026-11-21.csv
    python builder/db.py games                 # every stored game, newest first
    python builder/db.py stats                 # all-time standings
    python builder/db.py sql "SELECT * FROM game_results WHERE place = 1"

The export always holds the phone's whole history, so importing it again is safe:
games already in the archive are replaced, never duplicated.

Tables: players, games, rounds (one row per player per round). Rounds are
numbered 3 to 13 like the app, by cards dealt, which is also that round's wild rank.
The game_results view has each player's total and finishing place (lowest wins).
Needs only the standard library.
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "games.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE      -- "liz" and "Liz" are the same person
);
CREATE TABLE IF NOT EXISTS games (
    id           INTEGER PRIMARY KEY,
    completed_at TEXT NOT NULL UNIQUE,            -- the app's timestamp; identifies the game
    played_on    TEXT NOT NULL,                   -- YYYY-MM-DD in your time zone
    saved_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rounds (
    game_id   INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    round     INTEGER NOT NULL CHECK (round BETWEEN 3 AND 13),
    player_id INTEGER NOT NULL REFERENCES players(id),
    points    INTEGER NOT NULL CHECK (points >= 0),
    PRIMARY KEY (game_id, round, player_id)
);
-- Lowest total wins.
CREATE VIEW IF NOT EXISTS game_results AS
SELECT g.id AS game_id, g.played_on, g.completed_at, p.name AS player,
       SUM(r.points) AS points, SUM(r.points = 0) AS zero_rounds, COUNT(*) AS rounds,
       RANK() OVER (PARTITION BY g.id ORDER BY SUM(r.points)) AS place
FROM rounds r
JOIN games g   ON g.id = r.game_id
JOIN players p ON p.id = r.player_id
GROUP BY g.id, p.id;
"""


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row                # rows act like dicts: row["player"]
    conn.execute("PRAGMA foreign_keys = ON")      # off by default in SQLite, per connection
    conn.executescript(SCHEMA)
    return conn


def player_id(conn: sqlite3.Connection, name: str) -> int:
    conn.execute("INSERT OR IGNORE INTO players (name) VALUES (?)", (name,))
    return conn.execute("SELECT id FROM players WHERE name = ?", (name,)).fetchone()["id"]


def local_date(stamp: str) -> str:
    """The app stores UTC ("...Z"). A 9 pm game in Ohio is already tomorrow in UTC, so convert."""
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone().date().isoformat()


def load_export(csv_path: Path) -> dict[str, dict[str, dict[int, int]]]:
    """CSV -> {completed_at: {player: {round: points}}}"""
    games: dict = defaultdict(lambda: defaultdict(dict))
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            name = (row.get("Player") or "").strip()
            if not name or not row.get("Completed"):
                continue
            games[row["Completed"].strip()][name][int(row["Round"])] = int(float(row["Points"] or 0))
    if not games:
        raise SystemExit(f"No games found in {csv_path}. Is it the export from Game History?")
    return games


def import_export(csv_path: Path, path: Path = DB_PATH) -> tuple[int, int]:
    """Returns (new games, replaced games)."""
    games = load_export(csv_path)
    conn = connect(path)
    new = replaced = 0
    try:
        with conn:                                # one transaction for the whole file
            for stamp, players in games.items():
                cur = conn.execute("DELETE FROM games WHERE completed_at = ?", (stamp,))
                replaced += cur.rowcount
                new += cur.rowcount == 0
                game_id = conn.execute("INSERT INTO games (completed_at, played_on) VALUES (?, ?)",
                                       (stamp, local_date(stamp))).lastrowid
                conn.executemany("INSERT INTO rounds VALUES (?, ?, ?, ?)",
                                 [(game_id, rnd, player_id(conn, name), pts)
                                  for name, by_round in players.items() for rnd, pts in by_round.items()])
    finally:
        conn.close()
    return new, replaced


# ------------------------------------------------------------------- CLI

def show(rows) -> None:
    rows = list(rows)
    if not rows:
        print("(no rows)")
        return
    cols = rows[0].keys()
    widths = [max(len(str(c)), *(len(str(r[c])) for r in rows)) for c in cols]
    print("  ".join(str(c).ljust(w) for c, w in zip(cols, widths)))
    print("  ".join("-" * w for w in widths))
    for r in rows:
        print("  ".join(str(r[c]).ljust(w) for c, w in zip(cols, widths)))


STATS = """
SELECT player,
       COUNT(*)                                  AS games,
       SUM(place = 1)                            AS wins,
       ROUND(100.0 * SUM(place = 1) / COUNT(*))  AS win_pct,
       ROUND(AVG(points))                        AS avg_score,
       MIN(points)                               AS best_score,
       SUM(zero_rounds)                          AS zero_rounds
FROM game_results
GROUP BY player
ORDER BY wins DESC, avg_score
"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    imp = sub.add_parser("import", help="add the Game History export to the archive")
    imp.add_argument("csv", type=Path)
    sub.add_parser("games", help="list stored games")
    sub.add_parser("stats", help="all-time standings")
    q = sub.add_parser("sql", help="run your own query")
    q.add_argument("query")
    args = ap.parse_args()

    if args.cmd == "import":
        new, replaced = import_export(args.csv)
        print(f"{new} new game(s), {replaced} already in the archive (refreshed) -> {DB_PATH}")
        return

    conn = connect()
    try:
        if args.cmd == "games":
            show(conn.execute("""SELECT played_on, COUNT(*) AS players,
                                        MAX(CASE WHEN place = 1 THEN player END) AS winner,
                                        MIN(points) AS winning_score
                                 FROM game_results GROUP BY game_id ORDER BY completed_at DESC"""))
        elif args.cmd == "stats":
            show(conn.execute(STATS))
        elif args.cmd == "sql":
            show(conn.execute(args.query))
    except sqlite3.Error as e:
        sys.exit(f"SQL error: {e}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
