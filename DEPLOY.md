# Seven v2: Railway deployment

This version requires PostgreSQL.

## 1. Replace your repository files
Upload/commit this project over the current Seven repository.

## 2. Add PostgreSQL in Railway
Inside the SAME Railway project:
- Click `+ New`
- Add `PostgreSQL`

Railway's Postgres service exposes a `DATABASE_URL`.

## 3. Give the Seven app access to the database
Open the **Seven app service** → Variables and add:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

If your database service has a different name, replace `Postgres` with that exact service name.

## 4. Add JWT secret
In the Seven app service → Variables add:

```text
JWT_SECRET=<a long random secret>
NODE_ENV=production
```

Use a long random value for JWT_SECRET. Do not share it.

## 5. Deploy
Railway will run `npm start`.

The server automatically creates these database tables on startup:
- users
- matches
- match_players

No manual SQL migration is required for v2.

## 6. Test
Open:
- `/health` should return status `ok`
- main page should show Login / Register

Create 4 separate accounts to test one ranked match.

## Rating system
- Starting rating: 1000
- Multiplayer pairwise Elo, K=32
- Each player is evaluated against the other 3
- Tied/shared ranks count as a draw
- Rating changes are approximately zero-sum

## Tier bands
- Iron: <800
- Bronze: 800-999
- Silver: 1000-1199
- Gold: 1200-1399
- Platinum: 1400-1599
- Diamond: 1600-1799
- Master: 1800-1999
- Seven Master: 2000+
