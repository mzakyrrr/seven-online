# Deploy Seven Online to Railway

1. Push this folder to a GitHub repository.
2. Railway → New Project → Deploy from GitHub repo.
3. Select the repository and choose Deploy Now.
4. After deployment: Service → Settings → Networking → Generate Domain.
5. Share the generated HTTPS URL with all four players.

The app already uses `process.env.PORT`.
Health check endpoint: `/health`.
Start command: `npm start`.
