# Seven Online v5 Playtest Fixes

Based on the matchmaking/economy build.

## Changes
- In-game room chat beside the card table
- Equipped deck skin now renders on the owner's hand and on cards that player places on the table
- Discard action requires confirmation
- Hand area turns red while Discard mode is active
- Other players only see discarded-card count, never discard point value
- Your own discard count and total discard value remain visible privately
- Private room creation/join refreshes equipped deck from the database before seating the player

No new database service or environment variable is required. Deploy over the existing Railway/GitHub project.

## Post-match navigation

After a match ends:
- **Back to Lobby** keeps the same private room for a rematch (host flow).
- **Back to Play Menu** leaves the finished room and returns the player to the Play screen for Quick Play or another room.


## UI Refresh
This build includes an in-game visual refresh:
- premium dark casino style
- clearer current-turn HUD
- stronger Play/Discard distinction
- refined table and suit lanes
- cleaner player status cards
- improved hand readability
- mobile responsiveness improvements


## Smart Bot Practice
- Play one human vs three server-side bots.
- Practice mode only, no Elo/rating changes and no ranked farming.
- Bots use heuristics instead of random actions:
  - evaluate whether to play or discard
  - may intentionally block a suit path
  - value control of future continuation cards
  - consider self-damage before discarding an unopened 7
  - prefer preserving useful Aces
  - choose Ace closures based on remaining cards in their own hand
- Bots do not need access to opponents' private hands to choose an action.


## v7.1 Active room fix
- Finished or deleted rooms no longer block Quick Play / Create Room.
- Stale `userActiveRoom` mappings are cleaned automatically.
- Old lobby/queue seats are safely abandoned when starting a new game.
- A genuinely active match still reconnects the user to the same seat.


## v7.2 Practice render fix
- Removed duplicate `Exit Practice`; all active matches now use one `Exit Match` action.
- Fixed Practice mode rendering stopping before scoreboard/board/hand.
- Removed stale `gameModeBadge` UI references from the old layout.
- Added defensive UI rendering so missing optional elements do not break the whole match screen.
- Play vs Bots now uses the same stale-room cleanup as other play modes.


## v7.3 Public deck skins
- Equipped deck is refreshed from PostgreSQL immediately before every match.
- Practice mode also refreshes the human player's equipped deck.
- Every card placed on the table permanently retains the skin of the player who played it.
- Other players therefore see Royal Gold, Neon Tokyo, etc. on the shared table.
- Cards played into the same suit can have different skins because ownership is stored per played card.
- Skin visuals are now more obvious via face tint, accent border, lower color panel, glow, and deck mark.
