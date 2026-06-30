const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- JSON-file database ----------
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    return { uploads: [], records: [], nextUploadId: 1, nextRecordId: 1 };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { uploads: [], records: [], nextUploadId: 1, nextRecordId: 1 };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

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

function matchesFilter(r, { from, to, zone, cluster }) {
  if (from && r.demand_date < from) return false;
  if (to && r.demand_date > to) return false;
  if (zone && r.zone_name !== zone) return false;
  if (cluster && r.cluster_name !== cluster) return false;
  return true;
}

function addPct(r) {
  return {
    ...r,
    on_time_pct: r.total_centers ? Math.round((r.reached_on_time / r.total_centers) * 1000) / 10 : 0,
    finpage_pct: r.total_centers ? Math.round((r.finpage_yes / r.total_centers) * 1000) / 10 : 0
  };
}

// ---------- Routes ----------

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

    const db = loadDB();
    const uploadId = db.nextUploadId++;
    let inserted = 0;

    for (const row of rows) {
      const dateRaw = pickColumn(row, ['demand_date', 'Date', 'date']);
      const isoDate = excelDateToISO(dateRaw);
      if (!isoDate) continue;

      db.records.push({
        id: db.nextRecordId++,
        upload_id: uploadId,
        demand_date: isoDate,
        branch_name: pickColumn(row, ['branch_name', 'Branch']),
        zone_name: pickColumn(row, ['zone_name', 'Zone']),
        cluster_name: pickColumn(row, ['cluster_name', 'Cluster']),
        region_name: pickColumn(row, ['region_name', 'Region']),
        unit_name: pickColumn(row, ['Unit Name', 'unit_name']),
        sfo_handling_name: pickColumn(row, ['sfo_handling_name', 'Handler']),
        total_centers: Number(pickColumn(row, ['total_centers'])) || 0,
        reached_on_time: Number(pickColumn(row, ['centers_reached_on_time_count', 'reached_on_time'])) || 0,
        finpage_yes: Number(pickColumn(row, ['finpage_yes_count', 'finpage_yes'])) || 0,
        not_tagged: Number(pickColumn(row, ['Centers Not tagged', 'not_tagged'])) || 0,
        total_customers: Number(pickColumn(row, ['total_customers'])) || 0,
        a_count: Number(pickColumn(row, ['A_count'])) || 0,
        b_count: Number(pickColumn(row, ['B_count'])) || 0,
        c_count: Number(pickColumn(row, ['C_count'])) || 0,
        ftod: Number(pickColumn(row, ['FTOD'])) || 0
      });
      inserted++;
    }

    db.uploads.push({
      id: uploadId,
      filename: req.file.originalname,
      sheet_name: sheetName,
      row_count: inserted,
      uploaded_at: new Date().toISOString()
    });

    saveDB(db);

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

app.post('/api/preview-sheets', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    res.json({ sheets: wb.SheetNames });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/summary', (req, res) => {
  try {
    const { from, to, zone, cluster } = req.query;
    const db = loadDB();
    const filtered = db.records.filter(r => matchesFilter(r, { from, to, zone, cluster }));

    const sum = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0);

    const totals = {
      total_centers: sum(filtered, 'total_centers'),
      reached_on_time: sum(filtered, 'reached_on_time'),
      finpage_yes: sum(filtered, 'finpage_yes'),
      not_tagged: sum(filtered, 'not_tagged'),
      total_customers: sum(filtered, 'total_customers'),
      row_count: filtered.length
    };

    function groupBy(keys) {
      const map = {};
      for (const r of filtered) {
        const k = keys.map(kk => r[kk]).join('|||');
        if (!map[k]) {
          const base = {};
          keys.forEach(kk => base[kk] = r[kk]);
          map[k] = { ...base, total_centers: 0, reached_on_time: 0, finpage_yes: 0, not_tagged: 0, total_customers: 0 };
        }
        map[k].total_centers += r.total_centers || 0;
        map[k].reached_on_time += r.reached_on_time || 0;
        map[k].finpage_yes += r.finpage_yes || 0;
        map[k].not_tagged += r.not_tagged || 0;
        map[k].total_customers += r.total_customers || 0;
      }
      return Object.values(map);
    }

    const byZone = groupBy(['zone_name']).sort((a, b) => b.total_centers - a.total_centers).map(addPct);
    const byCluster = groupBy(['zone_name', 'cluster_name']).sort((a, b) => b.total_centers - a.total_centers).map(addPct);
    const byDay = groupBy(['demand_date']).sort((a, b) => b.demand_date.localeCompare(a.demand_date)).map(addPct);

    res.json({ totals: addPct(totals), byZone, byCluster, byDay });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/filters', (req, res) => {
  try {
    const db = loadDB();
    const zones = [...new Set(db.records.map(r => r.zone_name).filter(Boolean))].sort();
    const clusterSet = {};
    db.records.forEach(r => {
      if (r.cluster_name) clusterSet[r.zone_name + '|||' + r.cluster_name] = { zone_name: r.zone_name, cluster_name: r.cluster_name };
    });
    const clusters = Object.values(clusterSet).sort((a, b) => a.cluster_name.localeCompare(b.cluster_name));
    const dates = db.records.map(r => r.demand_date).filter(Boolean).sort();
    const bounds = { min_date: dates[0] || null, max_date: dates[dates.length - 1] || null };
    res.json({ zones, clusters, bounds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download', (req, res) => {
  try {
    const { from, to, zone, cluster, format } = req.query;
    const db = loadDB();
    const rows = db.records
      .filter(r => matchesFilter(r, { from, to, zone, cluster }))
      .sort((a, b) => a.demand_date.localeCompare(b.demand_date));

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

app.get('/api/uploads', (req, res) => {
  const db = loadDB();
  res.json(db.uploads.slice().sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at)));
});

app.delete('/api/uploads/:id', (req, res) => {
  const id = Number(req.params.id);
  const db = loadDB();
  db.records = db.records.filter(r => r.upload_id !== id);
  db.uploads = db.uploads.filter(u => u.id !== id);
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/clear-all', (req, res) => {
  saveDB({ uploads: [], records: [], nextUploadId: 1, nextRecordId: 1 });
  res.json({ success: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Center Quality dashboard running on port ${PORT}`);
});
