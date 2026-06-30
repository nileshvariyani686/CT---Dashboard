const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Database setup ----------
const DB_PATH = path.join(__dirname, '..', 'data', 'app.db');
fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    sheet_name TEXT,
    row_count INTEGER,
    uploaded_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id INTEGER,
    demand_date TEXT,
    branch_name TEXT,
    zone_name TEXT,
    cluster_name TEXT,
    region_name TEXT,
    unit_name TEXT,
    sfo_handling_name TEXT,
    total_centers REAL,
    reached_on_time REAL,
    finpage_yes REAL,
    not_tagged REAL,
    total_customers REAL,
    a_count REAL,
    b_count REAL,
    c_count REAL,
    ftod REAL,
    FOREIGN KEY(upload_id) REFERENCES uploads(id)
  );

  CREATE INDEX IF NOT EXISTS idx_records_date ON records(demand_date);
  CREATE INDEX IF NOT EXISTS idx_records_zone ON records(zone_name);
  CREATE INDEX IF NOT EXISTS idx_records_cluster ON records(cluster_name);
`);

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ---------- Helpers ----------
function excelDateToISO(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    // Excel serial date
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    const mm = String(d.m).padStart(2, '0');
    const dd = String(d.d).padStart(2, '0');
    return `${d.y}-${mm}-${dd}`;
  }
  const parsed = new Date(value);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  return null;
}

function pickColumn(row, candidates) {
  for (const c of candidates) {
    if (row[c] !== undefined) return row[c];
  }
  return null;
}

// ---------- Routes ----------

// Upload Excel and append/refresh data
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const preferredSheet = wb.SheetNames.includes('Input-CT') ? 'Input-CT' : wb.SheetNames[0];
    const sheetName = req.body.sheetName && wb.SheetNames.includes(req.body.sheetName)
      ? req.body.sheetName
      : preferredSheet;

    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

    if (!rows.length) {
      return res.status(400).json({ error: 'Selected sheet has no data rows' });
    }

    const insertUpload = db.prepare(
      `INSERT INTO uploads (filename, sheet_name, row_count) VALUES (?, ?, ?)`
    );
    const insertRecord = db.prepare(`
      INSERT INTO records (
        upload_id, demand_date, branch_name, zone_name, cluster_name, region_name,
        unit_name, sfo_handling_name, total_centers, reached_on_time, finpage_yes,
        not_tagged, total_customers, a_count, b_count, c_count, ftod
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    let inserted = 0;
    const txn = db.transaction((dataRows) => {
      const uploadResult = insertUpload.run(req.file.originalname, sheetName, dataRows.length);
      const uploadId = uploadResult.lastInsertRowid;

      for (const row of dataRows) {
        const dateRaw = pickColumn(row, ['demand_date', 'Date', 'date']);
        const isoDate = excelDateToISO(dateRaw);
        if (!isoDate) continue; // skip rows without a usable date

        insertRecord.run(
          uploadId,
          isoDate,
          pickColumn(row, ['branch_name', 'Branch']),
          pickColumn(row, ['zone_name', 'Zone']),
          pickColumn(row, ['cluster_name', 'Cluster']),
          pickColumn(row, ['region_name', 'Region']),
          pickColumn(row, ['Unit Name', 'unit_name']),
          pickColumn(row, ['sfo_handling_name', 'Handler']),
          Number(pickColumn(row, ['total_centers'])) || 0,
          Number(pickColumn(row, ['centers_reached_on_time_count', 'reached_on_time'])) || 0,
          Number(pickColumn(row, ['finpage_yes_count', 'finpage_yes'])) || 0,
          Number(pickColumn(row, ['Centers Not tagged', 'not_tagged'])) || 0,
          Number(pickColumn(row, ['total_customers'])) || 0,
          Number(pickColumn(row, ['A_count'])) || 0,
          Number(pickColumn(row, ['B_count'])) || 0,
          Number(pickColumn(row, ['C_count'])) || 0,
          Number(pickColumn(row, ['FTOD'])) || 0
        );
        inserted++;
      }
      return uploadId;
    });

    const uploadId = txn(rows);

    res.json({
      success: true,
      uploadId,
      sheetName,
      sheetsAvailable: wb.SheetNames,
      rowsInSheet: rows.length,
      rowsInserted: inserted
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// List available sheet names for a file without committing it (preview)
app.post('/api/preview-sheets', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    res.json({ sheets: wb.SheetNames });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Summary endpoint with filters
app.get('/api/summary', (req, res) => {
  try {
    const { from, to, zone, cluster } = req.query;
    let where = ['1=1'];
    let params = [];

    if (from) { where.push('demand_date >= ?'); params.push(from); }
    if (to) { where.push('demand_date <= ?'); params.push(to); }
    if (zone) { where.push('zone_name = ?'); params.push(zone); }
    if (cluster) { where.push('cluster_name = ?'); params.push(cluster); }

    const whereClause = where.join(' AND ');

    const totals = db.prepare(`
      SELECT
        SUM(total_centers) AS total_centers,
        SUM(reached_on_time) AS reached_on_time,
        SUM(finpage_yes) AS finpage_yes,
        SUM(not_tagged) AS not_tagged,
        SUM(total_customers) AS total_customers,
        COUNT(*) AS row_count
      FROM records WHERE ${whereClause}
    `).get(...params);

    const byZone = db.prepare(`
      SELECT zone_name,
        SUM(total_centers) AS total_centers,
        SUM(reached_on_time) AS reached_on_time,
        SUM(finpage_yes) AS finpage_yes,
        SUM(not_tagged) AS not_tagged,
        SUM(total_customers) AS total_customers
      FROM records WHERE ${whereClause}
      GROUP BY zone_name
      ORDER BY total_centers DESC
    `).all(...params);

    const byCluster = db.prepare(`
      SELECT zone_name, cluster_name,
        SUM(total_centers) AS total_centers,
        SUM(reached_on_time) AS reached_on_time,
        SUM(finpage_yes) AS finpage_yes,
        SUM(total_customers) AS total_customers
      FROM records WHERE ${whereClause}
      GROUP BY zone_name, cluster_name
      ORDER BY total_centers DESC
    `).all(...params);

    const byDay = db.prepare(`
      SELECT demand_date,
        SUM(total_centers) AS total_centers,
        SUM(reached_on_time) AS reached_on_time,
        SUM(finpage_yes) AS finpage_yes,
        SUM(total_customers) AS total_customers
      FROM records WHERE ${whereClause}
      GROUP BY demand_date
      ORDER BY demand_date DESC
    `).all(...params);

    const addPct = (r) => ({
      ...r,
      on_time_pct: r.total_centers ? Math.round((r.reached_on_time / r.total_centers) * 1000) / 10 : 0,
      finpage_pct: r.total_centers ? Math.round((r.finpage_yes / r.total_centers) * 1000) / 10 : 0
    });

    res.json({
      totals: addPct(totals || {}),
      byZone: byZone.map(addPct),
      byCluster: byCluster.map(addPct),
      byDay: byDay.map(addPct)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Filter options (zones, clusters, date bounds)
app.get('/api/filters', (req, res) => {
  try {
    const zones = db.prepare(`SELECT DISTINCT zone_name FROM records WHERE zone_name IS NOT NULL ORDER BY zone_name`).all().map(r => r.zone_name);
    const clusters = db.prepare(`SELECT DISTINCT zone_name, cluster_name FROM records WHERE cluster_name IS NOT NULL ORDER BY cluster_name`).all();
    const bounds = db.prepare(`SELECT MIN(demand_date) AS min_date, MAX(demand_date) AS max_date FROM records`).get();
    res.json({ zones, clusters, bounds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download filtered data as CSV
app.get('/api/download', (req, res) => {
  try {
    const { from, to, zone, cluster, format } = req.query;
    let where = ['1=1'];
    let params = [];
    if (from) { where.push('demand_date >= ?'); params.push(from); }
    if (to) { where.push('demand_date <= ?'); params.push(to); }
    if (zone) { where.push('zone_name = ?'); params.push(zone); }
    if (cluster) { where.push('cluster_name = ?'); params.push(cluster); }

    const rows = db.prepare(`SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY demand_date`).all(...params);

    const ws = XLSX.utils.json_to_sheet(rows);
    if ((format || 'csv') === 'xlsx') {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Data');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Disposition', 'attachment; filename="filtered_data.xlsx"');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(buf);
    } else {
      const csv = XLSX.utils.sheet_to_csv(ws);
      res.setHeader('Content-Disposition', 'attachment; filename="filtered_data.csv"');
      res.setHeader('Content-Type', 'text/csv');
      res.send(csv);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List upload history
app.get('/api/uploads', (req, res) => {
  const rows = db.prepare(`SELECT * FROM uploads ORDER BY uploaded_at DESC`).all();
  res.json(rows);
});

// Delete an upload and its records
app.delete('/api/uploads/:id', (req, res) => {
  const id = req.params.id;
  db.prepare(`DELETE FROM records WHERE upload_id = ?`).run(id);
  db.prepare(`DELETE FROM uploads WHERE id = ?`).run(id);
  res.json({ success: true });
});

// Clear all data
app.delete('/api/clear-all', (req, res) => {
  db.prepare(`DELETE FROM records`).run();
  db.prepare(`DELETE FROM uploads`).run();
  res.json({ success: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Fallback to index.html for SPA-style routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Center Quality dashboard running on port ${PORT}`);
});
