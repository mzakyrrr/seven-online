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
