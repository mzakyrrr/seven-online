const express = require("express");
const http = require("http");
const path = require("path");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && JWT_SECRET === "dev-only-change-me") {
  console.error("JWT_SECRET must be configured in production.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const SUITS = ["diamond", "heart", "club", "spade"];
const SUIT_SYMBOLS = { diamond: "♦", heart: "♥", club: "♣", spade: "♠" };
const SEQUENCE = ["2","3","4","5","6","7","8","9","10","J","Q","K"];
const ALL_RANKS = [...SEQUENCE, "A"];
const rooms = new Map();
const userActiveRoom = new Map();

function tierForRating(rating) {
  if (rating < 800) return "Iron";
  if (rating < 1000) return "Bronze";
  if (rating < 1200) return "Silver";
  if (rating < 1400) return "Gold";
  if (rating < 1600) return "Platinum";
  if (rating < 1800) return "Diamond";
  if (rating < 2000) return "Master";
  return "Seven Master";
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(18) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      rating INTEGER NOT NULL DEFAULT 1000,
      games_played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      podiums INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS matches (
      id BIGSERIAL PRIMARY KEY,
      room_code VARCHAR(8),
      played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS match_players (
      id BIGSERIAL PRIMARY KEY,
      match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      final_rank INTEGER NOT NULL,
      discard_score INTEGER NOT NULL,
      rating_before INTEGER NOT NULL,
      rating_after INTEGER NOT NULL,
      rating_delta INTEGER NOT NULL,
      UNIQUE(match_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_match_players_user_id ON match_players(user_id);
    CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at DESC);
  `);
}

function issueAuthCookie(res, user) {
  const token = jwt.sign(
    { userId: String(user.id), username: user.username },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.cookie("seven_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function authMiddleware(req, res, next) {
  const payload = verifyToken(req.cookies.seven_token);
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  req.auth = payload;
  next();
}

async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT id, username, rating, games_played, wins, podiums, created_at
     FROM users WHERE id = $1`,
    [id]
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    id: String(rows[0].id),
    tier: tierForRating(rows[0].rating)
  };
}

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", app: "seven-online-v2", database: "connected" });
  } catch {
    res.status(500).json({ status: "error", database: "disconnected" });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!/^[A-Za-z0-9_]{3,18}$/.test(username)) {
      return res.status(400).json({ error: "Username must be 3-18 characters: letters, numbers, or underscore." });
    }
    if (password.length < 6 || password.length > 72) {
      return res.status(400).json({ error: "Password must be 6-72 characters." });
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users(username, password_hash)
       VALUES($1, $2)
       RETURNING id, username, rating, games_played, wins, podiums, created_at`,
      [username, hash]
    );

    const user = { ...rows[0], id: String(rows[0].id), tier: tierForRating(rows[0].rating) };
    issueAuthCookie(res, user);
    res.status(201).json({ user });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Username already exists." });
    console.error(err);
    res.status(500).json({ error: "Could not register." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const { rows } = await pool.query(`SELECT * FROM users WHERE LOWER(username) = LOWER($1)`, [username]);
    const userRow = rows[0];

    if (!userRow || !(await bcrypt.compare(password, userRow.password_hash))) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const user = {
      id: String(userRow.id),
      username: userRow.username,
      rating: userRow.rating,
      games_played: userRow.games_played,
      wins: userRow.wins,
      podiums: userRow.podiums,
      created_at: userRow.created_at,
      tier: tierForRating(userRow.rating)
    };

    issueAuthCookie(res, user);
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not login." });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("seven_token");
  res.json({ ok: true });
});

app.get("/api/me", authMiddleware, async (req, res) => {
  const user = await getUserById(req.auth.userId);
  if (!user) return res.status(401).json({ error: "User not found." });
  res.json({ user });
});

app.get("/api/leaderboard", authMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, username, rating, games_played, wins, podiums
    FROM users
    ORDER BY rating DESC, wins DESC, games_played ASC, id ASC
    LIMIT 100
  `);
  res.json({
    leaderboard: rows.map((r, i) => ({
      rank: i + 1,
      id: String(r.id),
      username: r.username,
      rating: r.rating,
      tier: tierForRating(r.rating),
      gamesPlayed: r.games_played,
      wins: r.wins,
      podiums: r.podiums
    }))
  });
});

app.get("/api/history", authMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      m.id AS match_id,
      m.room_code,
      m.played_at,
      mp.final_rank,
      mp.discard_score,
      mp.rating_before,
      mp.rating_after,
      mp.rating_delta,
      COALESCE(
        json_agg(
          json_build_object(
            'username', u2.username,
            'finalRank', mp2.final_rank,
            'discardScore', mp2.discard_score,
            'ratingDelta', mp2.rating_delta
          )
          ORDER BY mp2.final_rank ASC, mp2.discard_score ASC
        ) FILTER (WHERE u2.id IS NOT NULL),
        '[]'::json
      ) AS participants
    FROM match_players mp
    JOIN matches m ON m.id = mp.match_id
    JOIN match_players mp2 ON mp2.match_id = m.id
    JOIN users u2 ON u2.id = mp2.user_id
    WHERE mp.user_id = $1
    GROUP BY m.id, mp.id
    ORDER BY m.played_at DESC
    LIMIT 50
  `, [req.auth.userId]);

  res.json({
    history: rows.map(r => ({
      matchId: String(r.match_id),
      roomCode: r.room_code,
      playedAt: r.played_at,
      finalRank: r.final_rank,
      discardScore: r.discard_score,
      ratingBefore: r.rating_before,
      ratingAfter: r.rating_after,
      ratingDelta: r.rating_delta,
      participants: r.participants
    }))
  });
});

function getCardValue(rank) {
  if (rank === "A") return 11;
  if (["J","Q","K"].includes(rank)) return 10;
  return Number(rank);
}
function createDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of ALL_RANKS) {
    deck.push({ id:`${suit}-${rank}`, suit, rank, value:getCardValue(rank) });
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
  SUITS.forEach(suit => board[suit] = {
    opened:false, playedRanks:[], lowestIndex:null, highestIndex:null,
    lowerBlocked:false, upperBlocked:false, closed:false, dead:false, acePlayed:false
  });
  return board;
}
function sortHand(hand) {
  const suitOrder = {diamond:0,heart:1,club:2,spade:3};
  const rankOrder = Object.fromEntries(ALL_RANKS.map((r,i)=>[r,i]));
  hand.sort((a,b)=>suitOrder[a.suit]-suitOrder[b.suit] || rankOrder[a.rank]-rankOrder[b.rank]);
}
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function publicRoomState(room) {
  return {
    roomCode: room.code,
    phase: room.phase,
    currentPlayerId: room.currentPlayerId,
    board: room.board,
    players: room.players.map(p => ({
      id:p.id, userId:p.userId, name:p.name, score:p.score,
      handCount:p.hand.length, ready:p.ready, connected:p.connected,
      isHost:p.id===room.hostPlayerId
    })),
    rankings: room.rankings,
    lastEvent: room.lastEvent
  };
}
function privatePlayerState(player) {
  return { playerId:player.id, hand:player.hand, discardedCount:player.discardedCards.length };
}
function emitState(room) {
  io.to(room.code).emit("roomState", publicRoomState(room));
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit("privateState", privatePlayerState(p));
  }
}
function dealCards(room) {
  const deck = shuffleDeck(createDeck());
  deck.forEach((card,i)=>room.players[i%4].hand.push(card));
  room.players.forEach(p=>sortHand(p.hand));
}
function playOpeningSevenDiamond(room) {
  const holder = room.players.find(p=>p.hand.some(c=>c.id==="diamond-7"));
  const idx = holder.hand.findIndex(c=>c.id==="diamond-7");
  holder.hand.splice(idx,1);
  const s = room.board.diamond;
  s.opened=true; s.lowestIndex=5; s.highestIndex=5; s.playedRanks=["7"];
  const holderIndex = room.players.findIndex(p=>p.id===holder.id);
  room.currentPlayerId = room.players[(holderIndex+1)%4].id;
  room.lastEvent = `${holder.name} opened with 7♦`;
}
function isCardPlayable(card, board) {
  const s=board[card.suit];
  if (!s || s.closed || s.dead) return false;
  if (card.rank==="A") return s.opened && (s.highestIndex===11 || s.lowestIndex===0);
  if (!s.opened) return card.rank==="7";
  const idx=SEQUENCE.indexOf(card.rank);
  return (!s.lowerBlocked && idx===s.lowestIndex-1) || (!s.upperBlocked && idx===s.highestIndex+1);
}
function updateBoardAfterPlay(room, card) {
  const s=room.board[card.suit], idx=SEQUENCE.indexOf(card.rank);
  if (!s.opened) {
    s.opened=true; s.lowestIndex=idx; s.highestIndex=idx; s.playedRanks=[card.rank]; return;
  }
  if (idx===s.lowestIndex-1) s.lowestIndex=idx;
  if (idx===s.highestIndex+1) s.highestIndex=idx;
  if (!s.playedRanks.includes(card.rank)) {
    s.playedRanks.push(card.rank);
    s.playedRanks.sort((a,b)=>SEQUENCE.indexOf(a)-SEQUENCE.indexOf(b));
  }
}
function wasDiscarded(room,suit,rank){ return room.discardedCardIds.has(`${suit}-${rank}`); }
function refreshBlockedPaths(room,suit){
  const s=room.board[suit];
  if(!s.opened||s.closed||s.dead) return;
  if(!s.lowerBlocked&&s.lowestIndex>0&&wasDiscarded(room,suit,SEQUENCE[s.lowestIndex-1])) s.lowerBlocked=true;
  if(!s.upperBlocked&&s.highestIndex<11&&wasDiscarded(room,suit,SEQUENCE[s.highestIndex+1])) s.upperBlocked=true;
}
function discardToPlayer(room,p,card){
  p.discardedCards.push(card); p.score+=card.value; room.discardedCardIds.add(card.id);
}
function autoDiscardEntireSuit(room,suit){
  for(const p of room.players){
    const keep=[];
    for(const c of p.hand){ if(c.suit===suit) discardToPlayer(room,p,c); else keep.push(c); }
    p.hand=keep;
  }
}
function closeSuit(room,suit){
  const s=room.board[suit]; s.closed=true; s.acePlayed=true; autoDiscardEntireSuit(room,suit);
}
function calculateRanking(players){
  const sorted=[...players].sort((a,b)=>a.score-b.score);
  let prevScore=null, prevRank=0;
  return sorted.map((p,i)=>{
    let rank=i+1;
    if(p.score===prevScore) rank=prevRank;
    prevScore=p.score; prevRank=rank;
    return {playerId:p.id,userId:p.userId,name:p.name,score:p.score,rank};
  });
}
function calculateEloDeltas(players, rankings) {
  const K = 32;
  const ratingByUser = Object.fromEntries(players.map(p=>[p.userId,p.ratingAtStart]));
  const rankByUser = Object.fromEntries(rankings.map(r=>[r.userId,r.rank]));
  const raw = {};

  for (const p of players) {
    let sum = 0;
    for (const q of players) {
      if (p.userId === q.userId) continue;
      const rp = ratingByUser[p.userId], rq = ratingByUser[q.userId];
      const expected = 1 / (1 + Math.pow(10, (rq-rp)/400));
      const actual = rankByUser[p.userId] < rankByUser[q.userId] ? 1 :
                     rankByUser[p.userId] > rankByUser[q.userId] ? 0 : 0.5;
      sum += actual - expected;
    }
    raw[p.userId] = K * (sum / 3);
  }

  const rounded = Object.fromEntries(Object.entries(raw).map(([id,v])=>[id,Math.round(v)]));
  const total = Object.values(rounded).reduce((a,b)=>a+b,0);
  if (total !== 0) {
    const winner = rankings[0].userId;
    rounded[winner] -= total;
  }
  return rounded;
}
async function persistMatch(room) {
  if (room.persisted) return;
  room.persisted = true;

  const rankings = calculateRanking(room.players);
  const deltas = calculateEloDeltas(room.players, rankings);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const matchRes = await client.query(
      `INSERT INTO matches(room_code) VALUES($1) RETURNING id`,
      [room.code]
    );
    const matchId = matchRes.rows[0].id;

    for (const r of rankings) {
      const p = room.players.find(x=>x.userId===r.userId);
      const before = p.ratingAtStart;
      const delta = deltas[p.userId] || 0;
      const after = Math.max(0, before + delta);

      await client.query(
        `INSERT INTO match_players
         (match_id,user_id,final_rank,discard_score,rating_before,rating_after,rating_delta)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [matchId,p.userId,r.rank,r.score,before,after,delta]
      );

      await client.query(
        `UPDATE users
         SET rating=$1,
             games_played=games_played+1,
             wins=wins+$2,
             podiums=podiums+$3
         WHERE id=$4`,
        [after, r.rank===1 ? 1 : 0, r.rank<=3 ? 1 : 0, p.userId]
      );

      r.ratingBefore = before;
      r.ratingAfter = after;
      r.ratingDelta = delta;
      r.tier = tierForRating(after);
    }

    await client.query("COMMIT");
    room.rankings = rankings;
  } catch (err) {
    await client.query("ROLLBACK");
    room.persisted = false;
    throw err;
  } finally {
    client.release();
  }
}
async function finishIfNeeded(room){
  if(room.players.every(p=>p.hand.length===0)){
    room.phase="finished"; room.currentPlayerId=null;
    room.rankings=calculateRanking(room.players);
    room.lastEvent="Game finished";
    await persistMatch(room);
    return true;
  }
  return false;
}
async function advanceTurn(room){
  if(await finishIfNeeded(room)) return;
  const cur=room.players.findIndex(p=>p.id===room.currentPlayerId);
  let next=cur;
  do { next=(next+1)%room.players.length; } while(room.players[next].hand.length===0);
  room.currentPlayerId=room.players[next].id;
}
function resetGameData(room){
  room.phase="lobby"; room.currentPlayerId=null; room.board=createBoard();
  room.discardedCardIds=new Set(); room.rankings=null; room.persisted=false;
  room.lastEvent="Waiting in lobby";
  room.players.forEach(p=>{p.hand=[];p.discardedCards=[];p.score=0;p.ready=false;});
}
async function startMatch(room){
  const ids=room.players.map(p=>p.userId);
  const {rows}=await pool.query(
    `SELECT id,rating FROM users WHERE id = ANY($1::bigint[])`, [ids]
  );
  const ratings=Object.fromEntries(rows.map(r=>[String(r.id),r.rating]));
  room.players.forEach(p=>{
    p.hand=[]; p.discardedCards=[]; p.score=0;
    p.ratingAtStart=ratings[p.userId] ?? 1000;
  });
  room.board=createBoard(); room.discardedCardIds=new Set(); room.rankings=null;
  room.persisted=false; room.phase="playing";
  dealCards(room); playOpeningSevenDiamond(room);
}
function makePlayer(user,socket){
  return {
    id:`p_${user.id}`, userId:String(user.id), socketId:socket.id, name:user.username,
    hand:[],discardedCards:[],score:0,ready:false,connected:true,ratingAtStart:user.rating
  };
}

function parseCookieHeader(header="") {
  const out = {};
  header.split(";").forEach(part => {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0,idx).trim()] = decodeURIComponent(part.slice(idx+1).trim());
  });
  return out;
}

io.use(async (socket, next) => {
  try {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie || "");
    const payload = verifyToken(cookies.seven_token);
    if (!payload) return next(new Error("unauthorized"));
    const user = await getUserById(payload.userId);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

io.on("connection", socket => {
  const user = socket.data.user;

  socket.on("resumeRoom", () => {
    const code = userActiveRoom.get(user.id);
    const room = code ? rooms.get(code) : null;
    if (!room) return socket.emit("noActiveRoom");

    const player = room.players.find(p=>p.userId===user.id);
    if (!player) return socket.emit("noActiveRoom");

    player.socketId=socket.id; player.connected=true;
    socket.data.roomCode=code; socket.join(code);
    socket.emit("joined",{roomCode:code,playerId:player.id,resumed:true});
    emitState(room);
  });

  socket.on("createRoom", () => {
    if (userActiveRoom.has(user.id)) return socket.emit("errorMessage","You already have an active room.");
    const code=generateRoomCode();
    const player=makePlayer(user,socket);
    const room={
      code,phase:"lobby",hostPlayerId:player.id,players:[player],currentPlayerId:null,
      board:createBoard(),discardedCardIds:new Set(),rankings:null,persisted:false,
      lastEvent:`${player.name} created the room`
    };
    rooms.set(code,room); userActiveRoom.set(user.id,code);
    socket.data.roomCode=code; socket.join(code);
    socket.emit("joined",{roomCode:code,playerId:player.id});
    emitState(room);
  });

  socket.on("joinRoom", ({roomCode}) => {
    const code=String(roomCode||"").trim().toUpperCase();
    const room=rooms.get(code);
    if(!room) return socket.emit("errorMessage","Room not found.");
    if(room.phase!=="lobby") return socket.emit("errorMessage","Game already started.");
    if(room.players.length>=4) return socket.emit("errorMessage","Room is full.");
    if(userActiveRoom.has(user.id)) return socket.emit("errorMessage","You already have an active room.");
    if(room.players.some(p=>p.userId===user.id)) return socket.emit("errorMessage","You are already in this room.");

    const player=makePlayer(user,socket);
    room.players.push(player); room.lastEvent=`${player.name} joined the room`;
    userActiveRoom.set(user.id,code);
    socket.data.roomCode=code; socket.join(code);
    socket.emit("joined",{roomCode:code,playerId:player.id});
    emitState(room);
  });

  socket.on("toggleReady",()=>{
    const room=rooms.get(socket.data.roomCode); if(!room||room.phase!=="lobby") return;
    const p=room.players.find(x=>x.userId===user.id); if(!p) return;
    p.ready=!p.ready; emitState(room);
  });

  socket.on("startMatch",async()=>{
    try {
      const room=rooms.get(socket.data.roomCode); if(!room||room.phase!=="lobby") return;
      const p=room.players.find(x=>x.userId===user.id);
      if(!p||p.id!==room.hostPlayerId) return socket.emit("errorMessage","Only host can start.");
      if(room.players.length!==4) return socket.emit("errorMessage","Exactly 4 players required.");
      if(!room.players.every(x=>x.ready&&x.connected)) return socket.emit("errorMessage","All 4 connected players must be ready.");
      await startMatch(room); emitState(room);
    } catch(err){ console.error(err); socket.emit("errorMessage","Could not start match."); }
  });

  socket.on("playCard",async({cardId})=>{
    try{
      const room=rooms.get(socket.data.roomCode); if(!room||room.phase!=="playing") return;
      const p=room.players.find(x=>x.userId===user.id); if(!p) return;
      if(room.currentPlayerId!==p.id) return socket.emit("errorMessage","Not your turn.");
      const idx=p.hand.findIndex(c=>c.id===cardId); if(idx<0) return;
      const card=p.hand[idx];
      if(!isCardPlayable(card,room.board)) return socket.emit("errorMessage","That card cannot be played.");
      p.hand.splice(idx,1);
      if(card.rank==="A"){ closeSuit(room,card.suit); room.lastEvent=`${p.name} closed ${card.suit}`; }
      else { updateBoardAfterPlay(room,card); refreshBlockedPaths(room,card.suit); room.lastEvent=`${p.name} played ${card.rank}${SUIT_SYMBOLS[card.suit]}`; }
      await advanceTurn(room); emitState(room);
    }catch(err){console.error(err); socket.emit("errorMessage","Action failed.");}
  });

  socket.on("discardCard",async({cardId})=>{
    try{
      const room=rooms.get(socket.data.roomCode); if(!room||room.phase!=="playing") return;
      const p=room.players.find(x=>x.userId===user.id); if(!p) return;
      if(room.currentPlayerId!==p.id) return socket.emit("errorMessage","Not your turn.");
      const idx=p.hand.findIndex(c=>c.id===cardId); if(idx<0) return;
      const card=p.hand[idx]; p.hand.splice(idx,1); discardToPlayer(room,p,card);
      const s=room.board[card.suit];
      if(card.rank==="7"&&!s.opened){s.dead=true;autoDiscardEntireSuit(room,card.suit);}
      else refreshBlockedPaths(room,card.suit);
      room.lastEvent=`${p.name} discarded a hidden card`;
      await advanceTurn(room); emitState(room);
    }catch(err){console.error(err); socket.emit("errorMessage","Action failed.");}
  });

  socket.on("restartRoom",()=>{
    const room=rooms.get(socket.data.roomCode); if(!room) return;
    const p=room.players.find(x=>x.userId===user.id);
    if(!p||p.id!==room.hostPlayerId) return;
    resetGameData(room); emitState(room);
  });

  socket.on("leaveRoom",()=>{
    const room=rooms.get(socket.data.roomCode); if(!room||room.phase==="playing") return;
    const idx=room.players.findIndex(p=>p.userId===user.id); if(idx<0) return;
    const wasHost=room.players[idx].id===room.hostPlayerId;
    room.players.splice(idx,1); userActiveRoom.delete(user.id); socket.leave(room.code); socket.data.roomCode=null;
    if(room.players.length===0){rooms.delete(room.code);}
    else {
      if(wasHost) room.hostPlayerId=room.players[0].id;
      emitState(room);
    }
    socket.emit("leftRoom");
  });

  socket.on("disconnect",()=>{
    const code=userActiveRoom.get(user.id), room=code?rooms.get(code):null;
    if(!room) return;
    const p=room.players.find(x=>x.userId===user.id);
    if(p){p.connected=false;p.socketId=null;room.lastEvent=`${p.name} disconnected`;emitState(room);}
  });
});

initDb()
  .then(()=>server.listen(PORT,()=>console.log(`Seven v2 running on port ${PORT}`)))
  .catch(err=>{console.error("Database init failed:",err);process.exit(1);});
