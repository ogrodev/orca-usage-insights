import fsp from 'node:fs/promises';
import path from 'node:path';
import { ompKey } from '../core/records.mjs';
import { decodeTable, encodeTable } from '../core/table-codec.mjs';
import { NameDict, RecordTable } from '../core/table.mjs';
import { opencodeKey } from './opencode-db.mjs';

const CACHE_VERSION = 1;
const MIN_MS = Date.UTC(2020, 0, 1);
const SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function createOmpStatsSource({ fs = fsp, names = new NameDict(), cacheFile = null } = {}) {
  let dbs = new Map();
  let loaded = false;
  let dirty = false;

  return { scan, flush, reset };

  async function scan({ roots = [] } = {}) {
    const out = { sources: [], errors: 0, changed: false };
    if (!loaded && roots.length > 0) {
      loaded = true;
      await loadCache();
    }
    const wanted = new Set();
    for (const { profile, path: file } of roots) {
      wanted.add(file);
      let key;
      try {
        key = await opencodeKey({ fs, path: file });
      } catch {
        out.errors++;
        continue;
      }
      if (key === null) {
        if (dbs.delete(file)) out.changed = dirty = true;
        continue;
      }
      let entry = dbs.get(file);
      if (!entry || entry.key !== key || entry.profile !== profile) {
        const table = await readStats(file, profile, names);
        if (table === null) {
          out.errors++;
        } else {
          entry = { key, profile, table };
          dbs.set(file, entry);
          out.changed = dirty = true;
        }
      }
      if (entry) out.sources.push({ id: `omp-stats:${file}`, table: entry.table });
    }
    for (const file of [...dbs.keys()]) {
      if (wanted.has(file)) continue;
      dbs.delete(file);
      out.changed = dirty = true;
    }
    return out;
  }

  function reset() {
    if (dbs.size > 0) dirty = true;
    dbs = new Map();
    loaded = true;
  }

  async function flush() {
    if (!cacheFile || !dirty) return;
    dirty = false;
    const out = {};
    for (const [file, e] of dbs) out[file] = { key: e.key, profile: e.profile, table: encodeTable(e.table) };
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, dbs: out }));
      await fs.rename(tmp, cacheFile);
    } catch (error) {
      dirty = true;
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async function loadCache() {
    if (!cacheFile) return;
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    } catch {
      return;
    }
    if (raw?.version !== CACHE_VERSION || !raw.dbs || typeof raw.dbs !== 'object') return;
    for (const [file, e] of Object.entries(raw.dbs)) {
      if (typeof e?.key !== 'string' || typeof e.profile !== 'string') continue;
      try {
        const table = decodeTable(e.table, names);
        table.frozen = true;
        dbs.set(file, { key: e.key, profile: e.profile, table });
      } catch {}
    }
  }
}

export async function readStats(file, profile, names = new NameDict()) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('messages')").all().map((row) => row.name));
    if (!columns.has('entry_id')) return new RecordTable(0, names);
    const unpriced = columns.has('cost_unpriced') ? 'cost_unpriced' : '0';
    const query = db.prepare(`SELECT session_file AS sessionFile, entry_id AS entryId, folder, model, provider, timestamp AS ms, input_tokens AS input, output_tokens AS output, cache_read_tokens AS cacheRead, cache_write_tokens AS cacheWrite, cost_total AS cost, ${unpriced} AS unpriced FROM messages`);
    const table = new RecordTable(0, names);
    const sessions = new Map();
    for (const row of query.iterate()) {
      const { sessionFile, folder, ms } = row;
      if (!(ms >= MIN_MS)) continue;
      let sessionId = sessions.get(sessionFile);
      if (sessionId === undefined) sessions.set(sessionFile, (sessionId = SESSION_FILE.exec(sessionFile)?.[1] ?? sessionFile));
      table.push(
        ompKey(profile, row.entryId, ms),
        ms,
        `omp:${row.provider || 'unknown'}`,
        row.model || 'unknown',
        lastSegment(folder),
        sessionId,
        folder,
        'local',
        row.input,
        row.output,
        row.cacheRead,
        row.cacheWrite,
        0,
        undefined,
        row.unpriced ? NaN : row.cost,
      );
    }
    table.frozen = true;
    return table;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function lastSegment(value) {
  if (typeof value !== 'string') return '';
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}
