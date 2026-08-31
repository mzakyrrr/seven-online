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
const quickQueues = { casual: [], ranked: [] };

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

    ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 5000;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS gems INTEGER NOT NULL DEFAULT 250;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS shards INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS equipped_deck_slug TEXT NOT NULL DEFAULT 'classic';

    CREATE TABLE IF NOT EXISTS matches (
      id BIGSERIAL PRIMARY KEY,
      room_code VARCHAR(8),
      played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE matches ADD COLUMN IF NOT EXISTS match_type TEXT NOT NULL DEFAULT 'ranked';

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

    CREATE TABLE IF NOT EXISTS cosmetics (
      id BIGSERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'deck',
      rarity TEXT NOT NULL,
      coin_price INTEGER,
      gem_price INTEGER,
      shard_value INTEGER NOT NULL DEFAULT 10,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      card_back_bg TEXT NOT NULL,
      card_back_accent TEXT NOT NULL,
      card_face_bg TEXT NOT NULL,
      card_face_accent TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_cosmetics (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cosmetic_id BIGINT NOT NULL REFERENCES cosmetics(id) ON DELETE CASCADE,
      obtained_via TEXT NOT NULL,
      obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, cosmetic_id)
    );

    CREATE TABLE IF NOT EXISTS economy_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      currency TEXT,
      amount INTEGER NOT NULL DEFAULT 0,
      cosmetic_id BIGINT REFERENCES cosmetics(id) ON DELETE SET NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_match_players_user_id ON match_players(user_id);
    CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at DESC);

    INSERT INTO cosmetics
      (slug,name,type,rarity,coin_price,gem_price,shard_value,card_back_bg,card_back_accent,card_face_bg,card_face_accent)
    VALUES
      ('classic','Classic Seven','deck','Common',0,0,5,'#263c32','#edd89a','#fffdf8','#181818'),
      ('midnight','Midnight Black','deck','Common',2500,50,10,'#111111','#6f7cff','#f3f3f3','#111111'),
      ('crimson','Crimson Club','deck','Rare',7500,120,25,'#2b0e13','#ff6378','#fff8f3','#a32035'),
      ('royal-gold','Royal Gold','deck','Epic',18000,250,75,'#19130a','#d8ad4a','#fffaf0','#9b6d12'),
      ('neon-tokyo','Neon Tokyo','deck','Legendary',40000,500,200,'#0b0712','#ff4fd8','#110f1c','#66f6ff'),
      ('seven-void','Seven Void','deck','Mythic',80000,900,500,'#030307','#8a5cff','#080812','#d9c8ff')
    ON CONFLICT (slug) DO NOTHING;

    INSERT INTO user_cosmetics(user_id, cosmetic_id, obtained_via)
    SELECT u.id, c.id, 'starter'
    FROM users u CROSS JOIN cosmetics c
    WHERE c.slug='classic'
    ON CONFLICT DO NOTHING;
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
    `SELECT id, username, rating, games_played, wins, podiums, coins, gems, shards, equipped_deck_slug, created_at
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
    res.json({ status: "ok", app: "seven-online-v4", database: "connected" });
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
       RETURNING id, username, rating, games_played, wins, podiums, coins, gems, shards, equipped_deck_slug, created_at`,
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
      coins: userRow.coins,
      gems: userRow.gems,
      shards: userRow.shards,
      equipped_deck_slug: userRow.equipped_deck_slug,
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
      m.match_type,
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
      matchType: r.match_type || 'ranked',
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


const LOOT_WEIGHTS=[['Common',55],['Rare',27],['Epic',12],['Legendary',5],['Mythic',1]];
function weightedRarity(){const x=Math.random()*100;let a=0;for(const [r,w] of LOOT_WEIGHTS){a+=w;if(x<a)return r}return 'Common'}

app.get('/api/shop',authMiddleware,async(req,res)=>{const {rows}=await pool.query(`SELECT c.*, uc.user_id IS NOT NULL AS owned FROM cosmetics c LEFT JOIN user_cosmetics uc ON uc.cosmetic_id=c.id AND uc.user_id=$1 WHERE c.is_active=true ORDER BY CASE c.rarity WHEN 'Common' THEN 1 WHEN 'Rare' THEN 2 WHEN 'Epic' THEN 3 WHEN 'Legendary' THEN 4 WHEN 'Mythic' THEN 5 ELSE 6 END,c.id`,[req.auth.userId]);res.json({cosmetics:rows})});
app.get('/api/collection',authMiddleware,async(req,res)=>{const {rows}=await pool.query(`SELECT c.*,uc.obtained_via,uc.obtained_at FROM user_cosmetics uc JOIN cosmetics c ON c.id=uc.cosmetic_id WHERE uc.user_id=$1 ORDER BY uc.obtained_at DESC`,[req.auth.userId]);res.json({collection:rows})});
app.post('/api/shop/buy',authMiddleware,async(req,res)=>{const slug=String(req.body.slug||''),currency=String(req.body.currency||'');if(!['coins','gems'].includes(currency))return res.status(400).json({error:'Invalid currency.'});const c=await pool.connect();try{await c.query('BEGIN');const u=(await c.query(`SELECT coins,gems FROM users WHERE id=$1 FOR UPDATE`,[req.auth.userId])).rows[0];const item=(await c.query(`SELECT * FROM cosmetics WHERE slug=$1 AND is_active=true`,[slug])).rows[0];if(!item)throw Object.assign(new Error('Cosmetic not found.'),{status:404});if((await c.query(`SELECT 1 FROM user_cosmetics WHERE user_id=$1 AND cosmetic_id=$2`,[req.auth.userId,item.id])).rowCount)throw Object.assign(new Error('You already own this deck.'),{status:409});const price=currency==='coins'?item.coin_price:item.gem_price;if(u[currency]<price)throw Object.assign(new Error(`Not enough ${currency}.`),{status:400});await c.query(`UPDATE users SET ${currency}=${currency}-$1 WHERE id=$2`,[price,req.auth.userId]);await c.query(`INSERT INTO user_cosmetics(user_id,cosmetic_id,obtained_via) VALUES($1,$2,$3)`,[req.auth.userId,item.id,`direct_${currency}`]);await c.query(`INSERT INTO economy_transactions(user_id,kind,currency,amount,cosmetic_id) VALUES($1,'direct_purchase',$2,$3,$4)`,[req.auth.userId,currency,-price,item.id]);await c.query('COMMIT');res.json({ok:true,cosmetic:item,user:await getUserById(req.auth.userId)})}catch(e){await c.query('ROLLBACK');res.status(e.status||500).json({error:e.message||'Purchase failed.'})}finally{c.release()}});
app.post('/api/shop/lootbox',authMiddleware,async(req,res)=>{const currency=String(req.body.currency||'');if(!['coins','gems'].includes(currency))return res.status(400).json({error:'Invalid currency.'});const cost=currency==='coins'?2000:40,c=await pool.connect();try{await c.query('BEGIN');const u=(await c.query(`SELECT coins,gems FROM users WHERE id=$1 FOR UPDATE`,[req.auth.userId])).rows[0];if(u[currency]<cost)throw Object.assign(new Error(`Not enough ${currency}.`),{status:400});await c.query(`UPDATE users SET ${currency}=${currency}-$1 WHERE id=$2`,[cost,req.auth.userId]);const rarity=weightedRarity();let item=(await c.query(`SELECT * FROM cosmetics WHERE rarity=$1 AND is_active=true ORDER BY random() LIMIT 1`,[rarity])).rows[0];if(!item)item=(await c.query(`SELECT * FROM cosmetics WHERE is_active=true ORDER BY random() LIMIT 1`)).rows[0];const dup=(await c.query(`SELECT 1 FROM user_cosmetics WHERE user_id=$1 AND cosmetic_id=$2`,[req.auth.userId,item.id])).rowCount>0;let shardsGained=0;if(dup){shardsGained=item.shard_value;await c.query(`UPDATE users SET shards=shards+$1 WHERE id=$2`,[shardsGained,req.auth.userId])}else await c.query(`INSERT INTO user_cosmetics(user_id,cosmetic_id,obtained_via) VALUES($1,$2,$3)`,[req.auth.userId,item.id,`lootbox_${currency}`]);await c.query(`INSERT INTO economy_transactions(user_id,kind,currency,amount,cosmetic_id,metadata) VALUES($1,'lootbox',$2,$3,$4,$5::jsonb)`,[req.auth.userId,currency,-cost,item.id,JSON.stringify({rarity,duplicate:dup,shardsGained})]);await c.query('COMMIT');res.json({cosmetic:item,duplicate:dup,shardsGained,user:await getUserById(req.auth.userId)})}catch(e){await c.query('ROLLBACK');res.status(e.status||500).json({error:e.message||'Lootbox failed.'})}finally{c.release()}});
app.post('/api/collection/equip',authMiddleware,async(req,res)=>{const slug=String(req.body.slug||'');if(!(await pool.query(`SELECT 1 FROM user_cosmetics uc JOIN cosmetics c ON c.id=uc.cosmetic_id WHERE uc.user_id=$1 AND c.slug=$2`,[req.auth.userId,slug])).rowCount)return res.status(403).json({error:'You do not own this deck.'});await pool.query(`UPDATE users SET equipped_deck_slug=$1 WHERE id=$2`,[slug,req.auth.userId]);res.json({ok:true,user:await getUserById(req.auth.userId)})});

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
    opened:false, playedRanks:[], playedCards:[], lowestIndex:null, highestIndex:null,
    lowerBlocked:false, upperBlocked:false, closed:false, dead:false, acePlayed:false, aceCard:null
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
    matchType: room.matchType || 'casual',
    isPrivate: !!room.isPrivate,
    phase: room.phase,
    currentPlayerId: room.currentPlayerId,
    board: room.board,
    players: room.players.map(p => ({
      id:p.id, userId:p.userId, name:p.name, discardCount:p.discardedCards.length,
      handCount:p.hand.length, ready:p.ready, connected:p.connected,
      isHost:p.id===room.hostPlayerId,
      isBot:!!p.isBot,
      isTemporaryBot:!!p.isTemporaryBot,
      deckSlug:p.deckSlug||'classic'
    })),
    rankings: room.rankings,
    lastEvent: room.lastEvent,
    chatMessages: room.chatMessages || []
  };
}
function privatePlayerState(player) {
  return { playerId:player.id, hand:player.hand, discardedCount:player.discardedCards.length, discardScore:player.score };
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
  s.opened=true; s.lowestIndex=5; s.highestIndex=5; s.playedRanks=["7"]; s.playedCards=[{rank:"7",playerId:holder.id,playerName:holder.name,deckSlug:holder.deckSlug||"classic"}];
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
function updateBoardAfterPlay(room, card, player) {
  const s=room.board[card.suit], idx=SEQUENCE.indexOf(card.rank);
  if (!s.opened) {
    s.opened=true; s.lowestIndex=idx; s.highestIndex=idx; s.playedRanks=[card.rank]; s.playedCards=[{rank:card.rank,playerId:player.id,playerName:player.name,deckSlug:player.deckSlug||"classic"}]; return;
  }
  if (idx===s.lowestIndex-1) s.lowestIndex=idx;
  if (idx===s.highestIndex+1) s.highestIndex=idx;
  if (!s.playedRanks.includes(card.rank)) {
    s.playedRanks.push(card.rank);
    s.playedRanks.sort((a,b)=>SEQUENCE.indexOf(a)-SEQUENCE.indexOf(b));
    s.playedCards.push({rank:card.rank,playerId:player.id,playerName:player.name,deckSlug:player.deckSlug||"classic"});
    s.playedCards.sort((a,b)=>SEQUENCE.indexOf(a.rank)-SEQUENCE.indexOf(b.rank));
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
function closeSuit(room,suit,player){
  const s=room.board[suit]; s.closed=true; s.acePlayed=true; s.aceCard={rank:"A",playerId:player.id,playerName:player.name,deckSlug:player.deckSlug||"classic"}; autoDiscardEntireSuit(room,suit);
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
  const isRanked = room.matchType === "ranked";
  const deltas = isRanked ? calculateEloDeltas(room.players, rankings) : Object.fromEntries(room.players.map(p => [p.userId, 0]));
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const matchRes = await client.query(
      `INSERT INTO matches(room_code, match_type) VALUES($1,$2) RETURNING id`,
      [room.code, room.matchType || "casual"]
    );
    const matchId = matchRes.rows[0].id;
    const pendingForfeitIds = room.pendingForfeits ? new Set([...room.pendingForfeits].map(String)) : new Set();

    for (const r of rankings) {
      const p = room.players.find(x=>x.userId===r.userId);
      const before = p.ratingAtStart;
      const delta = deltas[p.userId] || 0;
      let after = Math.max(0, before + delta);
      const forfeited = pendingForfeitIds.has(String(p.userId));
      const forfeitRatingPenalty = forfeited && room.matchType === "ranked" ? 40 : 0;
      const forfeitCoinPenalty = 0;
      after = Math.max(0, after - forfeitRatingPenalty);

      await client.query(
        `INSERT INTO match_players
         (match_id,user_id,final_rank,discard_score,rating_before,rating_after,rating_delta)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [matchId,p.userId,r.rank,r.score,before,after,delta]
      );

      const rankedRewards = {1:80,2:55,3:35,4:20};
      const casualRewards = {1:40,2:25,3:15,4:10};
      const coinReward = (isRanked ? rankedRewards : casualRewards)[r.rank] || 10;

      await client.query(
        `UPDATE users
         SET rating=$1, games_played=games_played+1, wins=wins+$2, podiums=podiums+$3, coins=coins+$4
         WHERE id=$5`,
        [after,r.rank===1?1:0,r.rank<=3?1:0,coinReward,p.userId]
      );
      await client.query(
        `INSERT INTO economy_transactions(user_id,kind,currency,amount,metadata)
         VALUES($1,'match_reward','coins',$2,$3::jsonb)`,
        [p.userId,coinReward,JSON.stringify({matchId:String(matchId),finalRank:r.rank,matchType:room.matchType})]
      );

      r.coinReward = coinReward;
      r.ratingBefore = before;
      r.ratingAfter = after;
      r.ratingDelta = delta - forfeitRatingPenalty;
      r.forfeitPenalty = { rating: forfeitRatingPenalty, coins: forfeitCoinPenalty };
      r.tier = tierForRating(after);
      r.matchType = room.matchType;
    }

    await client.query("COMMIT");
    room.rankings = rankings;
    for (const rp of room.players) {
      const uid = rp.userId || rp.originalUserId;
      if (uid) userActiveRoom.delete(String(uid));
    }
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
    if (room.matchType !== "practice") await persistMatch(room);
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
  const ids=room.players.map(p=>p.userId).filter(Boolean);
  const {rows}=ids.length ? await pool.query(
    `SELECT id,rating,equipped_deck_slug FROM users WHERE id = ANY($1::bigint[])`, [ids]
  ) : {rows:[]};

  const usersById=Object.fromEntries(rows.map(r=>[String(r.id),r]));

  room.players.forEach(p=>{
    p.hand=[]; p.discardedCards=[]; p.score=0;

    if(p.userId && usersById[p.userId]){
      p.ratingAtStart=usersById[p.userId].rating ?? 1000;
      p.deckSlug=usersById[p.userId].equipped_deck_slug || "classic";
    }else{
      p.ratingAtStart=p.ratingAtStart ?? 1000;
      p.deckSlug=p.deckSlug || "classic";
    }
  });
  room.board=createBoard(); room.discardedCardIds=new Set(); room.rankings=null;
  room.persisted=false; room.phase="playing";
  dealCards(room); playOpeningSevenDiamond(room);
}
function makePlayer(user,socket){
  return {
    id:`p_${user.id}`, userId:String(user.id), socketId:socket.id, name:user.username,
    hand:[],discardedCards:[],score:0,ready:false,connected:true,ratingAtStart:user.rating,deckSlug:user.equipped_deck_slug||'classic'
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


function removeFromQueues(userId) {
  for (const mode of ["casual","ranked"]) {
    quickQueues[mode] = quickQueues[mode].filter(e => e.userId !== userId);
  }
}
function queueStatusFor(userId) {
  for (const mode of ["casual","ranked"]) {
    const idx = quickQueues[mode].findIndex(e => e.userId === userId);
    if (idx >= 0) return { mode, position: idx + 1, waiting: quickQueues[mode].length };
  }
  return null;
}
function rankedRange(waitMs) {
  if (waitMs < 15000) return 150;
  if (waitMs < 30000) return 300;
  return Infinity;
}
function emitQueueStatuses(mode) {
  quickQueues[mode].forEach((entry, idx) => {
    io.to(entry.socketId).emit("queueStatus", { mode, position: idx + 1, waiting: quickQueues[mode].length });
  });
}
function canFormRankedGroup(group) {
  const oldest = Math.min(...group.map(x=>x.joinedAt));
  const range = rankedRange(Date.now() - oldest);
  if (!Number.isFinite(range)) return true;
  const ratings = group.map(x=>x.rating);
  return Math.max(...ratings) - Math.min(...ratings) <= range * 2;
}
async function createQuickMatch(entries, mode) {
  const code = generateRoomCode();
  const players = [];
  for (const entry of entries) {
    const sock = io.sockets.sockets.get(entry.socketId);
    if (!sock || !sock.connected) continue;
    const freshUser = await getUserById(entry.userId);
    if (!freshUser) continue;
    const player = makePlayer(freshUser, sock);
    players.push(player);
    userActiveRoom.set(freshUser.id, code);
    sock.data.roomCode = code;
    sock.join(code);
    sock.emit("joined", { roomCode:code, playerId:player.id, quick:true, matchType:mode });
  }
  if (players.length !== 4) {
    for (const p of players) userActiveRoom.delete(p.userId);
    return false;
  }
  const room = {
    code, phase:"lobby", hostPlayerId:players[0].id, players, currentPlayerId:null,
    board:createBoard(), discardedCardIds:new Set(), rankings:null, persisted:false,
      pendingForfeits:new Set(),
    matchType:mode, isPrivate:false, chatMessages:[], lastEvent:`${mode === "ranked" ? "Ranked" : "Casual"} match found`
  };
  rooms.set(code, room);
  await startMatch(room);
  room.lastEvent = `${mode === "ranked" ? "Ranked" : "Casual"} match started`;
  emitState(room);
  return true;
}
async function tryMatchQueue(mode) {
  const queue = quickQueues[mode];
  for (let i=0; i<=queue.length-4; i++) {
    for (let j=i+1; j<=queue.length-3; j++) {
      for (let k=j+1; k<=queue.length-2; k++) {
        for (let l=k+1; l<=queue.length-1; l++) {
          const group=[queue[i],queue[j],queue[k],queue[l]];
          if (mode === "ranked" && !canFormRankedGroup(group)) continue;
          const ids = new Set(group.map(x=>x.userId));
          quickQueues[mode] = quickQueues[mode].filter(x=>!ids.has(x.userId));
          const ok = await createQuickMatch(group, mode);
          emitQueueStatuses(mode);
          return ok;
        }
      }
    }
  }
  emitQueueStatuses(mode);
  return false;
}
setInterval(() => {
  tryMatchQueue("ranked").catch(console.error);
  tryMatchQueue("casual").catch(console.error);
}, 3000);


const BOT_NAMES = ["Nova", "Mika", "Orion", "Rin", "Atlas", "Kiro", "Luna", "Vale"];

function createBotPlayer(index) {
  return {
    id: `bot_${Date.now()}_${index}_${Math.random().toString(36).slice(2,6)}`,
    userId: null,
    socketId: null,
    name: BOT_NAMES[(index + Math.floor(Math.random()*BOT_NAMES.length)) % BOT_NAMES.length],
    hand: [],
    discardedCards: [],
    score: 0,
    ready: true,
    connected: true,
    ratingAtStart: 1000,
    deckSlug: ["classic","midnight","crimson","royal-gold","neon-tokyo"][index % 5],
    isBot: true
  };
}

function botOwnSuitStats(bot, suit) {
  const cards = bot.hand.filter(c => c.suit === suit);
  return {
    count: cards.length,
    totalValue: cards.reduce((s,c)=>s+c.value,0),
    ranks: new Set(cards.map(c=>c.rank))
  };
}

function frontierInfo(room, suit) {
  const s = room.board[suit];
  if (!s.opened || s.closed || s.dead) return null;
  return {
    lowerRank: (!s.lowerBlocked && s.lowestIndex > 0) ? SEQUENCE[s.lowestIndex - 1] : null,
    upperRank: (!s.upperBlocked && s.highestIndex < 11) ? SEQUENCE[s.highestIndex + 1] : null
  };
}

function scorePlayableForBot(room, bot, card) {
  const s = room.board[card.suit];
  const own = botOwnSuitStats(bot, card.suit);

  // Ace: closing is good if bot has few remaining cards of that suit.
  if (card.rank === "A") {
    const ownRemainingPenalty = own.totalValue - 11;
    return 55 - ownRemainingPenalty * 1.5;
  }

  // Opening a suit with 7 is better if bot controls adjacent continuation cards.
  if (!s.opened && card.rank === "7") {
    let score = 22;
    if (own.ranks.has("6")) score += 10;
    if (own.ranks.has("8")) score += 10;
    if (own.ranks.has("5")) score += 4;
    if (own.ranks.has("9")) score += 4;
    score -= Math.max(0, own.count - 5) * 1.5;
    return score;
  }

  const idx = SEQUENCE.indexOf(card.rank);
  let score = 18;

  // Reward a play that lets bot continue the same chain itself.
  if (idx === s.lowestIndex - 1) {
    const next = idx - 1 >= 0 ? SEQUENCE[idx - 1] : null;
    if (next && own.ranks.has(next)) score += 13;
    if (!next) score += 8; // reaching 2 enables Ace
  }
  if (idx === s.highestIndex + 1) {
    const next = idx + 1 <= 11 ? SEQUENCE[idx + 1] : null;
    if (next && own.ranks.has(next)) score += 13;
    if (!next) score += 8; // reaching K enables Ace
  }

  // Prefer unloading higher value cards, but only moderately.
  score += card.value * 0.65;

  // If playing this card would expose a frontier bot doesn't control, be a little cautious.
  const lowerNext = idx - 1 >= 0 ? SEQUENCE[idx - 1] : null;
  const upperNext = idx + 1 <= 11 ? SEQUENCE[idx + 1] : null;
  if (idx === s.lowestIndex - 1 && lowerNext && !own.ranks.has(lowerNext)) score -= 5;
  if (idx === s.highestIndex + 1 && upperNext && !own.ranks.has(upperNext)) score -= 5;

  return score;
}

function scoreDiscardForBot(room, bot, card) {
  const s = room.board[card.suit];
  const own = botOwnSuitStats(bot, card.suit);

  // Base: discarding costs points, so low-value cards are preferred.
  let score = 18 - card.value * 1.25;

  // Ace is usually valuable. Avoid discarding it unless its suit is effectively dead/closed.
  if (card.rank === "A") {
    if (s.closed || s.dead) score += 8;
    else score -= 18;
  }

  // Killing an unopened suit with 7 can be strategic, but is awful if bot holds many cards there.
  if (card.rank === "7" && !s.opened) {
    const selfDamage = own.totalValue - 7;
    score += 26 - selfDamage * 1.6;
  }

  // Strategic connector discard: if this card is exactly a current frontier, it blocks that path.
  const frontier = frontierInfo(room, card.suit);
  if (frontier) {
    if (card.rank === frontier.lowerRank || card.rank === frontier.upperRank) {
      // Reward blocking more if bot does not own many follow-up cards behind that path.
      score += 26;

      const idx = SEQUENCE.indexOf(card.rank);
      if (card.rank === frontier.lowerRank) {
        const behind = bot.hand.filter(c => c.suit===card.suit && SEQUENCE.indexOf(c.rank) < idx);
        score -= behind.reduce((s,c)=>s+c.value,0) * 0.9;
      } else {
        const behind = bot.hand.filter(c => c.suit===card.suit && SEQUENCE.indexOf(c.rank) > idx && c.rank !== "A");
        score -= behind.reduce((s,c)=>s+c.value,0) * 0.9;
      }
    }
  }

  // Discarding a card from already closed/dead suit is unavoidable, so don't overthink it.
  if (s.closed || s.dead) score += 12;

  return score;
}

function chooseBotAction(room, bot) {
  const options = [];

  for (const card of bot.hand) {
    if (isCardPlayable(card, room.board)) {
      options.push({
        type: "play",
        card,
        score: scorePlayableForBot(room, bot, card)
      });
    }

    options.push({
      type: "discard",
      card,
      score: scoreDiscardForBot(room, bot, card)
    });
  }

  // Small noise prevents perfectly deterministic behavior.
  for (const o of options) {
    o.score += (Math.random() - 0.5) * 4;
  }

  options.sort((a,b)=>b.score-a.score);
  return options[0];
}

async function performBotTurn(room) {
  if (!room || room.phase !== "playing") return;
  const bot = room.players.find(p => p.id === room.currentPlayerId);
  if (!bot || !bot.isBot) return;

  const action = chooseBotAction(room, bot);
  if (!action) return;

  const idx = bot.hand.findIndex(c => c.id === action.card.id);
  if (idx < 0) return;

  const card = bot.hand[idx];
  bot.hand.splice(idx, 1);

  if (action.type === "play") {
    if (card.rank === "A") {
      closeSuit(room, card.suit);
      room.lastEvent = `${bot.name} closed ${card.suit}`;
    } else {
      updateBoardAfterPlay(room, card);
      refreshBlockedPaths(room, card.suit);
      room.lastEvent = `${bot.name} played ${card.rank}${SUIT_SYMBOLS[card.suit]}`;
    }
  } else {
    discardToPlayer(room, bot, card);
    const s = room.board[card.suit];
    if (card.rank === "7" && !s.opened) {
      s.dead = true;
      autoDiscardEntireSuit(room, card.suit);
    } else {
      refreshBlockedPaths(room, card.suit);
    }
    room.lastEvent = `${bot.name} discarded a hidden card`;
  }

  await advanceTurn(room);
  emitState(room);
  scheduleBotTurn(room);
}

function scheduleBotTurn(room) {
  if (!room || room.phase !== "playing") return;

  clearTimeout(room.botTimer);

  const current = room.players.find(p => p.id === room.currentPlayerId);
  if (!current?.isBot) return;

  room.botTimer = setTimeout(async () => {
    try {
      // Re-check current state when the timer fires.
      if (!room || room.phase !== "playing") return;
      const stillCurrent = room.players.find(p => p.id === room.currentPlayerId);
      if (!stillCurrent?.isBot) return;

      await performBotTurn(room);
    } catch (err) {
      console.error("Bot turn failed:", err);

      // Do not leave a practice match permanently frozen if a bot action errors.
      if (room?.phase === "playing") {
        setTimeout(() => scheduleBotTurn(room), 500);
      }
    }
  }, 700 + Math.floor(Math.random()*500));
}

async function startBotPractice(room) {
  const human = room.players.find(p=>!p.isBot && p.userId);
  if(human){
    const fresh = await getUserById(human.userId);
    if(fresh) human.deckSlug = fresh.equipped_deck_slug || "classic";
  }

  room.mode = "bot";
  room.matchType = "practice";
  room.phase = "playing";
  room.board = createBoard();
  room.discardedCardIds = new Set();
  room.rankings = null;
  room.persisted = true; // practice games are not written to ranked/casual history
  room.lastEvent = "Practice game started";

  room.players.forEach(p => {
    p.hand = [];
    p.discardedCards = [];
    p.score = 0;
    p.ready = true;
  });

  dealCards(room);
  playOpeningSevenDiamond(room);
  scheduleBotTurn(room);
}


function makeTemporaryBotFromPlayer(player) {
  return {
    ...player,
    socketId: null,
    connected: true,
    isBot: true,
    isTemporaryBot: true,
    originalUserId: player.userId,
    originalName: player.name,
    name: `${player.name} [BOT]`
  };
}

function restoreHumanSeat(room, user, socket) {
  const uid = String(user.id);
  const idx = room.players.findIndex(p => String(p.userId) === uid || String(p.originalUserId) === uid);
  if (idx < 0) return null;

  const seat = room.players[idx];
  const restored = {
    ...seat,
    socketId: socket.id,
    connected: true,
    isBot: false,
    isTemporaryBot: false,
    userId: uid,
    originalUserId: null,
    name: seat.originalName || user.username
  };
  room.players[idx] = restored;
  room.pendingForfeits?.delete(uid);
  room.lastEvent = `${restored.name} reconnected`;
  return restored;
}

function activateTemporaryBot(room, userId) {
  const uid = String(userId);
  const idx = room.players.findIndex(p => String(p.userId) === uid);
  if (idx < 0) return null;
  const player = room.players[idx];
  if (player.isBot) return player;

  room.pendingForfeits ||= new Set();
  room.pendingForfeits.add(uid);
  const bot = makeTemporaryBotFromPlayer(player);
  room.players[idx] = bot;
  room.lastEvent = `${player.name} left. Bot took over the seat.`;
  if (room.currentPlayerId === bot.id) scheduleBotTurn(room);
  return bot;
}


function getValidActiveRoomForUser(userId) {
  const uid = String(userId);
  const code = userActiveRoom.get(uid);
  if (!code) return null;

  const room = rooms.get(code);

  // Mapping points to a room that no longer exists.
  if (!room) {
    userActiveRoom.delete(uid);
    return null;
  }

  const seat = room.players.find(p =>
    String(p.userId) === uid ||
    String(p.originalUserId) === uid
  );

  // User no longer has a seat in that room.
  if (!seat) {
    userActiveRoom.delete(uid);
    return null;
  }

  // Finished rooms must never block starting another game.
  if (room.phase === "finished") {
    userActiveRoom.delete(uid);
    return null;
  }

  return room;
}

function ensureNoBlockingActiveRoom(userId) {
  const room = getValidActiveRoomForUser(userId);
  if (!room) return { blocked:false, room:null };

  // Only an actually running match should block a new one.
  if (room.phase === "playing") {
    return { blocked:true, room };
  }

  // Old lobby/queue rooms can be abandoned safely.
  const uid = String(userId);
  const seatIndex = room.players.findIndex(p =>
    String(p.userId) === uid ||
    String(p.originalUserId) === uid
  );

  if (seatIndex >= 0) {
    const wasHost = room.players[seatIndex].id === room.hostPlayerId;
    room.players.splice(seatIndex, 1);

    if (room.players.length === 0) {
      clearTimeout(room.botTimer);
      rooms.delete(room.code);
    } else if (wasHost) {
      room.hostPlayerId = room.players[0].id;
      emitState(room);
    } else {
      emitState(room);
    }
  }

  userActiveRoom.delete(uid);
  return { blocked:false, room:null };
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
    if (!room) {
      const q = queueStatusFor(user.id);
      if (q) return socket.emit("queueStatus", q);
      return socket.emit("noActiveRoom");
    }

    const player = restoreHumanSeat(room, user, socket);
    if (!player) return socket.emit("noActiveRoom");
    socket.data.roomCode=code; socket.join(code);
    socket.emit("joined",{roomCode:code,playerId:player.id,resumed:true});
    emitState(room);
    scheduleBotTurn(room);
  });

  socket.on("quickPlay", async ({mode}) => {
    try {
      mode = String(mode || "").toLowerCase();
      if (!["casual","ranked"].includes(mode)) return socket.emit("errorMessage","Invalid matchmaking mode.");
      {
      const active = ensureNoBlockingActiveRoom(user.id);
      if (active.blocked) {
        return socket.emit("activeMatchExists", {
          roomCode: active.room.code,
          matchType: active.room.matchType || active.room.mode || "match"
        });
      }
    }
      removeFromQueues(user.id);
      quickQueues[mode].push({ userId:user.id, socketId:socket.id, joinedAt:Date.now(), rating:user.rating });
      socket.emit("queueStatus", { mode, position:quickQueues[mode].length, waiting:quickQueues[mode].length });
      await tryMatchQueue(mode);
    } catch (err) {
      console.error(err);
      socket.emit("errorMessage","Could not enter matchmaking.");
    }
  });

  socket.on("cancelQueue", () => {
    removeFromQueues(user.id);
    socket.emit("queueCancelled");
    emitQueueStatuses("casual");
    emitQueueStatuses("ranked");
  });

  
  socket.on("playBots", async () => {
    {
      const active = ensureNoBlockingActiveRoom(user.id);
      if (active.blocked) {
        return socket.emit("activeMatchExists", {
          roomCode: active.room.code,
          matchType: active.room.matchType || active.room.mode || "match"
        });
      }
    }

    const freshUser = await getUserById(user.id);
    const human = makePlayer(freshUser || user, socket);
    const bots = [createBotPlayer(0), createBotPlayer(1), createBotPlayer(2)];
    const code = `BOT${Math.random().toString(36).slice(2,7).toUpperCase()}`;

    const room = {
      code,
      phase: "lobby",
      mode: "bot",
      matchType: "practice",
      hostPlayerId: human.id,
      players: [human, ...bots],
      currentPlayerId: null,
      board: createBoard(),
      discardedCardIds: new Set(),
      rankings: null,
      persisted: true,
      lastEvent: "Preparing practice match",
      botTimer: null,
      pendingForfeits: new Set(),
      chatMessages: []
    };

    rooms.set(code, room);
    userActiveRoom.set(user.id, code);
    socket.data.roomCode = code;
    socket.join(code);
    socket.emit("joined", { roomCode: code, playerId: human.id });
    await startBotPractice(room);
    emitState(room);
  });

socket.on("createRoom", async () => {
    if (queueStatusFor(user.id)) return socket.emit("errorMessage","Cancel matchmaking first.");
    {
      const active = ensureNoBlockingActiveRoom(user.id);
      if (active.blocked) {
        return socket.emit("activeMatchExists", {
          roomCode: active.room.code,
          matchType: active.room.matchType || active.room.mode || "match"
        });
      }
    }
    const code=generateRoomCode();
    const freshUser=await getUserById(user.id);
    const player=makePlayer(freshUser||user,socket);
    const room={
      code,phase:"lobby",hostPlayerId:player.id,players:[player],currentPlayerId:null,
      board:createBoard(),discardedCardIds:new Set(),rankings:null,persisted:false,
      pendingForfeits:new Set(),
      matchType:"casual",isPrivate:true,chatMessages:[],
      lastEvent:`${player.name} created a private casual room`
    };
    rooms.set(code,room); userActiveRoom.set(user.id,code);
    socket.data.roomCode=code; socket.join(code);
    socket.emit("joined",{roomCode:code,playerId:player.id});
    emitState(room);
  });

  socket.on("joinRoom", async ({roomCode}) => {
    if (queueStatusFor(user.id)) return socket.emit("errorMessage","Cancel matchmaking first.");
    const code=String(roomCode||"").trim().toUpperCase();
    const room=rooms.get(code);
    if(!room) return socket.emit("errorMessage","Room not found.");
    if(room.phase!=="lobby") return socket.emit("errorMessage","Game already started.");
    if(!room.isPrivate) return socket.emit("errorMessage","Quick Play rooms cannot be joined by code.");
    if(room.players.length>=4) return socket.emit("errorMessage","Room is full.");
    {
      const active = ensureNoBlockingActiveRoom(user.id);
      if (active.blocked) {
        return socket.emit("activeMatchExists", {
          roomCode: active.room.code,
          matchType: active.room.matchType || active.room.mode || "match"
        });
      }
    }
    if(room.players.some(p=>p.userId===user.id)) return socket.emit("errorMessage","You are already in this room.");

    const freshUser=await getUserById(user.id);
    const player=makePlayer(freshUser||user,socket);
    room.players.push(player); room.lastEvent=`${player.name} joined the room`;
    userActiveRoom.set(user.id,code);
    socket.data.roomCode=code; socket.join(code);
    socket.emit("joined",{roomCode:code,playerId:player.id});
    emitState(room);
  });

  socket.on("toggleReady",()=>{
    const room=rooms.get(socket.data.roomCode); if(!room||room.phase==="playing") return;
    const p=room.players.find(x=>x.userId===user.id); if(!p) return;
    p.ready=!p.ready; emitState(room);
  });

  socket.on("startMatch",async()=>{
    try {
      const room=rooms.get(socket.data.roomCode); if(!room||room.phase==="playing") return;
      const p=room.players.find(x=>x.userId===user.id);
      if(!p||p.id!==room.hostPlayerId) return socket.emit("errorMessage","Only host can start.");
      if(room.players.length!==4) return socket.emit("errorMessage","Exactly 4 players required.");
      if(!room.players.every(x=>x.ready&&x.connected)) return socket.emit("errorMessage","All 4 connected players must be ready.");
      room.matchType="casual";
      await startMatch(room); emitState(room);
    } catch(err){ console.error(err); socket.emit("errorMessage","Could not start match."); }
  });

  socket.on("sendChat", ({text}) => {
    const room=rooms.get(socket.data.roomCode);
    if(!room || !["lobby","playing"].includes(room.phase)) return;
    const p=room.players.find(x=>x.userId===user.id); if(!p) return;
    const clean=String(text||"").trim().slice(0,200);
    if(!clean) return;
    room.chatMessages = room.chatMessages || [];
    room.chatMessages.push({id:`m_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,playerId:p.id,name:p.name,text:clean,createdAt:Date.now()});
    if(room.chatMessages.length>50) room.chatMessages=room.chatMessages.slice(-50);
    io.to(room.code).emit("chatMessages", room.chatMessages);
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
      if(card.rank==="A"){ closeSuit(room,card.suit,p); room.lastEvent=`${p.name} closed ${card.suit}`; }
      else { updateBoardAfterPlay(room,card,p); refreshBlockedPaths(room,card.suit); room.lastEvent=`${p.name} played ${card.rank}${SUIT_SYMBOLS[card.suit]}`; }
      await advanceTurn(room); emitState(room); scheduleBotTurn(room);
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
      await advanceTurn(room); emitState(room); scheduleBotTurn(room);
    }catch(err){console.error(err); socket.emit("errorMessage","Action failed.");}
  });

  socket.on("restartRoom",()=>{
    const room=rooms.get(socket.data.roomCode); if(!room) return;
    const p=room.players.find(x=>x.userId===user.id);
    if(!p||p.id!==room.hostPlayerId || !room.isPrivate) return;
    resetGameData(room); emitState(room);
  });

  
  socket.on("forfeitMatch",()=>{
    const room=rooms.get(socket.data.roomCode);
    if(!room || room.phase!=="playing") return;
    activateTemporaryBot(room, user.id);
    socket.leave(room.code);
    socket.data.roomCode=null;
    emitState(room);
    scheduleBotTurn(room);
    socket.emit("forfeitPending",{message:"Bot takeover active. Reconnect before match end to avoid penalty."});
  });

socket.on("leaveRoom",()=>{
    const room=rooms.get(socket.data.roomCode);
    if(!room) return;
    if(room.phase==="playing" && room.matchType!=="practice") return;

    if(room.matchType==="practice"){
      clearTimeout(room.botTimer);
      userActiveRoom.delete(user.id);
      socket.leave(room.code);
      socket.data.roomCode=null;
      rooms.delete(room.code);
      socket.emit("leftRoom");
      return;
    }
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
    if(room.phase==="playing"){
      activateTemporaryBot(room, user.id);
      emitState(room);
      scheduleBotTurn(room);
      return;
    }
    const p=room.players.find(x=>x.userId===user.id);
    if(p){p.connected=false;p.socketId=null;room.lastEvent=`${p.name} disconnected`;emitState(room);}
  });
});

initDb()
  .then(()=>server.listen(PORT,()=>console.log(`Seven v4 running on port ${PORT}`)))
  .catch(err=>{console.error("Database init failed:",err);process.exit(1);});
