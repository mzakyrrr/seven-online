const $=id=>document.getElementById(id);
const SUITS=["diamond","heart","club","spade"];
const SYMBOL={diamond:"♦",heart:"♥",club:"♣",spade:"♠"};
let authMode="login", me=null, socket=null, roomState=null, privateState=null, myPlayerId=null, actionMode="play", queueState=null;
let deckStyles={classic:{slug:"classic",card_face_bg:"#fffdf8",card_face_accent:"#181818",card_back_accent:"#edd89a"}};
let pendingDiscardCard=null;

function toast(m){$("toast").textContent=m;$("toast").classList.remove("hidden");setTimeout(()=>$("toast").classList.add("hidden"),2400)}
function esc(s){return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}
async function api(url,opts={}){
  const res=await fetch(url,{headers:{"Content-Type":"application/json",...(opts.headers||{})},...opts});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||"Request failed");
  return data;
}
function setAuthMode(mode){authMode=mode;$("loginTab").classList.toggle("active",mode==="login");$("registerTab").classList.toggle("active",mode==="register");$("authBtn").textContent=mode==="login"?"Login":"Create Account";$("authError").textContent=""}
async function authenticate(){
  try{
    const username=$("username").value.trim(), password=$("password").value;
    const data=await api(`/api/${authMode}`,{method:"POST",body:JSON.stringify({username,password})});
    me=data.user; enterApp();
  }catch(e){$("authError").textContent=e.message}
}
async function checkSession(){try{const d=await api("/api/me");me=d.user;enterApp()}catch{}}
function enterApp(){
  $("authScreen").classList.add("hidden");$("dashboard").classList.remove("hidden");$("userTop").classList.remove("hidden");
  renderProfileBits(); connectSocket(); showView("play");
}
function renderProfileBits(){
  $("userTop").textContent=`${me.username} · ${me.rating} ${me.tier}`;
  $("homeRating").textContent=me.rating;$("homeTier").textContent=me.tier;$("homeGames").textContent=me.games_played;$("homeWins").textContent=me.wins;$("homePodiums").textContent=me.podiums;$("homeCoins").textContent=(me.coins||0).toLocaleString();$("homeGems").textContent=(me.gems||0).toLocaleString();$("homeShards").textContent=(me.shards||0).toLocaleString();
  $("profileName").textContent=me.username;
  $("profileStats").innerHTML=[
    ["Rating",`${me.rating} · ${me.tier}`],["Games",me.games_played],["Wins",me.wins],["Podiums",me.podiums]
  ].map(([a,b])=>`<div class="profile-stat"><span class="muted">${a}</span><strong>${b}</strong></div>`).join("");
}
async function refreshMe(){const d=await api("/api/me");me=d.user;renderProfileBits()}
function connectSocket(){
  if(socket) socket.disconnect();
  socket=io();
  socket.on("connect",()=>socket.emit("resumeRoom"));
  socket.on("joined",d=>{myPlayerId=d.playerId;});
  socket.on("roomState",s=>{roomState=s;ensureRoomDeckStyles(s);renderPlay();});
  socket.on("privateState",s=>{privateState=s;renderPlay()});
  socket.on("leftRoom",()=>{roomState=null;privateState=null;myPlayerId=null;renderPlay()
    showView("play");
    renderPlay();});
  socket.on("queueStatus",q=>{queueState=q;renderPlay()});
  socket.on("queueCancelled",()=>{queueState=null;renderPlay()});
  socket.on("noActiveRoom",()=>{});
  socket.on("chatMessages",msgs=>{if(roomState){roomState.chatMessages=msgs;renderChat();}});
  socket.on("errorMessage",toast);
  socket.on("connect_error",()=>toast("Session expired. Please login again."));
}
function showView(view){
  ["play","leaderboard","shop","collection","history","profile"].forEach(v=>$(`${v}View`).classList.toggle("hidden",v!==view));
  document.querySelectorAll(".nav-btn[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  if(view==="leaderboard") loadLeaderboard();
  if(view==="shop") loadShop();
  if(view==="collection") loadCollection();
  if(view==="history") loadHistory();
  if(view==="profile") refreshMe();
}
function getMyPlayer(){return roomState?.players?.find(p=>p.id===myPlayerId)}
function renderPlay(){
  const inRoom=!!roomState;
  $("homeCard").classList.toggle("hidden",inRoom);
  if(!inRoom){
    $("queuePanel").classList.toggle("hidden",!queueState);
    if(queueState){
      $("queueTitle").textContent=queueState.mode==="ranked"?"Searching Ranked...":"Searching Casual...";
      $("queueInfo").textContent=`Queue: ${queueState.waiting} player(s) waiting. Ranked search range expands automatically over time.`;
    }
  }
  $("lobbyScreen").classList.add("hidden");$("gameScreen").classList.add("hidden");$("resultScreen").classList.add("hidden");
  if(!inRoom)return;
  if(roomState.phase==="lobby"){ $("lobbyScreen").classList.remove("hidden"); renderLobby(); }
  else if(roomState.phase==="playing"){ $("gameScreen").classList.remove("hidden"); renderGame(); }
  else { $("resultScreen").classList.remove("hidden"); renderResults(); refreshMe(); }
}
function renderLobby(){
  $("lobbyCode").textContent=roomState.roomCode; const wrap=$("lobbyPlayers");wrap.innerHTML="";
  roomState.players.forEach(p=>{const d=document.createElement("div");d.className=`player-item ${p.ready?"ready":""}`;d.innerHTML=`<div><strong>${esc(p.name)}</strong>${p.isHost?' <span class="muted">· Host</span>':""}${p.id===myPlayerId?' <span class="muted">· You</span>':""}</div><div class="status">${p.ready?"Ready":"Not ready"}${p.connected?"":" · Disconnected"}</div>`;wrap.appendChild(d)});
  const mine=getMyPlayer();$("readyBtn").textContent=mine?.ready?"Unready":"Ready";$("startBtn").classList.toggle("hidden",!mine?.isHost);
  const can=roomState.players.length===4&&roomState.players.every(p=>p.ready&&p.connected);$("startBtn").disabled=!can;$("lobbyMessage").textContent=roomState.players.length<4?`Waiting for ${4-roomState.players.length} more player(s).`:can?"All players ready.":"Waiting for everyone.";
}
function playable(card){
  const seq=["2","3","4","5","6","7","8","9","10","J","Q","K"],s=roomState.board[card.suit];
  if(!s||s.closed||s.dead)return false;if(card.rank==="A")return s.opened&&(s.highestIndex===11||s.lowestIndex===0);if(!s.opened)return card.rank==="7";const i=seq.indexOf(card.rank);return(!s.lowerBlocked&&i===s.lowestIndex-1)||(!s.upperBlocked&&i===s.highestIndex+1)
}
async function ensureDeckStyle(slug){
  slug=slug||"classic";
  if(deckStyles[slug]) return deckStyles[slug];
  try{const d=await api(`/api/deck-style/${encodeURIComponent(slug)}`);deckStyles[slug]=d.deck;renderPlay();return d.deck}catch{return deckStyles.classic}
}
function ensureRoomDeckStyles(state){
  for(const p of state?.players||[]) ensureDeckStyle(p.deckSlug||"classic");
}
function styleForSlug(slug){return deckStyles[slug||"classic"]||deckStyles.classic}
function cardEl(card,small=false,deckSlug="classic"){
  const style=styleForSlug(deckSlug),e=document.createElement("div");
  e.className=`card ${["diamond","heart"].includes(card.suit)?"red":""} ${small?"small":""}`;
  e.style.background=style.card_face_bg||"#fffdf8";
  e.style.borderColor=style.card_back_accent||"rgba(0,0,0,.13)";
  if(!["diamond","heart"].includes(card.suit)) e.style.color=style.card_face_accent||"#181818";
  e.innerHTML=`<div class="rank">${card.rank}${SYMBOL[card.suit]}</div><div class="suit-symbol">${SYMBOL[card.suit]}</div><div class="rank bottom">${card.rank}${SYMBOL[card.suit]}</div>`;
  return e
}
function renderChat(){
  const wrap=$("chatMessages"); if(!wrap||!roomState)return;
  const atBottom=wrap.scrollHeight-wrap.scrollTop-wrap.clientHeight<50;
  wrap.innerHTML=(roomState.chatMessages||[]).map(m=>`<div class="chat-msg ${m.playerId===myPlayerId?"mine":""}"><div class="chat-msg-name">${esc(m.name)}</div><div class="chat-msg-text">${esc(m.text)}</div></div>`).join("")||'<div class="muted">No messages yet.</div>';
  if(atBottom||!wrap.dataset.loaded){wrap.scrollTop=wrap.scrollHeight;wrap.dataset.loaded="1"}
}
function openDiscardConfirmation(card){
  pendingDiscardCard=card;
  const preview=$("discardPreview");preview.innerHTML="";
  preview.appendChild(cardEl(card,false,getMyPlayer()?.deckSlug||me?.equipped_deck_slug||"classic"));
  $("discardModal").classList.remove("hidden");
}
function closeDiscardConfirmation(){pendingDiscardCard=null;$("discardModal").classList.add("hidden")}
function renderGame(){
  const mine=getMyPlayer(), current=roomState.players.find(p=>p.id===roomState.currentPlayerId), myTurn=roomState.currentPlayerId===myPlayerId;
  $("youName").textContent=mine?.name||me.username;$("matchTypeBadge").textContent=(roomState.matchType||"casual").toUpperCase();$("turnText").textContent=current?`${current.name}'s turn`:"";$("lastEvent").textContent=roomState.lastEvent||"";
  $("actionHelp").textContent=!myTurn?"Wait for your turn.":actionMode==="play"?"Play a highlighted card, or switch to Discard.":"DISCARD MODE: choose a card, then confirm before it is discarded.";
  $("privateDiscardScore").innerHTML=`Your discard: <strong>${privateState?.discardedCount||0} card(s)</strong> · private value <strong>${privateState?.discardScore||0} pts</strong>`;
  document.querySelector(".hand-panel")?.classList.toggle("discard-active",actionMode==="discard");
  $("scoreRow").innerHTML=roomState.players.map(p=>`<div class="score-card ${p.id===roomState.currentPlayerId?"current":""} ${p.id===myPlayerId?"me":""}"><div class="score-name">${esc(p.name)}</div><div class="score-meta">${p.handCount} cards left · ${p.discardCount||0} discarded</div></div>`).join("");
  const board=$("board");board.innerHTML="";
  SUITS.forEach(suit=>{
    const st=roomState.board[suit],lane=document.createElement("div");lane.className="suit-lane";const status=st.dead?"Dead":st.closed?"Closed":st.opened?"Open":"Waiting";
    lane.innerHTML=`<div class="suit-head"><span>${SYMBOL[suit]} ${suit[0].toUpperCase()+suit.slice(1)}</span><span>${status}</span></div>`;
    const line=document.createElement("div");line.className="cards-line";
    if(!st.opened){line.innerHTML=`<div class="empty">${st.dead?"7 was discarded. Suit is dead.":"Waiting for 7"}</div>`}
    else{
      const played=(st.playedCards&&st.playedCards.length)?st.playedCards:st.playedRanks.map(rank=>({rank,deckSlug:"classic"}));
      for(const pc of played) line.appendChild(cardEl({suit,rank:pc.rank},true,pc.deckSlug||"classic"));
      if(st.acePlayed){const ac=st.aceCard||{rank:"A",deckSlug:"classic"};line.appendChild(cardEl({suit,rank:"A"},true,ac.deckSlug||"classic"))}
    }
    lane.appendChild(line);board.appendChild(lane)
  });
  const hand=$("hand");hand.innerHTML="";const myDeck=mine?.deckSlug||me?.equipped_deck_slug||"classic";ensureDeckStyle(myDeck);
  for(const c of privateState?.hand||[]){
    const e=cardEl(c,false,myDeck),can=playable(c);e.classList.add("clickable");
    if(!myTurn||actionMode==="play"&&!can)e.classList.add("disabled");if(myTurn&&actionMode==="play"&&can)e.classList.add("playable");
    e.onclick=()=>{if(!myTurn)return;if(actionMode==="play"){if(!can)return toast("That card cannot be played.");socket.emit("playCard",{cardId:c.id})}else openDiscardConfirmation(c)};
    hand.appendChild(e)
  }
  renderChat();
}
function renderResults(){
  $("ranking").innerHTML=(roomState.rankings||[]).map(r=>`<div class="result-row"><div class="result-rank">#${r.rank}</div><div><strong>${esc(r.name)}</strong><div class="muted">${r.score} discard pts · +${r.coinReward||0} Coins</div></div><div>${r.ratingAfter??""} ${r.tier??""}</div><div class="delta ${(r.ratingDelta||0)>=0?"plus":"minus"}">${roomState.matchType==="ranked"?`${(r.ratingDelta||0)>=0?"+":""}${r.ratingDelta??0}`:"Casual"}</div></div>`).join("");
  $("restartBtn").classList.toggle("hidden",!getMyPlayer()?.isHost);
}

function walletHtml(){return `<span>Coins ${(me.coins||0).toLocaleString()}</span><span>Gems ${(me.gems||0).toLocaleString()}</span><span>Shards ${(me.shards||0).toLocaleString()}</span>`}
function cosmeticPreview(c){return `<div class="cosmetic-preview" style="background:${c.card_back_bg}"><div class="cosmetic-preview-card" style="background:${c.card_face_bg};color:${c.card_face_accent};border:4px solid ${c.card_back_accent}">7</div></div>`}
async function loadShop(){try{await refreshMe();$("shopWallet").innerHTML=walletHtml();const d=await api('/api/shop');$("shopGrid").innerHTML=d.cosmetics.map(c=>`<div class="cosmetic-card">${cosmeticPreview(c)}<div class="cosmetic-title"><h3>${esc(c.name)}</h3><span class="rarity ${c.rarity}">${c.rarity}</span></div>${c.owned?'<div class="owned-badge">Owned</div>':`<div class="price-row"><button class="btn secondary buy-cosmetic" data-slug="${c.slug}" data-currency="coins">${Number(c.coin_price||0).toLocaleString()} Coins</button><button class="btn primary buy-cosmetic" data-slug="${c.slug}" data-currency="gems">${Number(c.gem_price||0).toLocaleString()} Gems</button></div>`}</div>`).join('');document.querySelectorAll('.buy-cosmetic').forEach(b=>b.onclick=async()=>{try{const d=await api('/api/shop/buy',{method:'POST',body:JSON.stringify({slug:b.dataset.slug,currency:b.dataset.currency})});me=d.user;renderProfileBits();toast(`Purchased ${d.cosmetic.name}`);loadShop()}catch(e){toast(e.message)}})}catch(e){toast(e.message)}}
async function loadCollection(){try{await refreshMe();$("collectionWallet").innerHTML=walletHtml();const d=await api('/api/collection');$("collectionGrid").innerHTML=d.collection.map(c=>`<div class="cosmetic-card">${cosmeticPreview(c)}<div class="cosmetic-title"><h3>${esc(c.name)}</h3><span class="rarity ${c.rarity}">${c.rarity}</span></div>${me.equipped_deck_slug===c.slug?'<div class="owned-badge">Equipped</div>':`<div class="price-row"><button class="btn primary equip-cosmetic" data-slug="${c.slug}">Equip Deck</button></div>`}</div>`).join('');document.querySelectorAll('.equip-cosmetic').forEach(b=>b.onclick=async()=>{try{const d=await api('/api/collection/equip',{method:'POST',body:JSON.stringify({slug:b.dataset.slug})});me=d.user;renderProfileBits();toast('Deck equipped');loadCollection()}catch(e){toast(e.message)}})}catch(e){toast(e.message)}}
async function openLootbox(currency){try{const d=await api('/api/shop/lootbox',{method:'POST',body:JSON.stringify({currency})});me=d.user;renderProfileBits();$("lootResult").classList.remove('hidden');$("lootResult").innerHTML=`<div class="eyebrow">${d.cosmetic.rarity} DROP</div><h3>${esc(d.cosmetic.name)}</h3><p>${d.duplicate?`Duplicate converted to <strong>${d.shardsGained} shards</strong>.`:'Added to Collection.'}</p>`;loadShop()}catch(e){toast(e.message)}}

async function loadLeaderboard(){try{const d=await api("/api/leaderboard");$("leaderboard").innerHTML=d.leaderboard.map(r=>`<div class="leader-row"><div class="result-rank">#${r.rank}</div><div><strong>${esc(r.username)}</strong><div class="muted">${r.tier}</div></div><div>${r.rating} rating</div><div>${r.wins} wins</div></div>`).join("")||"<p class='muted'>No ranked players yet.</p>"}catch(e){toast(e.message)}}
async function loadHistory(){try{const d=await api("/api/history");$("history").innerHTML=d.history.map(h=>`<div class="history-card"><div class="history-head"><div><strong>Rank #${h.finalRank}</strong><span class="history-type ${h.matchType}">${(h.matchType||"ranked").toUpperCase()}</span> · ${h.discardScore} pts<div class="muted">${new Date(h.playedAt).toLocaleString()}</div></div><div class="delta ${h.ratingDelta>=0?"plus":"minus"}">${h.matchType==="ranked"?`${h.ratingDelta>=0?"+":""}${h.ratingDelta} rating`:"No rating change"}</div></div><div class="history-players">${h.participants.map(p=>`<div class="history-player"><strong>#${p.finalRank} ${esc(p.username)}</strong><br>${p.discardScore} pts<br><span class="delta ${p.ratingDelta>=0?"plus":"minus"}">${p.ratingDelta>=0?"+":""}${p.ratingDelta}</span></div>`).join("")}</div></div>`).join("")||"<p class='muted'>No matches yet.</p>"}catch(e){toast(e.message)}}

$("loginTab").onclick=()=>setAuthMode("login");$("registerTab").onclick=()=>setAuthMode("register");$("authBtn").onclick=authenticate;
$("password").addEventListener("keydown",e=>{if(e.key==="Enter")authenticate()});
document.querySelectorAll(".nav-btn[data-view]").forEach(b=>b.onclick=()=>showView(b.dataset.view));
$("logoutBtn").onclick=async()=>{await api("/api/logout",{method:"POST"});location.reload()};
$("casualQuickBtn").onclick=()=>{queueState={mode:"casual",waiting:1};renderPlay();socket.emit("quickPlay",{mode:"casual"})};
$("rankedQuickBtn").onclick=()=>{queueState={mode:"ranked",waiting:1};renderPlay();socket.emit("quickPlay",{mode:"ranked"})};
$("cancelQueueBtn").onclick=()=>socket.emit("cancelQueue");
$("createBtn").onclick=()=>socket.emit("createRoom");$("joinBtn").onclick=()=>{const roomCode=$("roomInput").value.trim().toUpperCase();if(!roomCode)return toast("Enter a room code.");socket.emit("joinRoom",{roomCode})};
$("readyBtn").onclick=()=>socket.emit("toggleReady");$("startBtn").onclick=()=>socket.emit("startMatch");$("restartBtn").onclick=()=>socket.emit("restartRoom");

$("backToPlayBtn").onclick=()=>{
  if(socket && roomState){
    socket.emit("leaveRoom");
  }else{
    roomState=null;
    privateState=null;
    myPlayerId=null;
    showView("play");
    renderPlay();
  }
};
$("leaveRoomBtn").onclick=()=>socket.emit("leaveRoom");
$("copyCodeBtn").onclick=async()=>{try{await navigator.clipboard.writeText(roomState.roomCode);toast("Room code copied.")}catch{toast(roomState.roomCode)}};
$("playModeBtn").onclick=()=>{actionMode="play";$("playModeBtn").classList.add("active");$("discardModeBtn").classList.remove("active");renderPlay()};
$("discardModeBtn").onclick=()=>{actionMode="discard";$("discardModeBtn").classList.add("active");$("playModeBtn").classList.remove("active");renderPlay()};
$("lootCoinsBtn").onclick=()=>openLootbox("coins");$("lootGemsBtn").onclick=()=>openLootbox("gems");
$("cancelDiscardBtn").onclick=closeDiscardConfirmation;
$("confirmDiscardBtn").onclick=()=>{if(!pendingDiscardCard)return;socket.emit("discardCard",{cardId:pendingDiscardCard.id});closeDiscardConfirmation()};
$("discardModal").onclick=e=>{if(e.target===$("discardModal"))closeDiscardConfirmation()};
$("chatForm").addEventListener("submit",e=>{e.preventDefault();const input=$("chatInput"),text=input.value.trim();if(!text||!socket)return;socket.emit("sendChat",{text});input.value=""});
checkSession();
