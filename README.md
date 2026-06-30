# Svatantra — Center Quality CT Dashboard

A full-stack web dashboard that automates the generation of quality summary reports by processing uploaded raw backend data dumps. Admins upload a daily Excel export; the whole team sees the same live, filterable, hierarchical dashboard.

## Tech Stack

- **Backend** — Node.js + Express, JSON file database (`data/db.json`)
- **Frontend** — Vanilla HTML / CSS / JS, served by the same backend (no build step)
- **File processing** — `xlsx` library; reads only the `SFO_wise_Summary` sheet, all other tabs are ignored
- **Auth** — scrypt-hashed passwords, in-memory Bearer token sessions (8-hour expiry)

---

## Project Structure

```
CT---Dashboard/
├── server/
│   └── index.js          # Express server — API routes, sheet parsing, aggregation, auth
├── public/
│   ├── index.html        # Single-page dashboard (Upload, CT Summary, Daily Pivot tabs)
│   └── logo.png          # Svatantra brand logo
├── scripts/
│   └── add-user.js       # CLI tool to manage admin users
├── data/                 # Created at runtime (git-ignored)
│   ├── db.json           # Uploaded records store
│   └── users.json        # Hashed admin credentials
├── deploy.sh             # Linux deployment script (systemd)
├── deploy.ps1            # Windows deployment script (NSSM)
└── package.json
```

---

## Input Data

**Upload source:** Raw Excel dump exported from the backend.

**Example filename:** `CenterMeeting_Report_CT_2026-06-29_sfo.xlsx`

**Required sheet:** `SFO_wise_Summary` — all other tabs are stripped and ignored.

**Sheet columns processed:**

| Column | Description |
|---|---|
| `demand_date` | Date of the record (DD-MM-YYYY) |
| `branch_name` | Branch (leaf entity) |
| `zone_name` | Zone |
| `cluster_name` | Cluster |
| `region_name` | Region |
| `unit_name` | Unit |
| `sfo_handling_name` | SFO officer name |
| `total_centers` | Total center count |
| `centers_reached_on_time` | Centers reached on time |
| `finpage_yes_count` | Finpage entry passed count |
| `centers_not_tagged` | Centers not tagged |
| `A`, `B`, `C` | Customer category counts |
| `ftod_yes_count` | FTOD count |

Percentages are computed server-side from summed raw counts — never averaged from the `%` columns in the sheet.

---

## Dashboard Tabs

### Upload *(admin only — requires login)*
- Drag-and-drop or click-to-browse file upload
- Re-uploading the same date replaces existing data for that date (deduplication)
- Upload history with per-upload delete

### CT Summary
- Hierarchical table: **Total → Zone → Cluster → Region → Unit → Branch**
- Columns: Centers, On-Time %, Finpage %, Not Tagged %, A%, B%, C%, FTOD Count
- Colour-coded cells: green ≥ 70%, amber 55–69%, red < 55% (Not Tagged % reversed)
- Toggle to show/hide branch-level rows
- Filter by date range and zone

### Daily Pivot
- Dates as columns, Zone / Cluster hierarchy as rows
- Metric selector: On-Time % / Finpage % / Not Tagged % / Center Count
- Compare Mode: stacks On-Time % + Finpage % side-by-side in each date cell
- Horizontally scrollable with sticky entity column
- Filter by date range, zone, and cluster

---

## Run Locally

Requires **Node.js 18+**.

```bash
npm install
npm start
# Open http://localhost:3000
```

Default admin credentials (created on first run):

```
Username: admin
Password: admin@123
```

**Change the default password immediately:**

```bash
node scripts/add-user.js --password admin
```

---

## User Management

```bash
# Add a new admin user (interactive)
node scripts/add-user.js

# List all users
node scripts/add-user.js --list

# Change a user's password
node scripts/add-user.js --password <username>

# Delete a user
node scripts/add-user.js --delete <username>
```

---

## Deploy to a VM

### Linux (Ubuntu / Debian / RHEL / CentOS / Amazon Linux)

```bash
# Copy project files to the VM, then:
sudo bash deploy.sh

# Custom port:
sudo PORT=8080 bash deploy.sh
```

The script will:
1. Install Node.js 20 LTS via NodeSource (if not present)
2. Create a locked-down `ct-dashboard` system user
3. Run `npm install --omit=dev`
4. Create and enable a **systemd service** (auto-starts on reboot, restarts on crash)
5. Open the port in `ufw` or `firewalld`
6. Run a health check

**Post-deploy commands:**

```bash
systemctl status ct-dashboard
journalctl -u ct-dashboard -f      # live logs
systemctl restart ct-dashboard
```

---

### Windows (10 / 11 / Server 2016+)

Open **PowerShell as Administrator**, then:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
.\deploy.ps1

# Custom port:
.\deploy.ps1 -Port 8080
```

The script will:
1. Install Node.js 20 LTS via `winget` (if not present)
2. Run `npm install --omit=dev`
3. Download **NSSM** (Non-Sucking Service Manager) and register the app as a **Windows Service** (auto-starts on boot, restarts on crash, log rotation at 10 MB)
4. Add a Windows Firewall inbound rule for the port
5. Run a health check

**Post-deploy commands:**

```powershell
Get-Service CTDashboard
Restart-Service CTDashboard
Get-Content .\logs\stdout.log -Tail 50 -Wait    # live logs
```

---

## API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | — | `{username, password}` → `{token, user}` |
| `POST` | `/api/auth/logout` | Bearer | Invalidate session |
| `GET` | `/api/auth/me` | Bearer | Current session info |
| `POST` | `/api/upload` | Bearer | Upload Excel file (multipart `file` field) |
| `GET` | `/api/summary` | — | Hierarchical aggregated data. Query: `dateFrom`, `dateTo`, `zone`, `cluster`, `region` |
| `GET` | `/api/daily-pivot` | — | Date-as-columns pivot. Query: `dateFrom`, `dateTo`, `zone`, `cluster` |
| `GET` | `/api/filters` | — | Available dates, zones, clusters, regions, units |
| `GET` | `/api/uploads` | — | Upload history (newest first) |
| `DELETE` | `/api/uploads/:id` | Bearer | Delete an upload and all its records |
| `GET` | `/api/health` | — | `{"status":"ok"}` |

---

## Security Notes

- Passwords hashed with `crypto.scryptSync` (N=16384, r=8, p=1) — no external packages
- `crypto.timingSafeEqual` used for both password and session token comparison
- Session tokens are 32 random bytes (256-bit entropy) via `crypto.randomBytes`
- Sessions are in-memory and expire after 8 hours; clearing on server restart
- `data/db.json` and `data/users.json` are git-ignored and never committed
- Only `POST /api/upload` and `DELETE /api/uploads/:id` require authentication; all read endpoints are public
