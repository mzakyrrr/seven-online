const $=id=>document.getElementById(id);
const SUITS=["diamond","heart","club","spade"];
const SYMBOL={diamond:"♦",heart:"♥",club:"♣",spade:"♠"};
let authMode="login", me=null, socket=null, roomState=null, privateState=null, myPlayerId=null, actionMode="play";

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
  $("homeRating").textContent=me.rating;$("homeTier").textContent=me.tier;$("homeGames").textContent=me.games_played;$("homeWins").textContent=me.wins;$("homePodiums").textContent=me.podiums;
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
  socket.on("roomState",s=>{roomState=s;renderPlay()});
  socket.on("privateState",s=>{privateState=s;renderPlay()});
  socket.on("leftRoom",()=>{roomState=null;privateState=null;myPlayerId=null;renderPlay()});
  socket.on("noActiveRoom",()=>{});
  socket.on("errorMessage",toast);
  socket.on("connect_error",()=>toast("Session expired. Please login again."));
}
function showView(view){
  ["play","leaderboard","history","profile"].forEach(v=>$(`${v}View`).classList.toggle("hidden",v!==view));
  document.querySelectorAll(".nav-btn[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  if(view==="leaderboard") loadLeaderboard();
  if(view==="history") loadHistory();
  if(view==="profile") refreshMe();
}
function getMyPlayer(){return roomState?.players?.find(p=>p.id===myPlayerId)}
function renderPlay(){
  const inRoom=!!roomState;
  $("homeCard").classList.toggle("hidden",inRoom);
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
function cardEl(card,small=false){const e=document.createElement("div");e.className=`card ${["diamond","heart"].includes(card.suit)?"red":""} ${small?"small":""}`;e.innerHTML=`<div class="rank">${card.rank}${SYMBOL[card.suit]}</div><div class="suit-symbol">${SYMBOL[card.suit]}</div><div class="rank bottom">${card.rank}${SYMBOL[card.suit]}</div>`;return e}
function renderGame(){
  const mine=getMyPlayer(), current=roomState.players.find(p=>p.id===roomState.currentPlayerId), myTurn=roomState.currentPlayerId===myPlayerId;
  $("youName").textContent=mine?.name||me.username;$("turnText").textContent=current?`${current.name}'s turn`:"";$("lastEvent").textContent=roomState.lastEvent||"";
  $("actionHelp").textContent=!myTurn?"Wait for your turn.":actionMode==="play"?"Play a highlighted card, or switch to Discard.":"Discard mode: choose any card. It stays hidden.";
  $("scoreRow").innerHTML=roomState.players.map(p=>`<div class="score-card ${p.id===roomState.currentPlayerId?"current":""} ${p.id===myPlayerId?"me":""}"><div class="score-name">${esc(p.name)}</div><div class="score-meta">${p.handCount} cards · ${p.score} discard pts</div></div>`).join("");
  const board=$("board");board.innerHTML="";
  SUITS.forEach(suit=>{const s=roomState.board[suit],lane=document.createElement("div");lane.className="suit-lane";const status=s.dead?"Dead":s.closed?"Closed":s.opened?"Open":"Waiting";lane.innerHTML=`<div class="suit-head"><span>${SYMBOL[suit]} ${suit[0].toUpperCase()+suit.slice(1)}</span><span>${status}</span></div>`;const line=document.createElement("div");line.className="cards-line";if(!s.opened){line.innerHTML=`<div class="empty">${s.dead?"7 was discarded. Suit is dead.":"Waiting for 7"}</div>`}else{for(const r of s.playedRanks)line.appendChild(cardEl({suit,rank:r},true));if(s.acePlayed)line.appendChild(cardEl({suit,rank:"A"},true))}lane.appendChild(line);board.appendChild(lane)});
  const hand=$("hand");hand.innerHTML="";for(const c of privateState?.hand||[]){const e=cardEl(c);const can=playable(c);e.classList.add("clickable");if(!myTurn||actionMode==="play"&&!can)e.classList.add("disabled");if(myTurn&&actionMode==="play"&&can)e.classList.add("playable");e.onclick=()=>{if(!myTurn)return;if(actionMode==="play"){if(!can)return toast("That card cannot be played.");socket.emit("playCard",{cardId:c.id})}else socket.emit("discardCard",{cardId:c.id})};hand.appendChild(e)}
}
function renderResults(){
  $("ranking").innerHTML=(roomState.rankings||[]).map(r=>`<div class="result-row"><div class="result-rank">#${r.rank}</div><div><strong>${esc(r.name)}</strong><div class="muted">${r.score} discard pts</div></div><div>${r.ratingAfter??""} ${r.tier??""}</div><div class="delta ${(r.ratingDelta||0)>=0?"plus":"minus"}">${(r.ratingDelta||0)>=0?"+":""}${r.ratingDelta??0}</div></div>`).join("");
  $("restartBtn").classList.toggle("hidden",!getMyPlayer()?.isHost);
}
async function loadLeaderboard(){try{const d=await api("/api/leaderboard");$("leaderboard").innerHTML=d.leaderboard.map(r=>`<div class="leader-row"><div class="result-rank">#${r.rank}</div><div><strong>${esc(r.username)}</strong><div class="muted">${r.tier}</div></div><div>${r.rating} rating</div><div>${r.wins} wins</div></div>`).join("")||"<p class='muted'>No ranked players yet.</p>"}catch(e){toast(e.message)}}
async function loadHistory(){try{const d=await api("/api/history");$("history").innerHTML=d.history.map(h=>`<div class="history-card"><div class="history-head"><div><strong>Rank #${h.finalRank}</strong> · ${h.discardScore} pts<div class="muted">${new Date(h.playedAt).toLocaleString()}</div></div><div class="delta ${h.ratingDelta>=0?"plus":"minus"}">${h.ratingDelta>=0?"+":""}${h.ratingDelta} rating</div></div><div class="history-players">${h.participants.map(p=>`<div class="history-player"><strong>#${p.finalRank} ${esc(p.username)}</strong><br>${p.discardScore} pts<br><span class="delta ${p.ratingDelta>=0?"plus":"minus"}">${p.ratingDelta>=0?"+":""}${p.ratingDelta}</span></div>`).join("")}</div></div>`).join("")||"<p class='muted'>No matches yet.</p>"}catch(e){toast(e.message)}}

$("loginTab").onclick=()=>setAuthMode("login");$("registerTab").onclick=()=>setAuthMode("register");$("authBtn").onclick=authenticate;
$("password").addEventListener("keydown",e=>{if(e.key==="Enter")authenticate()});
document.querySelectorAll(".nav-btn[data-view]").forEach(b=>b.onclick=()=>showView(b.dataset.view));
$("logoutBtn").onclick=async()=>{await api("/api/logout",{method:"POST"});location.reload()};
$("createBtn").onclick=()=>socket.emit("createRoom");$("joinBtn").onclick=()=>{const roomCode=$("roomInput").value.trim().toUpperCase();if(!roomCode)return toast("Enter a room code.");socket.emit("joinRoom",{roomCode})};
$("readyBtn").onclick=()=>socket.emit("toggleReady");$("startBtn").onclick=()=>socket.emit("startMatch");$("restartBtn").onclick=()=>socket.emit("restartRoom");$("leaveRoomBtn").onclick=()=>socket.emit("leaveRoom");
$("copyCodeBtn").onclick=async()=>{try{await navigator.clipboard.writeText(roomState.roomCode);toast("Room code copied.")}catch{toast(roomState.roomCode)}};
$("playModeBtn").onclick=()=>{actionMode="play";$("playModeBtn").classList.add("active");$("discardModeBtn").classList.remove("active");renderPlay()};
$("discardModeBtn").onclick=()=>{actionMode="discard";$("discardModeBtn").classList.add("active");$("playModeBtn").classList.remove("active");renderPlay()};
checkSession();
