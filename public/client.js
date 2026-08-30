
const socket = io();

const SUIT_SYMBOLS = { diamond:"♦", heart:"♥", club:"♣", spade:"♠" };
const SUITS = ["diamond","heart","club","spade"];

let roomState = null;
let privateState = null;
let myPlayerId = null;
let actionMode = "play";

const $ = id => document.getElementById(id);

function showToast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.remove("hidden");
  setTimeout(() => $("toast").classList.add("hidden"), 2400);
}

function getMyPlayer() {
  return roomState?.players?.find(p => p.id === myPlayerId) || null;
}

function isCardPlayableClient(card, board) {
  const SEQUENCE = ["2","3","4","5","6","7","8","9","10","J","Q","K"];
  const s = board[card.suit];
  if (!s || s.closed || s.dead) return false;

  if (card.rank === "A") {
    if (!s.opened) return false;
    return s.highestIndex === 11 || s.lowestIndex === 0;
  }

  if (!s.opened) return card.rank === "7";

  const idx = SEQUENCE.indexOf(card.rank);
  const canLower = !s.lowerBlocked && idx === s.lowestIndex - 1;
  const canHigher = !s.upperBlocked && idx === s.highestIndex + 1;
  return canLower || canHigher;
}

function makeCard(card, small=false) {
  const el = document.createElement("div");
  const red = ["diamond","heart"].includes(card.suit);
  el.className = `card ${red ? "red" : ""} ${small ? "small" : ""}`;
  el.innerHTML = `
    <div class="rank">${card.rank}${SUIT_SYMBOLS[card.suit]}</div>
    <div class="suit-symbol">${SUIT_SYMBOLS[card.suit]}</div>
    <div class="rank bottom">${card.rank}${SUIT_SYMBOLS[card.suit]}</div>
  `;
  return el;
}

function render() {
  if (!roomState) return;

  $("roomBadge").textContent = `ROOM ${roomState.roomCode}`;
  $("roomBadge").classList.remove("hidden");

  $("homeScreen").classList.add("hidden");

  if (roomState.phase === "lobby") {
    $("lobbyScreen").classList.remove("hidden");
    $("gameScreen").classList.add("hidden");
    $("resultScreen").classList.add("hidden");
    renderLobby();
  } else if (roomState.phase === "playing") {
    $("lobbyScreen").classList.add("hidden");
    $("gameScreen").classList.remove("hidden");
    $("resultScreen").classList.add("hidden");
    renderGame();
  } else {
    $("lobbyScreen").classList.add("hidden");
    $("gameScreen").classList.add("hidden");
    $("resultScreen").classList.remove("hidden");
    renderResults();
  }
}

function renderLobby() {
  $("lobbyCode").textContent = roomState.roomCode;
  const wrap = $("lobbyPlayers");
  wrap.innerHTML = "";

  roomState.players.forEach(p => {
    const div = document.createElement("div");
    div.className = `player-item ${p.ready ? "ready" : ""}`;
    div.innerHTML = `
      <div>
        <strong>${escapeHtml(p.name)}</strong>
        ${p.isHost ? '<span class="muted"> · Host</span>' : ""}
        ${p.id === myPlayerId ? '<span class="muted"> · You</span>' : ""}
      </div>
      <div class="status">${p.ready ? "Ready" : "Not ready"}${!p.connected ? " · Disconnected" : ""}</div>
    `;
    wrap.appendChild(div);
  });

  const me = getMyPlayer();
  $("readyBtn").textContent = me?.ready ? "Unready" : "Ready";

  const isHost = me?.isHost;
  $("startBtn").classList.toggle("hidden", !isHost);

  const canStart = roomState.players.length === 4 && roomState.players.every(p => p.ready);
  $("startBtn").disabled = !canStart;

  $("lobbyMessage").textContent =
    roomState.players.length < 4
      ? `Waiting for ${4 - roomState.players.length} more player(s).`
      : canStart ? "All players ready." : "Waiting for everyone to ready up.";
}

function renderGame() {
  const me = getMyPlayer();
  if (!me) return;

  $("youName").textContent = me.name;

  const current = roomState.players.find(p => p.id === roomState.currentPlayerId);
  $("turnText").textContent = current ? `${current.name}'s turn` : "";
  $("lastEvent").textContent = roomState.lastEvent || "";

  const myTurn = roomState.currentPlayerId === myPlayerId;
  $("actionHelp").textContent = !myTurn
    ? "Wait for your turn."
    : actionMode === "play"
      ? "Play a highlighted card, or switch to Discard to throw away any card."
      : "Discard mode: choose any card. Nobody else will see what you discarded.";

  renderScores();
  renderBoard();
  renderHand(myTurn);
}

function renderScores() {
  const wrap = $("scoreRow");
  wrap.innerHTML = "";

  roomState.players.forEach(p => {
    const div = document.createElement("div");
    div.className = `score-card ${p.id === roomState.currentPlayerId ? "current" : ""} ${p.id === myPlayerId ? "me" : ""}`;
    div.innerHTML = `
      <div class="score-name">${escapeHtml(p.name)}</div>
      <div class="score-meta">${p.handCount} cards · ${p.score} discard pts</div>
    `;
    wrap.appendChild(div);
  });
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";

  SUITS.forEach(suit => {
    const s = roomState.board[suit];
    const lane = document.createElement("div");
    lane.className = "suit-lane";

    const status = s.dead ? "Dead" : s.closed ? "Closed" : s.opened ? "Open" : "Waiting";
    lane.innerHTML = `
      <div class="suit-head">
        <span>${SUIT_SYMBOLS[suit]} ${suit[0].toUpperCase()+suit.slice(1)}</span>
        <span>${status}</span>
      </div>
    `;

    const line = document.createElement("div");
    line.className = "cards-line";

    if (!s.opened) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = s.dead ? "7 was discarded. Suit is dead." : "Waiting for 7";
      line.appendChild(empty);
    } else {
      for (const rank of s.playedRanks) {
        line.appendChild(makeCard({ suit, rank }, true));
      }
      if (s.acePlayed) line.appendChild(makeCard({ suit, rank:"A" }, true));
    }

    lane.appendChild(line);
    board.appendChild(lane);
  });
}

function renderHand(myTurn) {
  const wrap = $("hand");
  wrap.innerHTML = "";

  const hand = privateState?.hand || [];

  hand.forEach(card => {
    const el = makeCard(card);
    const playable = isCardPlayableClient(card, roomState.board);

    el.classList.add("clickable");
    if (!myTurn) el.classList.add("disabled");

    if (myTurn && actionMode === "play") {
      if (playable) el.classList.add("playable");
      else el.classList.add("disabled");
    }

    el.addEventListener("click", () => {
      if (!myTurn) return;

      if (actionMode === "play") {
        if (!playable) return showToast("That card cannot be played.");
        socket.emit("playCard", { cardId: card.id });
      } else {
        socket.emit("discardCard", { cardId: card.id });
      }
    });

    wrap.appendChild(el);
  });
}

function renderResults() {
  const wrap = $("ranking");
  wrap.innerHTML = "";

  for (const item of roomState.rankings || []) {
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `
      <div class="result-rank">#${item.rank}</div>
      <div><strong>${escapeHtml(item.name)}</strong></div>
      <div>${item.score} pts</div>
    `;
    wrap.appendChild(row);
  }

  const me = getMyPlayer();
  $("restartBtn").classList.toggle("hidden", !me?.isHost);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

$("createBtn").addEventListener("click", () => {
  const name = $("nameInput").value.trim();
  if (!name) return $("homeError").textContent = "Enter your name first.";
  $("homeError").textContent = "";
  socket.emit("createRoom", { name });
});

$("joinBtn").addEventListener("click", () => {
  const name = $("nameInput").value.trim();
  const roomCode = $("roomInput").value.trim().toUpperCase();
  if (!name) return $("homeError").textContent = "Enter your name first.";
  if (!roomCode) return $("homeError").textContent = "Enter the room code.";
  $("homeError").textContent = "";
  socket.emit("joinRoom", { roomCode, name });
});

$("readyBtn").addEventListener("click", () => socket.emit("toggleReady"));
$("startBtn").addEventListener("click", () => socket.emit("startMatch"));
$("restartBtn").addEventListener("click", () => socket.emit("restartRoom"));

$("copyCodeBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomState.roomCode);
    showToast("Room code copied.");
  } catch {
    showToast(`Room code: ${roomState.roomCode}`);
  }
});

$("playModeBtn").addEventListener("click", () => {
  actionMode = "play";
  $("playModeBtn").classList.add("active");
  $("discardModeBtn").classList.remove("active");
  render();
});

$("discardModeBtn").addEventListener("click", () => {
  actionMode = "discard";
  $("discardModeBtn").classList.add("active");
  $("playModeBtn").classList.remove("active");
  render();
});

socket.on("joined", data => {
  myPlayerId = data.playerId;
});

socket.on("roomState", state => {
  roomState = state;
  render();
});

socket.on("privateState", state => {
  privateState = state;
  render();
});

socket.on("errorMessage", msg => {
  showToast(msg);
  $("homeError").textContent = msg;
});
