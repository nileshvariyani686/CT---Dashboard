'use strict';

const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');
const crypto  = require('crypto');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const DB_PATH    = path.join(__dirname, '..', 'data', 'db.json');
const USERS_PATH = path.join(__dirname, '..', 'data', 'users.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// DB helpers  (flat JSON file persisted to disk)
// ---------------------------------------------------------------------------
function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const init = { uploads: [], records: [], nextId: 1 };
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
      return init;
    }
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('loadDB error:', e.message);
    return { uploads: [], records: [], nextId: 1 };
  }
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------------------------------------------------------------------------
// Auth — user store + session management
// ---------------------------------------------------------------------------

// ---- Users file helpers ----
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_PATH)) return { users: [] };
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  } catch {
    return { users: [] };
  }
}

function saveUsers(store) {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(store, null, 2));
}

// ---- Password hashing (scrypt via Node built-in crypto) ----
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, dkLen: 64 };

function hashPassword(password, salt) {
  // salt is a hex string; convert to Buffer for scrypt
  const saltBuf = Buffer.from(salt, 'hex');
  return crypto.scryptSync(
    password,
    saltBuf,
    SCRYPT_PARAMS.dkLen,
    { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p }
  ).toString('hex');
}

function verifyPassword(password, salt, storedHash) {
  const computed = Buffer.from(hashPassword(password, salt), 'hex');
  const stored   = Buffer.from(storedHash, 'hex');
  if (computed.length !== stored.length) return false;
  return crypto.timingSafeEqual(computed, stored);
}

// ---- Session store (in-memory; intentionally cleared on restart) ----
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const sessions = new Map(); // token (hex) → { userId, username, name, expiresAt }

function createSession(user) {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { userId: user.id, username: user.username, name: user.name, expiresAt });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) { sessions.delete(token); return null; }
  return session;
}

// ---- Auth middleware ----
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }
  req.user = session;
  next();
}

// ---- Seed a default admin on first run ----
function seedDefaultAdmin() {
  const store = loadUsers();
  if (store.users.length > 0) return; // already have users

  const salt = crypto.randomBytes(16).toString('hex');
  const defaultPassword = 'admin@123';
  const hash = hashPassword(defaultPassword, salt);

  store.users.push({
    id: 1,
    username: 'admin',
    name: 'Admin',
    salt,
    hash,
  });
  saveUsers(store);

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  First-run: default admin account created.       ║');
  console.log('║  Username : admin                                ║');
  console.log('║  Password : admin@123                            ║');
  console.log('║  → Run  node scripts/add-user.js  to add more.  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
}

// ---------------------------------------------------------------------------
// Column alias map — for each logical field, list every header variant we
// might see in the wild (checked in order; first match wins).
// ---------------------------------------------------------------------------
const COL_ALIASES = {
  demand_date:             ['demand_date', 'Demand Date', 'demand date', 'Date', 'date', 'DEMAND_DATE'],
  branch_name:             ['branch_name', 'Branch Name', 'branch name', 'Branch', 'branch', 'BRANCH'],
  zone_name:               ['zone_name',   'Zone Name',   'zone name',   'Zone',   'zone',   'ZONE'],
  cluster_name:            ['cluster_name','Cluster Name','cluster name','Cluster','cluster','CLUSTER'],
  region_name:             ['region_name', 'Region Name', 'region name', 'Region', 'region', 'REGION'],
  unit_name:               ['unit_name',   'Unit Name',   'unit name',   'Unit',   'unit',   'UNIT'],
  sfo_handling_name_id:    ['sfo_handling_name_id','SFO ID','sfo_id','sfo id'],
  sfo_handling_name:       ['sfo_handling_name','SFO Name','sfo_name','sfo name','SFO Handler','SFO'],
  total_centers:           ['total_centers','Total Centers','total centers','TOTAL_CENTERS'],
  centers_reached_on_time: ['centers_reached_on_time','Centers Reached On Time','centers reached on time','on_time_count','Reached On Time'],
  finpage_yes_count:       ['finpage_yes_count','Finpage Yes Count','finpage yes count','finpage_count','FinPage Yes'],
  centers_not_tagged:      ['centers_not_tagged','Centers Not Tagged','centers not tagged','not_tagged','Not Tagged'],
  A:                       ['A','grade_a','Grade A','A_count'],
  B:                       ['B','grade_b','Grade B','B_count'],
  C:                       ['C','grade_c','Grade C','C_count'],
  ftod_yes_count:          ['ftod_yes_count','FTOD Yes Count','ftod yes count','ftod_count','FTOD'],
};

/** Return the value for a logical field from a raw row object. */
function resolveCol(row, field) {
  const aliases = COL_ALIASES[field] || [field];
  // Exact match first
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, alias) &&
        row[alias] !== null && row[alias] !== undefined) {
      return row[alias];
    }
  }
  // Case-insensitive fallback
  const lowerAliases = aliases.map(a => a.toLowerCase());
  for (const key of Object.keys(row)) {
    if (lowerAliases.includes(key.toLowerCase()) &&
        row[key] !== null && row[key] !== undefined) {
      return row[key];
    }
  }
  return null;
}

function toNum(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

/**
 * Normalise a date value from xlsx (serial number, Date object, or string)
 * to "YYYY-MM-DD" for consistent sorting/comparison.
 */
function normDate(val) {
  if (val === null || val === undefined || val === '') return null;

  // XLSX serial number
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) {
      return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
  }

  const s = String(val).trim();
  if (!s) return null;

  // DD-MM-YYYY or DD/MM/YYYY
  const ddmmyyyy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // YYYY-MM-DD — already canonical
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Try native Date parse as last resort
  const parsed = new Date(s);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);

  return s; // return as-is rather than null, filtering happens later
}

// ---------------------------------------------------------------------------
// Sheet parsing  — core logic
// ---------------------------------------------------------------------------
function parseSFOSheet(workbook) {
  // Find the sheet whose name contains both "sfo" AND ("summary" or "wise"), case-insensitive
  const sheetName = workbook.SheetNames.find(name => {
    const low = name.toLowerCase();
    return low.includes('sfo') && (low.includes('summary') || low.includes('wise'));
  });

  if (!sheetName) {
    const available = workbook.SheetNames.join(', ');
    throw new Error(
      `No sheet found matching "sfo" + ("summary" or "wise"). Available sheets: [${available}]`
    );
  }

  console.log(`Parsing sheet: "${sheetName}"`);

  const ws = workbook.Sheets[sheetName];

  // Object mode — first row becomes property keys; null for missing cells
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null });

  const records = [];
  for (const row of rawRows) {
    const demand_date = normDate(resolveCol(row, 'demand_date'));
    const zone_raw    = resolveCol(row, 'zone_name');

    // Skip rows with empty demand_date or zone_name
    if (!demand_date || !zone_raw || String(zone_raw).trim() === '') continue;

    const branch_raw  = resolveCol(row, 'branch_name');
    const cluster_raw = resolveCol(row, 'cluster_name');
    const region_raw  = resolveCol(row, 'region_name');
    const unit_raw    = resolveCol(row, 'unit_name');

    records.push({
      demand_date,
      // branch_name → lowercase (it's the leaf entity name, preserve readability)
      branch_name:  branch_raw  ? String(branch_raw).trim().toLowerCase()  : '',
      // hierarchy levels → UPPER CASE for consistent grouping
      zone_name:    String(zone_raw).trim().toUpperCase(),
      cluster_name: cluster_raw ? String(cluster_raw).trim().toUpperCase() : '',
      region_name:  region_raw  ? String(region_raw).trim().toUpperCase()  : '',
      unit_name:    unit_raw    ? String(unit_raw).trim().toUpperCase()    : '',
      sfo_handling_name_id: resolveCol(row, 'sfo_handling_name_id'),
      sfo_handling_name:    resolveCol(row, 'sfo_handling_name'),
      // Numeric metrics — always stored as numbers
      total_centers:            toNum(resolveCol(row, 'total_centers')),
      centers_reached_on_time:  toNum(resolveCol(row, 'centers_reached_on_time')),
      finpage_yes_count:        toNum(resolveCol(row, 'finpage_yes_count')),
      centers_not_tagged:       toNum(resolveCol(row, 'centers_not_tagged')),
      A:                        toNum(resolveCol(row, 'A')),
      B:                        toNum(resolveCol(row, 'B')),
      C:                        toNum(resolveCol(row, 'C')),
      ftod_yes_count:           toNum(resolveCol(row, 'ftod_yes_count')),
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------
function sumGroup(rows) {
  const t = {
    total_centers: 0,
    centers_reached_on_time: 0,
    finpage_yes_count: 0,
    centers_not_tagged: 0,
    A: 0, B: 0, C: 0,
    ftod_yes_count: 0,
  };
  for (const r of rows) {
    t.total_centers            += r.total_centers;
    t.centers_reached_on_time  += r.centers_reached_on_time;
    t.finpage_yes_count        += r.finpage_yes_count;
    t.centers_not_tagged       += r.centers_not_tagged;
    t.A                        += r.A;
    t.B                        += r.B;
    t.C                        += r.C;
    t.ftod_yes_count           += r.ftod_yes_count;
  }
  return t;
}

function computePcts(totals) {
  const tc  = totals.total_centers || 0;
  const abc = totals.A + totals.B + totals.C;
  return {
    ...totals,
    customers:      abc,
    on_time_pct:    tc  ? totals.centers_reached_on_time / tc : null,
    finpage_pct:    tc  ? totals.finpage_yes_count / tc       : null,
    not_tagged_pct: tc  ? totals.centers_not_tagged / tc      : null,
    A_pct:          abc ? totals.A / abc : null,
    B_pct:          abc ? totals.B / abc : null,
    C_pct:          abc ? totals.C / abc : null,
  };
}

function buildSummaryRow(level, name, rows, extra = {}) {
  return { level, name, ...extra, ...computePcts(sumGroup(rows)) };
}

// ---------------------------------------------------------------------------
// Filter helper
// ---------------------------------------------------------------------------
function filterRecords(db, { dateFrom, dateTo, zone, cluster, region, unit } = {}) {
  return db.records.filter(r => {
    if (dateFrom && r.demand_date < dateFrom) return false;
    if (dateTo   && r.demand_date > dateTo)   return false;
    if (zone    && r.zone_name    !== zone.trim().toUpperCase())    return false;
    if (cluster && r.cluster_name !== cluster.trim().toUpperCase()) return false;
    if (region  && r.region_name  !== region.trim().toUpperCase())  return false;
    if (unit    && r.unit_name    !== unit.trim().toUpperCase())    return false;
    return true;
  });
}

function unique(arr) {
  return [...new Set(arr)].filter(v => v !== null && v !== undefined && v !== '').sort();
}

function groupBy(arr, key) {
  const map = {};
  for (const item of arr) {
    const k = item[key] ?? '';
    if (!map[k]) map[k] = [];
    map[k].push(item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const store = loadUsers();
  const user  = store.users.find(u => u.username === username.trim().toLowerCase());

  // Use a dummy verify even on "not found" to prevent user-enumeration via timing
  const dummySalt = 'a'.repeat(32);
  const dummyHash = 'b'.repeat(128);
  const isValid = user
    ? verifyPassword(password, user.salt, user.hash)
    : (verifyPassword(password, dummySalt, dummyHash) && false); // always false

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = createSession(user);
  res.json({ token, user: { username: user.username, name: user.name } });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
app.post('/api/auth/logout', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (token) sessions.delete(token);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
app.get('/api/auth/me', (req, res) => {
  const header  = req.headers['authorization'] || '';
  const token   = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ username: session.username, name: session.name });
});

// ---------------------------------------------------------------------------
// POST /api/upload  [requires auth]
// ---------------------------------------------------------------------------
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const newRecords = parseSFOSheet(workbook);

    if (newRecords.length === 0) {
      return res.status(400).json({
        error: 'No valid records found in the SFO summary sheet. ' +
               'Check that the sheet has demand_date and zone_name columns with data.',
      });
    }

    const db = loadDB();
    const newDates = unique(newRecords.map(r => r.demand_date));

    // Deduplicate: remove all existing records whose date appears in this upload
    const datesToReplace = new Set(newDates);

    // Track which upload IDs are being partially or fully replaced
    const affectedUploadIds = new Set(
      db.records
        .filter(r => datesToReplace.has(r.demand_date))
        .map(r => r.upload_id)
    );

    // Remove records for the incoming dates
    db.records = db.records.filter(r => !datesToReplace.has(r.demand_date));

    // Remove uploads that now have zero remaining records
    if (affectedUploadIds.size > 0) {
      const remainingUploadIds = new Set(db.records.map(r => r.upload_id));
      db.uploads = db.uploads.filter(u =>
        !affectedUploadIds.has(u.id) || remainingUploadIds.has(u.id)
      );
    }

    // Assign new upload ID and persist
    const upload_id = db.nextId++;
    const uploadMeta = {
      id: upload_id,
      filename: req.file.originalname,
      uploaded_at: new Date().toISOString(),
      dates: newDates,
      record_count: newRecords.length,
    };

    db.uploads.push(uploadMeta);
    for (const r of newRecords) {
      db.records.push({ ...r, upload_id });
    }

    saveDB(db);

    res.json({
      success: true,
      upload_id,
      record_count: newRecords.length,
      dates: newDates,
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/filters
// ---------------------------------------------------------------------------
app.get('/api/filters', (req, res) => {
  try {
    const db = loadDB();
    const r  = db.records;
    res.json({
      dates:    unique(r.map(x => x.demand_date)),
      zones:    unique(r.map(x => x.zone_name)),
      clusters: unique(r.map(x => x.cluster_name)),
      regions:  unique(r.map(x => x.region_name)),
      units:    unique(r.map(x => x.unit_name)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/summary
// ---------------------------------------------------------------------------
app.get('/api/summary', (req, res) => {
  try {
    const db = loadDB();
    const { dateFrom, dateTo, zone, cluster, region } = req.query;

    const filtered = filterRecords(db, { dateFrom, dateTo, zone, cluster, region });

    if (filtered.length === 0) return res.json([]);

    const rows = [];

    // Grand total
    rows.push(buildSummaryRow('total', 'Total', filtered));

    // Zone level
    const byZone = groupBy(filtered, 'zone_name');
    for (const zoneName of Object.keys(byZone).sort()) {
      const zRows = byZone[zoneName];
      rows.push(buildSummaryRow('zone', zoneName, zRows, { zone: zoneName }));

      // Cluster level
      const byCluster = groupBy(zRows, 'cluster_name');
      for (const clusterName of Object.keys(byCluster).sort()) {
        const cRows = byCluster[clusterName];
        rows.push(buildSummaryRow('cluster', clusterName, cRows, {
          zone: zoneName, cluster: clusterName,
        }));

        // Region level
        const byRegion = groupBy(cRows, 'region_name');
        for (const regionName of Object.keys(byRegion).sort()) {
          const rRows = byRegion[regionName];
          rows.push(buildSummaryRow('region', regionName, rRows, {
            zone: zoneName, cluster: clusterName, region: regionName,
          }));

          // Unit level
          const byUnit = groupBy(rRows, 'unit_name');
          for (const unitName of Object.keys(byUnit).sort()) {
            const uRows = byUnit[unitName];
            rows.push(buildSummaryRow('unit', unitName, uRows, {
              zone: zoneName, cluster: clusterName, region: regionName, unit: unitName,
            }));

            // Branch level
            const byBranch = groupBy(uRows, 'branch_name');
            for (const branchName of Object.keys(byBranch).sort()) {
              const bRows = byBranch[branchName];
              rows.push(buildSummaryRow('branch', branchName, bRows, {
                zone: zoneName, cluster: clusterName,
                region: regionName, unit: unitName, branch: branchName,
              }));
            }
          }
        }
      }
    }

    res.json(rows);
  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/daily-pivot
// ---------------------------------------------------------------------------
app.get('/api/daily-pivot', (req, res) => {
  try {
    const db = loadDB();
    const { dateFrom, dateTo, zone, cluster } = req.query;

    const filtered = filterRecords(db, { dateFrom, dateTo, zone, cluster });

    if (filtered.length === 0) return res.json({ dates: [], rows: [] });

    // Dates sorted ascending
    const allDates = unique(filtered.map(r => r.demand_date));

    function buildByDate(subRows) {
      const byDate = {};
      for (const date of allDates) {
        const dateRows = subRows.filter(r => r.demand_date === date);
        if (dateRows.length === 0) {
          byDate[date] = null;
        } else {
          const t  = sumGroup(dateRows);
          const tc = t.total_centers || 0;
          const abc = t.A + t.B + t.C;
          byDate[date] = {
            total_centers:           t.total_centers,
            centers_reached_on_time: t.centers_reached_on_time,
            finpage_yes_count:       t.finpage_yes_count,
            centers_not_tagged:      t.centers_not_tagged,
            customers:               abc,
            on_time_pct:    tc ? t.centers_reached_on_time / tc : null,
            finpage_pct:    tc ? t.finpage_yes_count / tc       : null,
            not_tagged_pct: tc ? t.centers_not_tagged / tc      : null,
          };
        }
      }
      return byDate;
    }

    const pivotRows = [];

    // Grand total row
    pivotRows.push({ level: 'total', name: 'Total', byDate: buildByDate(filtered) });

    // Zone rows, then cluster rows under each zone
    const byZone = groupBy(filtered, 'zone_name');
    for (const zoneName of Object.keys(byZone).sort()) {
      const zRows = byZone[zoneName];
      pivotRows.push({
        level: 'zone', name: zoneName, zone: zoneName,
        byDate: buildByDate(zRows),
      });

      const byCluster = groupBy(zRows, 'cluster_name');
      for (const clusterName of Object.keys(byCluster).sort()) {
        pivotRows.push({
          level: 'cluster', name: clusterName, zone: zoneName, cluster: clusterName,
          byDate: buildByDate(byCluster[clusterName]),
        });
      }
    }

    res.json({ dates: allDates, rows: pivotRows });
  } catch (err) {
    console.error('Daily pivot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/uploads — list newest first
// ---------------------------------------------------------------------------
app.get('/api/uploads', (req, res) => {
  try {
    const db = loadDB();
    const sorted = [...db.uploads].sort((a, b) =>
      b.uploaded_at.localeCompare(a.uploaded_at)
    );
    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/uploads/:id  [requires auth]
// ---------------------------------------------------------------------------
app.delete('/api/uploads/:id', requireAuth, (req, res) => {
  try {
    const id  = parseInt(req.params.id, 10);
    const db  = loadDB();
    const idx = db.uploads.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Upload not found' });

    db.uploads.splice(idx, 1);
    db.records = db.records.filter(r => r.upload_id !== id);
    saveDB(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Catch-all — serve SPA
// ---------------------------------------------------------------------------
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
seedDefaultAdmin();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CT Dashboard server running at http://localhost:${PORT}`);
});
