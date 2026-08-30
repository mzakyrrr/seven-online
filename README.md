
# Seven Online

Online multiplayer version of the custom card game **Seven**.

## What is included

- 4-player private rooms
- Create room / join with 5-character room code
- Lobby and ready system
- Real-time updates with Socket.IO
- Private player hands
- Hidden discards
- 7♦ automatic opening
- Play outward from 7
- Strategic voluntary discard
- Blocked paths when a needed card was discarded
- Dead suit if unopened 7 is discarded
- Ace closes a suit after K or 2 is reached
- Automatic discard of remaining cards when a suit closes
- Scoring and shared ranks

## Requirements

Install Node.js 18+.

Check:

```bash
node -v
npm -v
```

## Run locally

Open a terminal inside the `seven-online` folder:

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

### Test with 4 players on one computer

Open 4 separate browser windows or incognito profiles and join the same room.

### Test with phones/laptops on the same Wi-Fi

1. Start the server on your computer.
2. Find your computer's LAN IP, for example `192.168.1.20`.
3. Other devices open:

```text
http://192.168.1.20:3000
```

Windows Firewall may ask you to allow Node.js access. Allow it for Private networks.

## Put it online

This project can be deployed to a Node.js host such as Render or Railway.

Typical settings:

- Build command: `npm install`
- Start command: `npm start`
- Port: provided automatically through `process.env.PORT`

No database is required for this prototype. Game rooms live in server memory, so restarting the server deletes active rooms.

## Important current limitation

This version does not yet persist/reconnect a player after a page refresh. If somebody refreshes or closes the tab during a live match, their seat remains disconnected for that match.

A production version should add:
- reconnect tokens / session recovery
- database or Redis room persistence
- spectator handling
- anti-cheat/rate limiting
- better mobile UX
