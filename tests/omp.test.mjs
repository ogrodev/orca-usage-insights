import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { summarizeQuotas } from '../src/core/omp-quotas.mjs';
import { buildReport } from '../src/core/report.mjs';
import { createScanner } from '../src/node/scan.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {}
const sqliteTest = DatabaseSync ? test : (name, fn) => test(name, { skip: 'node:sqlite unavailable' }, fn);

const T1 = Date.UTC(2026, 10, 20, 10, 0, 0);
const T2 = T1 + 60_000;
const T0 = Date.UTC(2026, 7, 1, 9, 0, 0);
const NOW = new Date(Date.UTC(2026, 10, 21, 12, 0, 0));

const header = (id, cwd) => JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(T1 - 1000).toISOString(), cwd });

function assistant(id, ms, { provider = 'anthropic', model = 'claude-opus-5-5', credentialId, cost, text = 'ok' } = {}) {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(ms).toISOString(),
    runtime: { version: '19.1.1' },
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider,
      model,
      usage: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 370, cost: { total: cost }, cttl: { ephemeral1h: 40 } },
      stopReason: 'stop',
      timestamp: ms,
      ...(credentialId === undefined ? {} : { credentialId }),
    },
  });
}

const user = (id, ms) => JSON.stringify({ type: 'message', id, timestamp: new Date(ms).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '"role":"assistant"' }], timestamp: ms } });
const sideCall = (id, ms) => JSON.stringify({ type: 'model_usage', id, timestamp: new Date(ms).toISOString(), purpose: 'title', provider: 'ollama-cloud', model: 'tiny', usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } });

sqliteTest('omp sessions and stats.db merge once per request, keep the account, and use the recorded cost', async (t) => {
  const home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-omp-')));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const profile = path.join(home, '.omp', 'profiles', 'work');
  const sessions = path.join(profile, 'agent', 'sessions', '-w-proj');
  await fsp.mkdir(sessions, { recursive: true });
  const fileA = path.join(sessions, '2026-11-20T10-00-00-000Z_01a00000-0000-7000-8000-00000000000a.jsonl');
  const fileB = path.join(sessions, '2026-11-20T10-05-00-000Z_01a00000-0000-7000-8000-00000000000b.jsonl');
  await fsp.writeFile(fileA, [
    JSON.stringify({ type: 'title', title: 'x' }),
    header('01a00000-0000-7000-8000-00000000000a', '/w/proj'),
    user('u1', T1 - 500),
    assistant('e1', T1, { credentialId: 7, cost: 0.5, text: 'x'.repeat(5000) }),
    sideCall('m1', T1 + 10),
    '',
  ].join('\n'));
  await fsp.writeFile(fileB, [
    header('01a00000-0000-7000-8000-00000000000b', '/w/proj'),
    assistant('e1', T1, { credentialId: 7, cost: 0.5 }),
    assistant('e2', T2, { provider: 'openai-codex', model: 'gpt-5.5', credentialId: 9, cost: 0.25 }),
    '',
  ].join('\n'));
  const db = new DatabaseSync(path.join(profile, 'stats.db'));
  db.exec(`CREATE TABLE messages (session_file TEXT, entry_id TEXT, folder TEXT, model TEXT, provider TEXT, timestamp INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_total REAL, cost_unpriced INTEGER)`);
  const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run(fileA, 'e1', '/w/proj', 'claude-opus-5-5', 'anthropic', T1, 10, 20, 300, 40, 0.5, 0);
  insert.run(path.join(sessions, 'gone_01a00000-0000-7000-8000-0000000000ff.jsonl'), 'e0', '/w/old', 'claude-opus-5-5', 'anthropic', T0, 1, 2, 3, 4, 2, 0);
  db.close();

  const scanner = createScanner({ env: {}, home, threads: 0 });
  t.after(() => scanner.close());
  const { records } = await scanner.scan();
  const rows = records.toRecords().filter((r) => r.provider?.startsWith('omp:'));
  assert.deepEqual(rows.map((r) => r.key).sort(), [`omp:work:e0:${T0}`, `omp:work:e1:${T1}`, `omp:work:e2:${T2}`, `omp:work:m1:${T1 + 10}`]);
  const e1 = rows.find((r) => r.key === `omp:work:e1:${T1}`);
  assert.equal(e1.account, 'work/anthropic#7');
  assert.equal(e1.project, 'proj');
  assert.equal(e1.cacheWrite1h, 40);

  const labels = new Map([['work/anthropic#7', 'Anthropic · me@example.com']]);
  const report = buildReport(records, { range: 'all', now: NOW, accountLabels: labels });
  assert.equal(report.totals.turns, 4);
  assert.ok(Math.abs(report.totals.costUsd - 2.76) < 1e-9);
  assert.deepEqual(report.accounts, ['Anthropic · me@example.com', 'OpenAI Codex · work #9']);
  assert.deepEqual(report.byAccount.map((a) => [a.account, a.provider, a.turns]), [['Anthropic · me@example.com', 'omp:anthropic', 1], ['OpenAI Codex · work #9', 'omp:openai-codex', 1]]);

  const one = buildReport(records, { range: 'all', now: NOW, accountLabels: labels, accounts: ['Anthropic · me@example.com'] });
  assert.equal(one.totals.turns, 1);
  assert.ok(Math.abs(one.totals.costUsd - 0.5) < 1e-9);
});

test('quotas name each account once and label its credential in every profile', () => {
  const report = (credentialId) => ({
    provider: 'anthropic',
    metadata: { email: 'me@example.com', accountId: 'acc-1', credentialId, subscriptionPlan: 'max' },
    limits: [{ label: 'Claude 7 Day', window: { resetsAt: 1_900_000_000_000 }, amount: { usedFraction: 0.45, unit: 'percent' }, status: 'ok' }],
    resetCredits: { availableCount: 1 },
  });
  const { accounts, labels, errors } = summarizeQuotas([
    { profile: 'work', data: { reports: [report(86), { provider: 'ollama-cloud', metadata: { credentialId: 68 }, limits: [], notes: ['No quota API'] }] } },
    { profile: 'default', data: { reports: [report(94)] } },
    { profile: 'aetn', error: 'omp was not found' },
  ]);
  assert.deepEqual(errors, [{ profile: 'aetn', message: 'omp was not found' }]);
  assert.deepEqual([...labels], [
    ['work/anthropic#86', 'Anthropic · me@example.com'],
    ['work/ollama-cloud#68', 'Ollama Cloud · work #68'],
    ['default/anthropic#94', 'Anthropic · me@example.com'],
  ]);
  assert.deepEqual(accounts.map((a) => [a.label, a.plan, a.resetsBanked, a.limits.map((l) => [l.label, l.usedFraction])]), [
    ['Anthropic · me@example.com', 'max', 1, [['Claude 7 Day', 0.45]]],
    ['Ollama Cloud · work #68', null, 0, []],
  ]);
});
