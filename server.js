
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", app: "seven-online" });
});

const PORT = process.env.PORT || 3000;

const SUITS = ["diamond", "heart", "club", "spade"];
const SUIT_SYMBOLS = { diamond: "♦", heart: "♥", club: "♣", spade: "♠" };
const SEQUENCE = ["2","3","4","5","6","7","8","9","10","J","Q","K"];
const ALL_RANKS = [...SEQUENCE, "A"];

const rooms = new Map();

function getCardValue(rank) {
  if (rank === "A") return 11;
  if (["J","Q","K"].includes(rank)) return 10;
  return Number(rank);
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of ALL_RANKS) {
      deck.push({
        id: `${suit}-${rank}`,
        suit,
        rank,
        value: getCardValue(rank)
      });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const copy = [...deck];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createBoard() {
  const board = {};
  SUITS.forEach(suit => {
    board[suit] = {
      opened: false,
      playedRanks: [],
      lowestIndex: null,
      highestIndex: null,
      lowerBlocked: false,
      upperBlocked: false,
      closed: false,
      dead: false,
      acePlayed: false
    };
  });
  return board;
}

function sortHand(hand) {
  const suitOrder = { diamond:0, heart:1, club:2, spade:3 };
  const rankOrder = {};
  ALL_RANKS.forEach((rank, i) => rankOrder[rank] = i);

  hand.sort((a,b) => {
    if (suitOrder[a.suit] !== suitOrder[b.suit]) {
      return suitOrder[a.suit] - suitOrder[b.suit];
    }
    return rankOrder[a.rank] - rankOrder[b.rank];
  });
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  const clean = String(name || "").trim().slice(0, 18);
  return clean || "Player";
}

function getRoomForSocket(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return null;
  return rooms.get(roomCode) || null;
}

function findPlayerBySocket(room, socketId) {
  return room.players.find(p => p.socketId === socketId);
}

function publicRoomState(room) {
  return {
    roomCode: room.code,
    phase: room.phase,
    currentPlayerId: room.currentPlayerId,
    board: room.board,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      handCount: p.hand.length,
      ready: p.ready,
      connected: p.connected,
      isHost: p.id === room.hostPlayerId
    })),
    rankings: room.rankings,
    lastEvent: room.lastEvent
  };
}

function privatePlayerState(room, player) {
  return {
    playerId: player.id,
    hand: player.hand,
    discardedCount: player.discardedCards.length
  };
}

function emitState(room) {
  io.to(room.code).emit("roomState", publicRoomState(room));
  for (const player of room.players) {
    if (player.connected && player.socketId) {
      io.to(player.socketId).emit("privateState", privatePlayerState(room, player));
    }
  }
}

function dealCards(room) {
  const deck = shuffleDeck(createDeck());
  deck.forEach((card, index) => {
    room.players[index % 4].hand.push(card);
  });
  room.players.forEach(p => sortHand(p.hand));
}

function findSevenDiamondHolder(room) {
  return room.players.find(p =>
    p.hand.some(c => c.suit === "diamond" && c.rank === "7")
  );
}

function playOpeningSevenDiamond(room) {
  const holder = findSevenDiamondHolder(room);
  if (!holder) throw new Error("7♦ not found");

  const idx = holder.hand.findIndex(c => c.id === "diamond-7");
  holder.hand.splice(idx, 1);

  const s = room.board.diamond;
  const sevenIndex = SEQUENCE.indexOf("7");
  s.opened = true;
  s.lowestIndex = sevenIndex;
  s.highestIndex = sevenIndex;
  s.playedRanks = ["7"];

  const holderIndex = room.players.findIndex(p => p.id === holder.id);
  const next = room.players[(holderIndex + 1) % room.players.length];

  room.currentPlayerId = next.id;
  room.lastEvent = `${holder.name} opened with 7♦`;
}

function isCardPlayable(card, board) {
  const s = board[card.suit];
  if (!s || s.closed || s.dead) return false;

  if (card.rank === "A") {
    if (!s.opened) return false;
    return s.highestIndex === 11 || s.lowestIndex === 0;
  }

  if (!s.opened) return card.rank === "7";

  const idx = SEQUENCE.indexOf(card.rank);
  if (idx < 0) return false;

  const canLower = !s.lowerBlocked && idx === s.lowestIndex - 1;
  const canHigher = !s.upperBlocked && idx === s.highestIndex + 1;

  return canLower || canHigher;
}

function updateBoardAfterPlay(room, card) {
  const s = room.board[card.suit];
  const idx = SEQUENCE.indexOf(card.rank);

  if (!s.opened) {
    s.opened = true;
    s.lowestIndex = idx;
    s.highestIndex = idx;
    s.playedRanks = [card.rank];
    return;
  }

  if (idx === s.lowestIndex - 1) s.lowestIndex = idx;
  if (idx === s.highestIndex + 1) s.highestIndex = idx;

  if (!s.playedRanks.includes(card.rank)) {
    s.playedRanks.push(card.rank);
    s.playedRanks.sort((a,b) => SEQUENCE.indexOf(a) - SEQUENCE.indexOf(b));
  }
}

function wasDiscarded(room, suit, rank) {
  return room.discardedCardIds.has(`${suit}-${rank}`);
}

function refreshBlockedPaths(room, suit) {
  const s = room.board[suit];
  if (!s.opened || s.closed || s.dead) return;

  if (!s.lowerBlocked && s.lowestIndex > 0) {
    const nextRank = SEQUENCE[s.lowestIndex - 1];
    if (wasDiscarded(room, suit, nextRank)) s.lowerBlocked = true;
  }

  if (!s.upperBlocked && s.highestIndex < 11) {
    const nextRank = SEQUENCE[s.highestIndex + 1];
    if (wasDiscarded(room, suit, nextRank)) s.upperBlocked = true;
  }
}

function discardToPlayer(room, player, card) {
  player.discardedCards.push(card);
  player.score += card.value;
  room.discardedCardIds.add(card.id);
}

function autoDiscardEntireSuit(room, suit) {
  for (const player of room.players) {
    const keep = [];
    for (const card of player.hand) {
      if (card.suit === suit) {
        discardToPlayer(room, player, card);
      } else {
        keep.push(card);
      }
    }
    player.hand = keep;
  }
}

function closeSuit(room, suit) {
  const s = room.board[suit];
  s.closed = true;
  s.acePlayed = true;
  autoDiscardEntireSuit(room, suit);
}

function calculateRanking(players) {
  const sorted = [...players].sort((a,b) => a.score - b.score);
  let prevScore = null;
  let prevRank = 0;

  return sorted.map((p, index) => {
    let rank = index + 1;
    if (p.score === prevScore) rank = prevRank;
    prevScore = p.score;
    prevRank = rank;
    return { playerId: p.id, name: p.name, score: p.score, rank };
  });
}

function finishIfNeeded(room) {
  if (room.players.every(p => p.hand.length === 0)) {
    room.phase = "finished";
    room.currentPlayerId = null;
    room.rankings = calculateRanking(room.players);
    room.lastEvent = "Game finished";
    return true;
  }
  return false;
}

function advanceTurn(room) {
  if (finishIfNeeded(room)) return;

  const currentIndex = room.players.findIndex(p => p.id === room.currentPlayerId);
  let nextIndex = currentIndex;

  do {
    nextIndex = (nextIndex + 1) % room.players.length;
  } while (room.players[nextIndex].hand.length === 0);

  room.currentPlayerId = room.players[nextIndex].id;
}

function resetGameData(room) {
  room.phase = "lobby";
  room.currentPlayerId = null;
  room.board = createBoard();
  room.discardedCardIds = new Set();
  room.rankings = null;
  room.lastEvent = "Waiting in lobby";

  room.players.forEach(p => {
    p.hand = [];
    p.discardedCards = [];
    p.score = 0;
    p.ready = false;
  });
}

function startMatch(room) {
  if (room.players.length !== 4) {
    throw new Error("Need exactly 4 players");
  }

  room.board = createBoard();
  room.discardedCardIds = new Set();
  room.rankings = null;
  room.phase = "playing";
  room.lastEvent = "Game started";

  room.players.forEach(p => {
    p.hand = [];
    p.discardedCards = [];
    p.score = 0;
  });

  dealCards(room);
  playOpeningSevenDiamond(room);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name }) => {
    const code = generateRoomCode();
    const playerId = cryptoRandomId();

    const player = {
      id: playerId,
      socketId: socket.id,
      name: sanitizeName(name),
      hand: [],
      discardedCards: [],
      score: 0,
      ready: false,
      connected: true
    };

    const room = {
      code,
      phase: "lobby",
      hostPlayerId: playerId,
      players: [player],
      currentPlayerId: null,
      board: createBoard(),
      discardedCardIds: new Set(),
      rankings: null,
      lastEvent: `${player.name} created the room`
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    socket.emit("joined", { roomCode: code, playerId });
    emitState(room);
  });

  socket.on("joinRoom", ({ roomCode, name }) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return socket.emit("errorMessage", "Room not found.");
    if (room.phase !== "lobby") return socket.emit("errorMessage", "Game already started.");
    if (room.players.length >= 4) return socket.emit("errorMessage", "Room is full.");

    const playerId = cryptoRandomId();
    const player = {
      id: playerId,
      socketId: socket.id,
      name: sanitizeName(name),
      hand: [],
      discardedCards: [],
      score: 0,
      ready: false,
      connected: true
    };

    room.players.push(player);
    room.lastEvent = `${player.name} joined the room`;

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    socket.emit("joined", { roomCode: code, playerId });
    emitState(room);
  });

  socket.on("toggleReady", () => {
    const room = getRoomForSocket(socket);
    if (!room || room.phase !== "lobby") return;

    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;

    player.ready = !player.ready;
    room.lastEvent = `${player.name} is ${player.ready ? "ready" : "not ready"}`;
    emitState(room);
  });

  socket.on("startMatch", () => {
    const room = getRoomForSocket(socket);
    if (!room || room.phase !== "lobby") return;

    const player = findPlayerBySocket(room, socket.id);
    if (!player || player.id !== room.hostPlayerId) {
      return socket.emit("errorMessage", "Only the host can start.");
    }

    if (room.players.length !== 4) {
      return socket.emit("errorMessage", "Exactly 4 players are required.");
    }

    if (!room.players.every(p => p.ready)) {
      return socket.emit("errorMessage", "All players must be ready.");
    }

    startMatch(room);
    emitState(room);
  });

  socket.on("playCard", ({ cardId }) => {
    const room = getRoomForSocket(socket);
    if (!room || room.phase !== "playing") return;

    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;

    if (room.currentPlayerId !== player.id) {
      return socket.emit("errorMessage", "Not your turn.");
    }

    const idx = player.hand.findIndex(c => c.id === cardId);
    if (idx < 0) return socket.emit("errorMessage", "Card not found.");

    const card = player.hand[idx];
    if (!isCardPlayable(card, room.board)) {
      return socket.emit("errorMessage", "That card cannot be played.");
    }

    player.hand.splice(idx, 1);

    if (card.rank === "A") {
      closeSuit(room, card.suit);
      room.lastEvent = `${player.name} closed ${card.suit}`;
    } else {
      updateBoardAfterPlay(room, card);
      refreshBlockedPaths(room, card.suit);
      room.lastEvent = `${player.name} played ${card.rank}${SUIT_SYMBOLS[card.suit]}`;
    }

    advanceTurn(room);
    emitState(room);
  });

  socket.on("discardCard", ({ cardId }) => {
    const room = getRoomForSocket(socket);
    if (!room || room.phase !== "playing") return;

    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;

    if (room.currentPlayerId !== player.id) {
      return socket.emit("errorMessage", "Not your turn.");
    }

    const idx = player.hand.findIndex(c => c.id === cardId);
    if (idx < 0) return socket.emit("errorMessage", "Card not found.");

    const card = player.hand[idx];
    player.hand.splice(idx, 1);
    discardToPlayer(room, player, card);

    const s = room.board[card.suit];

    if (card.rank === "7" && !s.opened) {
      s.dead = true;
      autoDiscardEntireSuit(room, card.suit);
    } else {
      refreshBlockedPaths(room, card.suit);
    }

    room.lastEvent = `${player.name} discarded a hidden card`;
    advanceTurn(room);
    emitState(room);
  });

  socket.on("restartRoom", () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player || player.id !== room.hostPlayerId) return;

    resetGameData(room);
    emitState(room);
  });

  socket.on("disconnect", () => {
    const room = getRoomForSocket(socket);
    if (!room) return;

    const player = findPlayerBySocket(room, socket.id);
    if (player) {
      player.connected = false;
      player.socketId = null;
      room.lastEvent = `${player.name} disconnected`;
    }

    if (room.players.every(p => !p.connected)) {
      setTimeout(() => {
        const latest = rooms.get(room.code);
        if (latest && latest.players.every(p => !p.connected)) {
          rooms.delete(room.code);
        }
      }, 15 * 60 * 1000);
    } else {
      emitState(room);
    }
  });
});

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

server.listen(PORT, () => {
  console.log(`Seven Online running on http://localhost:${PORT}`);
});
