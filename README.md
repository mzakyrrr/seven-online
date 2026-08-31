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
