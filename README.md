# Center Quality — Team Dashboard

A small full-stack web app: upload Excel files, data gets stored in a real
SQLite database on the server, and your whole team sees the same shared
summary dashboard with date/zone/cluster filters and download buttons.

- Backend: Node.js + Express + better-sqlite3 (SQLite — a real file-based database, no separate database server needed)
- Frontend: plain HTML/CSS/JS, served by the same backend
- Storage: every upload is appended to the database (not overwritten), so the dashboard grows over time as new daily files come in

## Run it locally (to test before deploying)

Requires Node.js 18 or newer.

npm install
npm start

Then open http://localhost:3000 in your browser. Upload your Excel file and the dashboard will populate.

## Deploy it for your team (free options)

You want a real URL your whole team can open, so the app needs to run somewhere other than your laptop. Two good free options:

### Option A — Render.com (recommended, easiest)

1. Create a free account at render.com
2. Push this folder to a GitHub repository
3. In Render: New → Web Service → connect your repo
4. Settings:
   - Build Command: npm install
   - Start Command: npm start
   - Instance type: Free
5. Click Deploy. Render gives you a URL like https://your-app.onrender.com — share that with your team.

Note: the free tier "sleeps" after inactivity and spins back up on the next visit (takes about 30 seconds). Fine for internal team use; upgrade to a paid instance if you want it always-on.

### Option B — Railway.app

1. Create a free account at railway.app
2. New Project → Deploy from GitHub repo
3. Railway auto-detects Node.js, runs npm install and npm start
4. It gives you a public URL automatically

### Important: persistent storage

Both Render and Railway free tiers use ephemeral disks by default, meaning the SQLite database file could reset if the service restarts. For a team tool that needs data to stick around long-term, do one of:

- Render: add a free Persistent Disk (Dashboard → your service → Disks → Add Disk, mount path /opt/render/project/src/data)
- Railway: add a Volume (Project → your service → Volumes → mount at /app/data)

This makes sure uploaded data survives restarts and redeploys.

## How your team uses it day to day

1. Open the shared URL
2. Drag a new daily Excel file onto the upload box (it auto-detects the Input-CT sheet, or the first sheet if that's not found)
3. The new rows are added to the database — nothing from prior uploads is deleted
4. Everyone who opens the link sees the same combined data and can filter by date range, zone, cluster
5. Anyone can download the currently filtered view as xlsx or csv
6. The Upload history panel lets you delete a specific upload if a wrong file was added, or clear everything via the API if you need a full reset

## Project structure

ct-dashboard/
  package.json
  server/
    index.js (Express server, SQLite schema, API routes)
  public/
    index.html (Frontend dashboard, no build step needed)
  data/
    app.db (SQLite database file, created automatically)

## API reference

- POST /api/upload — multipart form upload (file field), inserts rows
- GET /api/summary?from=&to=&zone=&cluster= — aggregated KPIs and tables
- GET /api/filters — available zones, clusters, date range
- GET /api/download?from=&to=&zone=&cluster=&format=xlsx|csv — export
- GET /api/uploads — upload history
- DELETE /api/uploads/:id — remove one upload's data
- DELETE /api/clear-all — wipe everything
