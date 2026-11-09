#!/usr/bin/env node
/**
 * WorkBuddy 記賬：查額度現況、今日消耗與逐輪帳本。
 *
 * 資料來源（全部本機唯讀，不聯網、不寫入 WorkBuddy 的資料庫）：
 *   ~/.workbuddy/workbuddy.db（國際版 ~/.workbuddy-ai/workbuddy.db）
 *     ├─ session_usage : session_id / used / size / updated_at / credit_json
 *     │    credit_json = {"<itemId>": 逐筆金額} → 真實花費，不是估算
 *     └─ sessions     : id / title / status / model / updated_at / last_activity_at
 *
 * 帳本（8 位小數定點、逐輪明細 + 逐日彙總、保留期封存）在 scripts/accounting.mjs。
 *
 * 用法：
 *   node usage.mjs              # 完整 JSON
 *   node usage.mjs --status     # 只看現況（人類可讀）
 *   node usage.mjs --today      # 只看今日消耗
 *   node usage.mjs --ledger     # 只看帳本
 *   node usage.mjs --summary    # 一行摘要（≤50 字元，給 Agent 用）
 *   node usage.mjs --json       # 機器可讀輸出（與 MCP 契約一致）
 *   node usage.mjs --selftest   # 自測（不碰真實帳本）
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  beijingDay,
  daySummary,
  emptyLedger,
  ledgerDays,
  observeUsage,
  pruneLedger,
  readLedger,
  resolveUsageDir,
  archivePath,
  ledgerPath,
  runSelfTest,
  turnsOf,
  writePrivateJson,
} from './accounting.mjs';

/** 資料目錄候選：環境變數優先，否則國內版 / 國際版。 */
const CONFIG_DIRS = [
  process.env.WORKBUDDY_HOME,
  join(homedir(), '.workbuddy'),
  join(homedir(), '.workbuddy-ai'),
].filter(Boolean);

const USAGE = `WorkBuddy 記賬（wbdy-fatfish-usage）

  node usage.mjs              完整 JSON
  node usage.mjs --status     現況：已用 / 額度 / 百分比 / 模型
  node usage.mjs --today      今日消耗（金額 + 筆數）
  node usage.mjs --ledger     帳本（逐日 + 最近逐輪）
  node usage.mjs --summary    一行摘要（≤50 字元）
  node usage.mjs --json       機器可讀輸出
  node usage.mjs --days <n>   帳本要回幾天（預設 30）
  node usage.mjs --selftest   自測（不碰真實帳本）
  node usage.mjs --help       本說明

資料來源：~/.workbuddy/workbuddy.db（唯讀）
帳本位置：${resolveUsageDir()}`;

/**
 * 找出 workbuddy.db。
 *
 * @returns {string|null} 資料庫路徑。
 */
function dbPath() {
  for (const dir of CONFIG_DIRS) {
    const path = join(dir, 'workbuddy.db');
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * 以唯讀方式開啟資料庫。
 *
 * 為什麼優先用 `file:<path>?mode=ro` 的 URI 形式：
 *   這是 sqlite 官方的唯讀開法，會連 WAL 都不寫。
 *   node:sqlite 若沒有開 SQLITE_OPEN_URI 就會把整個字串當檔名 → 開不起來，
 *   所以退回 `{readOnly:true}`（等價 SQLITE_OPEN_READONLY），並設 busy_timeout。
 *
 * @param {string} path - 資料庫路徑。
 * @returns {{db: object, mode: string}|null} 開啟結果。
 */
function openReadOnly(path) {
  const uri = `file:${path.replace(/\\/g, '/')}?mode=ro`;
  try {
    const db = new DatabaseSyncShim(uri);
    db.exec('PRAGMA busy_timeout = 5000');
    // 確認真的開到檔案（URI 不被支援時會當成檔名而新建一個空庫）
    const probe = db.prepare('SELECT COUNT(*) AS c FROM sqlite_master').get();
    if (!probe || Number(probe.c) === 0) {
      db.close();
      throw new Error('URI 形式開到的是空庫');
    }
    return { db, mode: 'file:…?mode=ro' };
  } catch {
    try {
      const db = new DatabaseSyncShim(path, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000');
      return { db, mode: 'readOnly:true' };
    } catch {
      return null;
    }
  }
}

/** node:sqlite 的 DatabaseSync（載入失敗時才會用到這個佔位）。 */
let DatabaseSyncShim = null;
try {
  ({ DatabaseSync: DatabaseSyncShim } = await import('node:sqlite'));
} catch {
  console.error('[usage] 需要 Node 22+（內建 node:sqlite）');
  process.exit(1);
}

/**
 * 讀出資料庫裡的觀測（每個會話一筆）。
 *
 * @param {object} db - 資料庫連線。
 * @returns {{sessions: object[], usage: object[]}} 會話與用量。
 */
function readObservations(db) {
  const sessions = db.prepare(
    `SELECT id, title, custom_title, status, model, created_at, updated_at, last_activity_at
       FROM sessions WHERE deleted_at IS NULL
      ORDER BY COALESCE(last_activity_at, updated_at) DESC`,
  ).all();
  const usage = db.prepare(
    `SELECT session_id, used, size, updated_at, credit_json FROM session_usage`,
  ).all();
  return { sessions: sessions || [], usage: usage || [] };
}

/**
 * 把 credit_json 解析成逐筆金額。
 *
 * @param {unknown} raw - credit_json 原始字串。
 * @returns {Array<{id: string, amount: number}>} 逐筆金額。
 */
function parseItems(raw) {
  if (!raw) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const out = [];
  for (const [id, amount] of Object.entries(parsed)) {
    const value = Number(amount);
    if (!Number.isFinite(value)) continue;
    out.push({ id, amount: value });
  }
  return out;
}

/**
 * 產生完整輸出。
 *
 * @param {object} options - 選項。
 * @returns {object} 輸出資料。
 */
function build({ days = 30, turns = 20 } = {}) {
  const path = dbPath();
  if (!path) {
    return {
      ok: false,
      reason: 'db-missing',
      message: '找不到 workbuddy.db（~/.workbuddy/workbuddy.db）—— 請先在 WorkBuddy 跑一次會話',
    };
  }
  const conn = openReadOnly(path);
  if (!conn) {
    return { ok: false, reason: 'db-open-failed', message: `無法唯讀開啟 ${path}` };
  }
  let observed;
  try {
    observed = readObservations(conn.db);
  } finally {
    try { conn.db.close(); } catch { /* ignore */ }
  }

  const dir = resolveUsageDir();
  const ledger = readLedger(dir);
  const bySession = new Map(observed.sessions.map((s) => [s.id, s]));

  // 每次觀測一個會話 → 一次觀測（credit_json 是累計快照）
  for (const row of observed.usage) {
    const session = bySession.get(row.session_id);
    const items = parseItems(row.credit_json);
    if (items.length === 0) continue;
    observeUsage(ledger, {
      at: Number(row.updated_at) || Number(session?.updated_at) || Date.now(),
      sessionId: String(row.session_id),
      model: session?.model ?? null,
      title: session?.custom_title || session?.title || null,
      items,
    });
  }

  // 保留期清理 → 封存
  const pruned = pruneLedger(ledger);
  if (pruned.archived.turns.length > 0 || pruned.archived.days.length > 0) {
    const archive = readArchiveFile(archivePath(dir));
    archive.turns = [...(archive.turns || []), ...pruned.archived.turns];
    archive.days = [...(archive.days || []), ...pruned.archived.days];
    writePrivateJson(archivePath(dir), archive);
  }
  writePrivateJson(ledgerPath(dir), pruned.ledger);

  // 現況：最近有活動的會話
  const current = observed.sessions[0] ?? null;
  const currentUsage = current ? observed.usage.find((u) => u.session_id === current.id) : null;
  const used = Number(currentUsage?.used) || 0;
  const size = Number(currentUsage?.size) || 0;
  const remaining = Math.max(0, size - used);
  const percent = size > 0 ? Math.round((used / size) * 1000) / 10 : null;

  const today = daySummary(pruned.ledger, beijingDay()) || { amount: 0, count: 0, date: beijingDay() };
  const allDays = ledgerDays(pruned.ledger);
  const dayRows = allDays
    .slice(-Math.max(1, days))
    .map((date) => {
      const summary = daySummary(pruned.ledger, date);
      return { date, amount: summary?.amount ?? 0, count: summary?.count ?? 0 };
    })
    .reverse();

  return {
    ok: true,
    status: {
      sessionId: current?.id ?? null,
      model: current?.model ?? null,
      used,
      size,
      remaining,
      percent,
      updatedAt: currentUsage?.updated_at ?? current?.updated_at ?? null,
    },
    today: { amount: today.amount, count: today.count },
    ledger: {
      days: dayRows,
      turns: turnsOf(pruned.ledger, { limit: turns }),
    },
  };
}

/**
 * 讀封存檔。
 *
 * @param {string} path - 路徑。
 * @returns {object} 封存資料。
 */
function readArchiveFile(path) {
  if (!existsSync(path)) return { version: 1, turns: [], days: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, turns: [], days: [] };
  } catch {
    return { version: 1, turns: [], days: [] };
  }
}

/**
 * 一行摘要（≤50 字元）。
 *
 * @param {object} data - build() 的輸出。
 * @returns {string} 摘要。
 */
function summaryOf(data) {
  if (!data?.ok) return `用量資料不可用（${data?.message ?? '未知原因'}）`;
  const bits = [];
  if (data.status?.model) bits.push(data.status.model);
  if (data.status?.percent !== null && data.status?.percent !== undefined) bits.push(`已用 ${data.status.percent}%`);
  else if (data.status?.used) bits.push(`已用 ${data.status.used}`);
  if (data.today?.amount) bits.push(`今日 ${data.today.amount.toFixed(2)}`);
  let text = bits.join(' · ') || '本會話暫無用量';
  if (text.length > 50) text = `${text.slice(0, 49)}…`;
  return text;
}

/**
 * 人類可讀的現況。
 *
 * @param {object} data - build() 的輸出。
 * @returns {string} 文字。
 */
function statusText(data) {
  if (!data?.ok) return `用量資料不可用：${data?.message ?? ''}`;
  const s = data.status;
  const lines = [
    `會話    ${s.sessionId ?? '—'}`,
    `模型    ${s.model ?? '—'}`,
    `已用    ${s.used}${s.size ? ` / ${s.size}` : ''}${s.percent !== null ? `（${s.percent}%）` : ''}`,
    `剩餘    ${s.remaining}`,
    `更新    ${s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '—'}`,
    `今日    ${data.today.amount.toFixed(2)}（${data.today.count} 筆）`,
  ];
  return lines.join('\n');
}

/**
 * 人類可讀的帳本。
 *
 * @param {object} data - build() 的輸出。
 * @returns {string} 文字。
 */
function ledgerText(data) {
  if (!data?.ok) return `用量資料不可用：${data?.message ?? ''}`;
  const lines = ['逐日彙總（最近）:'];
  for (const day of data.ledger.days.slice().reverse()) {
    lines.push(`  ${day.date}  ${day.amount.toFixed(2)}  ${day.count} 筆`);
  }
  lines.push('逐輪明細（最近）:');
  for (const turn of data.ledger.turns) {
    const when = turn.ts ? new Date(turn.ts).toLocaleString() : '—';
    lines.push(`  ${when}  ${turn.amount.toFixed(2)}  ${turn.model ?? '—'}  ${turn.sessionId}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) return fallback;
  return next;
};

if (flag('--help') || flag('-h')) {
  process.stdout.write(USAGE + '\n');
  process.exit(0);
}

if (flag('--selftest')) {
  const result = runSelfTest();
  process.stdout.write('\n===== 記賬自測 =====\n');
  for (const line of result.lines) process.stdout.write(line + '\n');
  process.stdout.write(result.ok ? '\n自測通過。\n' : '\n自測未通過（見上方 FAIL 行）。\n');
  process.exit(result.ok ? 0 : 1);
}

let data;
try {
  data = build({ days: Number(value('--days', 30)) || 30, turns: Number(value('--turns', 20)) || 20 });
} catch (error) {
  data = { ok: false, reason: 'unexpected', message: error instanceof Error ? error.message : String(error) };
}

// ★ 順序很重要：--json 一律優先。
//   MCP 是用 `usage.mjs --json [--status|--today|--ledger]` 呼叫的，
//   那些旗標在 JSON 模式下只是「想看哪一段」的提示，輸出仍是完整 JSON
//   （MCP 端各自從 data.status / data.today / data.ledger 取）。
//   人類可讀的文字模式只在沒有 --json 時才啟用。
if (flag('--json')) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  process.exit(data.ok ? 0 : 1);
}
if (flag('--summary')) {
  process.stdout.write(summaryOf(data) + '\n');
  process.exit(data.ok ? 0 : 1);
}
if (flag('--status')) {
  process.stdout.write(statusText(data) + '\n');
  process.exit(data.ok ? 0 : 1);
}
if (flag('--today')) {
  process.stdout.write(`今日 ${data.ok ? data.today.amount.toFixed(2) : '—'}（${data.ok ? data.today.count : 0} 筆）\n`);
  process.exit(data.ok ? 0 : 1);
}
if (flag('--ledger')) {
  process.stdout.write(ledgerText(data) + '\n');
  process.exit(data.ok ? 0 : 1);
}

process.stdout.write(`${JSON.stringify({ ...data, summary: summaryOf(data) }, null, 2)}\n`);
process.exit(data.ok ? 0 : 1);
