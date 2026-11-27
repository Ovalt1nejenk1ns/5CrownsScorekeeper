// Five Crowns Scorekeeper. Works on its own (GitHub Pages) and on the Game Night server, which also saves every round to SQLite.
"use strict";

// ------------------------------------------------------------------ auto-save to the Game Night server
// When this page is served by game-night-server, every save also goes to its SQLite database.
// On GitHub Pages there's no /api, the health check fails, and this quietly does nothing.
const Sync = (() => {
  let enabled = false, sending = false;
  const queue = new Map(), failed = new Map();   // keyed by game id, so two games never overwrite each other
  const ready = fetch("/api/health", { cache: "no-store" })
    .then((r) => r.ok && (r.headers.get("content-type") || "").includes("json"))
    .then((ok) => { enabled = Boolean(ok); if (enabled) show("Connected to the game server"); })
    .catch(() => {});

  function show(text, bad = false) {
    const el = document.getElementById("syncStatus");
    if (el) { el.textContent = text; el.style.color = bad ? "var(--red, #c00)" : ""; }
  }

  // Each save sends the whole game, so a later save also fixes any earlier one that failed.
  async function save(id, gameType, state) {
    await ready;
    if (!enabled || !id) return;
    queue.set(id, JSON.stringify({ game_type: gameType, state }));  // newer state for the same game replaces older
    flush();
  }

  async function flush() {
    if (sending) return;            // the running loop picks up anything queued meanwhile
    sending = true;
    while (queue.size) {
      const [id, body] = queue.entries().next().value;
      queue.delete(id);
      try {
        const r = await fetch(`/api/games/${encodeURIComponent(id)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body,
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        failed.delete(id);
        show("✓ Saved to the game server");
      } catch (err) {
        failed.set(id, body);
        show(`Not saved to the server yet (${err.message}). It will retry on the next save.`, true);
      }
    }
    sending = false;
  }

  const retry = () => { failed.forEach((body, id) => queue.has(id) || queue.set(id, body)); flush(); };
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) retry(); });

  return { save, ready: () => ready.then(() => enabled) };
})();

// crypto.randomUUID() only works on https or localhost. Over http://klisby it's undefined,
// so build an id from the time plus random letters instead.
const newGameId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const STORE_KEY = "fivecrowns-league:current";
const OLD_KEY = "fiveCrownsGame";                 // the previous version of this app saved here
const ROUND_CARDS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];   // round k deals ROUND_CARDS[k]; that rank is wild
const WILD_NAME = { 11: "Jacks", 12: "Queens", 13: "Kings" };
const wildName = (cards) => WILD_NAME[cards] || `${cards}s`;
const PALETTE = ["var(--red)", "var(--blue)", "var(--green)", "var(--orange)", "var(--purple)", "var(--teal)"];
const QUICK = [[5, "+5"], [10, "+10"], [20, "+20 wild"], [50, "+50 joker"]];

// state = { id, label, players: [...], rounds: 11, startDealer: 0,
//           hands: [{ winner, left: [points per player] }],
//           scores: { name: [points per round] } }   kept in step with hands; the server scores from it
//           hands: [{ winner: 0, left: [0, 37, 12] }] }   left = card points in each hand; winner's is 0
let state = load() || migrateOld();
if (state && !state.id) state.id = newGameId("fc");
let draft = null;        // { winner: index|null, left: [string per player] }
let onServer = false;    // set once the Game Night server answers /api/health

const $ = (id) => document.getElementById(id);
// Names go into innerHTML, so escape them. Without this, a name like "<img onerror=...>" runs as code.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => n.toLocaleString("en-US");
const standard = () => false;   // everyone keeps their own points, like Uno's alternative scoring

// ------------------------------------------------------------------ storage
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
}
// Bring over a game in progress from the previous version of the app.
function migrateOld() {
  try {
    const old = JSON.parse(localStorage.getItem(OLD_KEY));
    if (!old || !Array.isArray(old.players) || !old.players.length) return null;
    const n = (old.scores[old.players[0]] || []).length;
    if (n >= 11) return null;                          // finished games are already in the archive
    const hands = Array.from({ length: n }, (_, k) => {
      const left = old.players.map((p) => old.scores[p][k]);
      return { winner: Math.max(0, left.indexOf(0)), left };
    });
    return { id: old.id || newGameId("fc"), label: "Five Crowns", players: old.players, rounds: 11, startDealer: 0, hands };
  } catch { return null; }
}

function save() {
  if (state) {
    state.scores = Object.fromEntries(state.players.map((p, i) => [p, state.hands.map((h) => h.left[i])]));
    Sync.save(state.id, "fivecrowns", state);
  }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { toast("Couldn't save in this browser. Download the CSV to be safe."); }
}

// ------------------------------------------------------------------ scoring (mirrors gamenight/rules.py)
// Winner collects: the round winner scores the sum of everyone's leftover card points.
// Everyone keeps their own: each player adds their own leftover points; lowest total wins.
function roundPoints(hand) {
  if (!standard()) return hand.left.slice();
  const pot = hand.left.reduce((a, b) => a + b, 0);
  return hand.left.map((_, i) => (i === hand.winner ? pot : 0));
}

function computePlayers() {
  const perRound = state.hands.map(roundPoints);
  const players = state.players.map((name, i) => {
    const pts = perRound.map((r) => r[i]);
    const held = state.hands.map((h) => h.left[i]);
    const won = state.hands.map((h) => h.winner === i);
    let run = 0;
    const cum = pts.map((p) => (run += p));
    return { name, seat: i, pts, held, won, cum, total: run, wins: won.filter(Boolean).length,
             best: Math.max(0, ...(standard() ? pts : held.filter((_, k) => !won[k]))) };
  });
  const ranked = [...players].sort(standard()
    ? (a, b) => b.total - a.total || b.wins - a.wins
    : (a, b) => a.total - b.total || b.wins - a.wins);
  (state.hands.length ? ranked : players).forEach((p, i) => { p.color = PALETTE[i % PALETTE.length]; });
  return { players, ranked };
}
const isOver = () => state.hands.length >= state.rounds;

// ------------------------------------------------------------------ setup view
function renderSetup() {
  $("setup").classList.remove("hidden");
  $("game").classList.add("hidden");
  if (!$("nameList").children.length) ["", ""].forEach(addNameRow);
}
function addNameRow(value = "") {
  if ($("nameList").children.length >= 8) return ($("setupErr").textContent = "Up to 8 players.");
  const n = $("nameList").children.length + 1;
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<input type="text" id="name${n}" aria-label="Player ${n} name" placeholder="Player ${n}" maxlength="20" value="${esc(value)}">
    <button class="iconbtn" type="button" aria-label="Remove player ${n}">×</button>`;
  row.querySelector("button").onclick = () => row.remove();
  $("nameList").appendChild(row);
}
function startGame() {
  const names = [...$("nameList").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  if (names.length < 2) return ($("setupErr").textContent = "Add at least two players.");
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length)
    return ($("setupErr").textContent = "Two players have the same name. Add an initial to tell them apart.");
  const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  state = {
    id: newGameId("fc"), label: $("gameLabel").value.trim() || today, players: names,
    rounds: 11, startDealer: Number($("startDealer").value) || 0, hands: [],
  };
  draft = null;
  save();
  render();
}

// ------------------------------------------------------------------ game view
function render() {
  if (!state) return renderSetup();
  $("setup").classList.add("hidden");
  $("game").classList.remove("hidden");

  const { players, ranked } = computePlayers();
  const over = isOver(players);
  const n = state.hands.length;
  const leader = ranked[0];
  $("gameEyebrow").textContent = `${state.label} · ${n} of ${state.rounds} rounds played`;
  if (!n) {
    $("headline").textContent = "Shuffle up";
    $("subline").textContent = `${players.length} players, 11 rounds. Deal 3 cards each; 3s are wild. Lowest total wins.`;
  } else if (over) {
    $("headline").innerHTML = `<em style="color:${leader.color}">${esc(leader.name)}</em> takes the crown`;
    $("subline").innerHTML = standard()
      ? `${esc(leader.name)} reached <strong>${fmt(leader.total)} points</strong> in ${n} rounds.`
      : `Lowest total after all 11 rounds: <strong>${fmt(leader.total)} points</strong>.`
        + (ranked[1] && ranked[1].total === leader.total ? ` Tied with ${esc(ranked[1].name)}.` : "");
  } else {
    $("headline").innerHTML = `<em style="color:${leader.color}">${esc(leader.name)}</em> leads after round ${n}`;
    const top = Math.max(...players.map((p) => p.total));
    $("subline").innerHTML = standard()
      ? `<strong>${fmt(leader.total)} points</strong>, ${fmt(state.target - leader.total)} away from ${fmt(state.target)}.`
      : `<strong>${fmt(leader.total)} points</strong> so far. ${state.rounds - n} ${state.rounds - n === 1 ? "round" : "rounds"} to go.`;
  }
  $("heroCard").style.setProperty("--champ", leader.color);
  const big = n ? fmt(leader.total) : "♛";
  $("heroCenter").textContent = big;
  $("heroCenter").classList.toggle("long", big.length >= 3);
  $("heroCorner1").textContent = $("heroCorner2").textContent = n ? "★" : "K";
  $("heroRibbon").textContent = over ? "Champion" : n ? "Leader" : "Five Crowns";

  $("entryHelp").textContent = standard()
    ? "Tap who went out. Then add up the card points left in everyone else's hand."
    : "Tap who went out. Then add up the cards left in everyone else's hand.";
  $("standingsNote").textContent = standard()
    ? `Highest score leads. First to ${fmt(state.target)} wins.`
    : "Lowest score leads. Lowest total after 11 rounds wins.";
  $("ladderNote").textContent = standard()
    ? "Solid card: went out, with the points they collected. Dashed card: points left in that hand."
    : "Solid card: went out (0). Dashed card: points left in hand that round. Tap a card to fix that round.";
  $("raceNote").textContent = standard()
    ? "Running score after each round. The dashed line is the finish."
    : "Running total after each round. Lower is better.";

  $("entrySection").classList.toggle("hidden", over);
  $("overSection").classList.toggle("hidden", !over);
  $("undoBtn").disabled = !n;
  $("exportBtn").href = `/api/games/${encodeURIComponent(state.id)}.csv`;
  if (over) {
    $("banner").style.setProperty("--champ", leader.color);
    $("banner").innerHTML = `<div class="eyebrow" style="color:#fff;opacity:.85;margin:0">Game over</div>
      <h2>${esc(leader.name)} wins</h2>
      <div>${onServer ? "The game is saved on the server. Start a new one whenever you're ready." : "Download the CSV to keep this game, then start a new one."}</div>
      <div class="row" style="margin-top:8px"><button class="btn small" style="border-color:#fff;color:#fff" type="button" id="bannerUndo">Undo last round</button></div>`;
    $("bannerUndo").onclick = undoHand;
  } else {
    const cards = ROUND_CARDS[n];
    $("entryTitle").textContent = `Round ${n + 1} of 11`;
    $("roundInfo").innerHTML = `<span class="badge">${cards} cards each</span><span class="badge trump">${wildName(cards)} are wild</span>`
      + `<span class="badge dealer" style="--c:${players[(state.startDealer + n) % players.length].color}">Dealer: ${esc(state.players[(state.startDealer + n) % players.length])}</span>`;
    if (!draft || draft.left.length !== players.length) draft = { winner: null, left: players.map(() => "") };
    renderEntry(players);
  }

  renderPodium(ranked);
  renderLadder(players);
  renderChart(players);
}

function renderEntry(players) {
  $("entryRows").innerHTML = players.map((p, i) => {
    const isWinner = draft.winner === i;
    return `<div class="erow" style="--c:${p.color}">
      <div><div class="pname">${esc(p.name)}</div><div class="ptask">${fmt(p.total)} points · ${p.wins} ${p.wins === 1 ? "round" : "rounds"} won</div></div>
      <button type="button" class="toggle winpick" aria-pressed="${isWinner}" data-win="${i}">${isWinner ? "★ Went out" : "Went out?"}</button>
      <div class="pts">
        ${isWinner
          ? `<div class="ptask" style="margin:0">No cards left</div>`
          : `<input type="number" inputmode="numeric" min="0" id="left${i}" aria-label="Points left in ${esc(p.name)}'s hand" placeholder="Points left" value="${draft.left[i]}">
             <div class="quick">${QUICK.map(([v, t]) => `<button type="button" data-add="${i}" data-v="${v}">${t}</button>`).join("")}<button type="button" data-clear="${i}">Clear</button></div>`}
      </div>
    </div>`;
  }).join("");
  updatePreview();
}

function updatePreview() {
  if (draft.winner === null) return ($("preview").textContent = "");
  const left = draft.left.map((v, i) => (i === draft.winner ? 0 : Number(v) || 0));
  if (standard()) {
    const pot = left.reduce((a, b) => a + b, 0);
    $("preview").innerHTML = `${esc(state.players[draft.winner])} collects <strong>${fmt(pot)}</strong> points`;
  } else {
    $("preview").innerHTML = state.players.map((name, i) => `${esc(name)} +${fmt(left[i])}`).join(" · ");
  }
}

function renderPodium(ranked) {
  const sfx = (k) => (k === 1 ? "st" : k === 2 ? "nd" : k === 3 ? "rd" : "th");
  $("podium").innerHTML = ranked.map((p, i) => `
    <article class="pcard" style="--c:${p.color}">
      <div style="display:flex;justify-content:space-between;align-items:end;gap:10px">
        <div class="name">${esc(p.name)}</div><div class="place">${i + 1}${sfx(i + 1)}</div>
      </div>
      <span class="tag">${standard()
        ? (p.total >= state.target ? "Reached " + fmt(state.target) : fmt(state.target - p.total) + " to go")
        : p.wins + (p.wins === 1 ? " round" : " rounds") + " gone out"}</span>
      <dl class="stats num">
        <dt>Score</dt><dd>${fmt(p.total)}</dd>
        <dt>Went out</dt><dd>${p.wins}</dd>
        <dt>${standard() ? "Biggest round" : "Worst hand"}</dt><dd>${p.best ? fmt(p.best) : "–"}</dd>
      </dl>
    </article>`).join("");
}

function renderLadder(players) {
  const n = state.hands.length;
  $("ladderSection").classList.toggle("hidden", !n);
  const grid = $("ladder");
  grid.style.setProperty("--hands", n || 1);
  let html = "<div></div>";
  for (let h = 1; h <= n; h++) html += `<div class="hh">${ROUND_CARDS[h - 1]}s<small style="display:block;font-weight:400">wild</small></div>`;
  players.forEach((p) => {
    html += `<div class="who" style="color:${p.color}">${esc(p.name)}</div>`;
    for (let k = 0; k < n; k++) {
      html += p.won[k]
        ? `<button type="button" class="chip win" data-edit="${k}" style="--c:${p.color};font-size:17px;border:0" title="Round ${k + 1}: went out. Tap to fix this round.">0<small>out</small></button>`
        : `<button type="button" class="chip left" data-edit="${k}" style="--c:${p.color};font-size:17px;background:transparent" title="Round ${k + 1}: ${p.held[k]} points. Tap to fix this round.">${p.held[k]}</button>`;
    }
  });
  grid.innerHTML = html;
}

function renderChart(players) {
  const n = state.hands.length;
  $("raceSection").classList.toggle("hidden", n < 1);
  if (n < 1) return;
  const svg = $("chart"), W = 900, H = 360, L = 52, R = 110, T = 16, B = 40;
  const top = Math.max(10, Math.ceil(Math.max(...players.map((p) => p.total)) / 5) * 5);
  const step = top <= 20 ? 5 : top <= 50 ? 10 : 20;
  const x = (i) => L + (W - L - R) * (i / n), y = (v) => T + (H - T - B) * (1 - v / top);
  let s = "";
  for (let v = 0; v <= top; v += step) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  for (let i = 0; i <= n; i++) s += `<text x="${x(i)}" y="${H - B + 20}" text-anchor="middle">${i === 0 ? "Start" : i}</text>`;
  players.forEach((p) => {
    const d = [0, ...p.cum].map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    s += `<path d="${d}" fill="none" stroke="${p.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(n)}" cy="${y(p.total)}" r="5" fill="${p.color}"/>`;
  });
  const labels = players.map((p) => ({ p, y: y(p.total) })).sort((a, b) => a.y - b.y);
  labels.forEach((l, i) => { if (i && l.y - labels[i - 1].y < 16) l.y = labels[i - 1].y + 16; });
  labels.forEach(({ p, y: ly }) => (s += `<text x="${W - R + 10}" y="${ly + 4}" style="fill:${p.color};font-weight:700">${esc(p.name)} ${fmt(p.total)}</text>`));
  svg.innerHTML = s;
  $("chartKey").innerHTML = players.map((p) => `<span style="--c:${p.color}">${esc(p.name)}</span>`).join("");
}

// ------------------------------------------------------------------ round entry
$("entryRows").addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.win !== undefined) {
    const i = +t.dataset.win;
    draft.winner = draft.winner === i ? null : i;  // tap again to clear
    if (draft.winner !== null) draft.left[i] = "";
    renderEntry(computePlayers().players);
  } else if (t.dataset.add !== undefined) {
    const i = +t.dataset.add;
    setLeft(i, (Number(draft.left[i]) || 0) + Number(t.dataset.v));
  } else if (t.dataset.clear !== undefined) {
    setLeft(+t.dataset.clear, "");
  }
});
$("entryRows").addEventListener("input", (e) => {
  const m = e.target.id.match(/^left(\d+)$/);
  if (m) { draft.left[+m[1]] = e.target.value; updatePreview(); }
});
function setLeft(i, v) { draft.left[i] = v; $("left" + i).value = v; updatePreview(); }

$("entryForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (draft.winner === null) return ($("entryErr").textContent = "Tap the player who went out first.");
  const left = [];
  for (let i = 0; i < state.players.length; i++) {
    if (i === draft.winner) { left.push(0); continue; }
    const raw = String(draft.left[i]).trim(), v = Number(raw);
    if (raw === "") return ($("entryErr").textContent = `How many points are left in ${state.players[i]}'s hand? Enter 0 if they laid everything down.`);
    if (!Number.isInteger(v) || v < 0) return ($("entryErr").textContent = `${state.players[i]}'s points should be a whole number, 0 or more.`);
    left.push(v);
  }
  $("entryErr").textContent = "";
  const hand = { winner: draft.winner, left };
  state.hands.push(hand);
  draft = null;
  save();
  render();
  const pts = roundPoints(hand);
  toast(standard() ? `Round ${state.hands.length} saved: ${state.players[hand.winner]} +${fmt(pts[hand.winner])}` : `Round ${state.hands.length} saved`);
});

function undoHand() {
  if (!state.hands.length) return;
  confirmThen(`Remove round ${state.hands.length}? Its points will go back into the entry form.`, () => {
    const h = state.hands.pop();
    draft = { winner: h.winner, left: h.left.map((v, i) => (i === h.winner ? "" : v)) };
    save();
    render();
  });
}
$("undoBtn").onclick = undoHand;

$("newBtn").onclick = () => confirmThen(onServer
  ? "Start a new game? This one stays saved on the server."
  : "Start a new game? This one is cleared from this browser, so download the CSV first if you want to keep it.", () => {
  const names = state.players;
  state = null; draft = null;
  try { localStorage.removeItem(STORE_KEY); } catch {}
  $("nameList").innerHTML = "";
  names.forEach(addNameRow);
  $("gameLabel").value = "";
  render();
});

// ------------------------------------------------------------------ small UI helpers
function confirmThen(text, onYes) {
  $("confirmText").textContent = text;
  $("confirmDlg").classList.remove("hidden");
  $("confirmYes").focus();
  $("confirmYes").onclick = () => { $("confirmDlg").classList.add("hidden"); onYes(); };
  $("confirmNo").onclick = () => $("confirmDlg").classList.add("hidden");
}
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}

$("addName").onclick = () => addNameRow();
$("startGame").onclick = startGame;

// ------------------------------------------------------------------ CSV + server/standalone mode
// Same columns as the server's /api/games/<id>.csv, so a CSV from either place looks the same.
function toCSV() {
  const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
  const lines = ["Round,Player,Points"];
  state.hands.forEach((h, k) => {
    const pts = roundPoints(h);
    state.players.forEach((name, i) => lines.push([ROUND_CARDS[k], q(name), pts[i]].join(",")));   // "Round" = cards dealt, 3 to 13
  });
  return lines.join("\n") + "\n";
}
$("exportBtn").addEventListener("click", (e) => {
  if (onServer) return;                 // the link goes to the server's CSV
  e.preventDefault();                   // GitHub Pages: build the file in the browser instead
  if (!state) return;
  const url = URL.createObjectURL(new Blob([toCSV()], { type: "text/csv" }));
  const name = (state.label || "five-crowns").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".csv";
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

Sync.ready().then((ok) => {
  if (!ok) return;
  onServer = true;
  document.querySelectorAll("[data-server]").forEach((el) => (el.hidden = false));
  $("toolsNote").textContent = "Every round saves to the Game Night server as you go.";
});


// ------------------------------------------------------------------ fixing an earlier round
// Tap any card in the round-by-round grid to correct that round (the old app's "edit round").
let editing = null;
$("ladder").addEventListener("click", (e) => {
  const t = e.target.closest("[data-edit]");
  if (!t || !state) return;
  editing = Number(t.dataset.edit);
  const h = state.hands[editing];
  $("editTitle").textContent = `Fix round ${editing + 1} (${wildName(ROUND_CARDS[editing])} wild)`;
  $("editRows").innerHTML = state.players.map((name, i) => `<div class="field"><label for="ed${i}">${esc(name)}</label>
    <input type="number" inputmode="numeric" min="0" id="ed${i}" value="${h.left[i]}"></div>`).join("");
  $("editErr").textContent = "";
  $("editDlg").classList.remove("hidden");
  $("ed0").focus();
});
$("editCancel").onclick = () => $("editDlg").classList.add("hidden");
$("editSave").onclick = () => {
  const left = state.players.map((_, i) => Number($("ed" + i).value));
  if (left.some((v) => !Number.isInteger(v) || v < 0)) return ($("editErr").textContent = "Points should be whole numbers, 0 or more.");
  if (!left.includes(0)) return ($("editErr").textContent = "Someone went out that round, so at least one score should be 0.");
  const old = state.hands[editing];
  state.hands[editing] = { winner: left[old.winner] === 0 ? old.winner : left.indexOf(0), left };
  $("editDlg").classList.add("hidden");
  save();
  render();
  toast(`Round ${editing + 1} fixed`);
};

// ------------------------------------------------------------------ this device's history
// The old app kept finished games and win counts in this browser. Keep doing that, and show them.
function archiveFinished() {
  try {
    const archives = JSON.parse(localStorage.getItem("gameArchives") || "[]");
    if (archives.some((a) => a.id === state.id)) return;
    const scores = Object.fromEntries(state.players.map((p, i) => [p, state.hands.map((h) => h.left[i])]));
    archives.push({ id: state.id, label: state.label, players: state.players, scores, completedAt: new Date().toISOString() });
    localStorage.setItem("gameArchives", JSON.stringify(archives));
    const { ranked } = computePlayers();
    const stats = JSON.parse(localStorage.getItem("winnerStats") || "{}");
    stats[ranked[0].name] = (stats[ranked[0].name] || 0) + 1;
    localStorage.setItem("winnerStats", JSON.stringify(stats));
  } catch { /* history is a convenience; the game itself is already saved */ }
}
function renderHistory() {
  let archives = [], stats = {};
  try { archives = JSON.parse(localStorage.getItem("gameArchives") || "[]"); stats = JSON.parse(localStorage.getItem("winnerStats") || "{}"); } catch {}
  const wins = Object.entries(stats).sort((a, b) => b[1] - a[1]);
  $("historyWins").innerHTML = wins.length
    ? wins.map(([name, w]) => `<span class="badge">${esc(name)}: ${w} ${w === 1 ? "win" : "wins"}</span>`).join("")
    : "";
  $("historyList").innerHTML = archives.slice(-10).reverse().map((a) => {
    const totals = a.players.map((p) => [p, (a.scores[p] || []).reduce((x, y) => x + y, 0)]).sort((x, y) => x[1] - y[1]);
    const when = new Date(a.completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `<li><strong>${esc(totals[0][0])}</strong> won with ${totals[0][1]} · ${esc(totals.map((t) => t[0] + " " + t[1]).join(", "))} <span class="empty">(${when})</span></li>`;
  }).join("");
  $("historyEmpty").classList.toggle("hidden", archives.length > 0);
}

// Games finished in this browser before the server existed: send them once. The id comes from the
// finish time, so sending again updates the same game instead of adding a copy.
async function uploadArchives() {
  let archives = [];
  try { archives = JSON.parse(localStorage.getItem("gameArchives") || "[]"); } catch {}
  for (const a of archives) {
    if (a.id) continue;                                 // games from this version already saved as they were played
    const id = "fc-archive-" + a.completedAt.replace(/\D/g, "").slice(0, 17);
    const label = "Five Crowns " + new Date(a.completedAt).toLocaleDateString();
    await Sync.save(id, "fivecrowns", { label, players: a.players, scores: a.scores });
  }
}

// Setup: pick the first dealer
function refreshDealers() {
  const names = [...$("nameList").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  const sel = $("startDealer"), keep = sel.value;
  sel.innerHTML = names.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join("") || `<option value="0">Add players first</option>`;
  if (keep && Number(keep) < names.length) sel.value = keep;
}
$("nameList").addEventListener("input", refreshDealers);
$("nameList").addEventListener("click", () => setTimeout(refreshDealers));

// Record finished games in this browser's history too.
const _render = render;
render = function () {
  _render();
  if (state && isOver()) archiveFinished();
  renderHistory();
  if (!state) refreshDealers();
};

Sync.ready().then((ok) => { if (ok) uploadArchives(); });

render();
