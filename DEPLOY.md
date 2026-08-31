# Deploy Seven v4

This is an in-place upgrade from the current Seven build.

1. Replace the files in your existing GitHub repository with this build.
2. Commit to your connected Railway branch.
3. Railway can autodeploy the commit.
4. Keep the existing Postgres service and environment variables. No new Railway service is needed.

The database migration is automatic. It only adds `matches.match_type` if missing.

Quick Play queues are currently held in server memory, which is fine while the app runs as one Railway instance. If you later scale to multiple server replicas, move matchmaking/room state to Redis.
