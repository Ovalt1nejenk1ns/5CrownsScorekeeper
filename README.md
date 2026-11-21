# 5CrownsScorekeeper

A single-file Five Crowns scorekeeper (`index.html`) that runs offline in the browser and saves games on the device.

## Game archive (SQLite)

Games in the app live only in that browser. To keep a permanent history in this repo:

1. In the app, open **Game History** and tap **Export all games (CSV)**.
2. Import the file and push:

```bash
python builder/db.py import ~/Downloads/five-crowns-history-2026-11-21.csv
git add data/games.db && git commit -m "Update game archive" && git push
```

The export always contains every game on that phone, so importing it again is safe: games already in the archive are refreshed, never duplicated. Exports from different phones go into the same archive.

```bash
python builder/db.py games      # every game, newest first, with the winner
python builder/db.py stats      # all-time wins, average and best score, zero-point rounds
python builder/db.py sql "SELECT * FROM game_results WHERE player = 'Justin'"
```

| Table / view | One row per |
|---|---|
| `players` | person (names match regardless of case) |
| `games` | game: `completed_at` (from the app), `played_on` (your local date) |
| `rounds` | player per round: `round` (3–13, the cards dealt), `points` |
| `game_results` (view) | player per game: `points`, `zero_rounds`, `place` (lowest score wins) |

Needs Python 3.9+ and nothing else. You can also open `data/games.db` in [DB Browser for SQLite](https://sqlitebrowser.org/).
