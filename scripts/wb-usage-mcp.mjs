#!/usr/bin/env node
/**
 * 記賬掛件（WorkBuddy 版）— MCP 伺服器
 *
 * 【為什麼是「呼叫 CLI」而不是直接讀資料庫】
 * 記賬核心（accounting.mjs / usage.mjs）是另一位同事的職責，資料形狀還會變。
 * 這裡只負責「把 CLI 的輸出轉成 MCP 工具的回覆」，
 * 對核心的認識僅限一份契約（--json 的輸出形狀），
 * 核心改版時只要契約沒變，這裡一行都不用動 —— 零耦合。
 *
 * 【CLI 契約】（另一位同事實作，這裡照這份呼叫）
 *   node "<plugin-root>/scripts/usage.mjs" --json            # 全部
 *   node "<plugin-root>/scripts/usage.mjs" --json --status   # 只回現況
 *   node "<plugin-root>/scripts/usage.mjs" --json --today    # 只回今日
 *   node "<plugin-root>/scripts/usage.mjs" --json --ledger   # 只回帳本
 *   node "<plugin-root>/scripts/usage.mjs" --summary         # ≤50 字元單行
 *
 * 輸出形狀：
 *   { ok:true,
 *     status: { sessionId, model, used, size, remaining, percent, updatedAt },
 *     today:  { amount, count },
 *     ledger: { days:[{date,amount,count}], turns:[{ts,sessionId,amount,model}] } }
 * 失敗時 stdout 仍是 JSON：{ ok:false, reason:"…", message:"…" }，exit code 非 0。
 *
 * 【協定】
 *   stdin  ：一行一個 JSON-RPC 2.0 訊息
 *   stdout ：一行一個 JSON-RPC 2.0 回應（**只准走協定**，任何非 JSON 都會污染回應）
 *   stderr ：日誌
 *
 * 協定版本：app.asar 內 MCP SDK 的 LATEST = 2025-11-25，
 * 支援 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 / 2024-10-07。
 *
 * 【安靜原則】
 * 成功與失敗都不往 stdout 印非 JSON 的東西；錯誤只寫 stderr。
 * 工具失敗回 isError:true + 人話訊息，不要讓整條 MCP 連線掛掉。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_NAME = 'fatfish-usage';
const SERVER_VERSION = '1.0.0';
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

/** CLI 逾時（毫秒）。讀本機 sqlite 很快，給 15 秒當保險。 */
const CLI_TIMEOUT_MS = 15000;

/** 帳本逐輪顯示上限（避免回覆爆掉；資料本身不截）。 */
const DEFAULT_TURN_ROWS = 20;

const TOOLS = [
  {
    name: 'usage_status',
    description:
      '查 WorkBuddy 目前工作階段的額度現況：已用 / 總額 / 剩餘 / 已用百分比 / 模型 / 更新時間。'
      + '當使用者問「還剩多少額度」「用了多少」「配額還有嗎」時使用。資料來自本機 workbuddy.db（唯讀、不聯網）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'usage_today',
    description:
      '查今天的額度消耗：今日總量與輪數。當使用者問「我今天用了多少」「今天燒掉多少」時使用。'
      + '數字是額度點數，不是金額，不要換算成錢。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'usage_ledger',
    description:
      '查額度帳本：逐日彙總（日期／總量／輪數）與最近逐輪明細（時間／工作階段／量／模型）。'
      + '當使用者問「帳本」「記賬」「消耗明細」「最近花在哪」時使用。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: `逐輪明細要顯示幾筆（預設 ${DEFAULT_TURN_ROWS}，0 或省略＝預設值）。`,
          minimum: 0,
        },
      },
    },
  },
];

function log(message) {
  process.stderr.write(`[fatfish-usage-mcp] ${message}\n`);
}

/** 寫一行 JSON-RPC 回應到 stdout。 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

// ─────────────────────────────────────────────────────────────
// CLI 呼叫
// ─────────────────────────────────────────────────────────────

/**
 * CLI 位置：預設是同一個 scripts 目錄底下的 usage.mjs。
 * 可用 WORKBUDDY_USAGE_CLI 覆寫（測試、或記賬核心放在別處時用）。
 */
function resolveCliPath() {
  const override = (process.env.WORKBUDDY_USAGE_CLI || '').trim();
  if (override) return override;
  return path.join(HERE, 'usage.mjs');
}

/**
 * 跑一次 CLI 並解析它的 JSON。
 * @returns {Promise<{ok:boolean, data:object|null, message:string}>}
 */
async function callCli(flags) {
  const cli = resolveCliPath();
  if (!existsSync(cli)) {
    return {
      ok: false,
      data: null,
      message: `找不到記賬 CLI：${cli}（記賬核心 usage.mjs 尚未就位）`,
    };
  }

  // 用 process.execPath（就是正在跑這個 server 的 node）而不是 PATH 上的 "node"：
  // hook / MCP 的執行環境不一定有 node 在 PATH 上，但自己的執行檔一定在。
  const args = [cli, '--json', ...flags];

  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });

    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      return {
        ok: false,
        data: null,
        message: `記賬 CLI 的輸出不是合法 JSON：${String(stdout).slice(0, 200)}`,
      };
    }

    if (!data || typeof data !== 'object') {
      return { ok: false, data: null, message: '記賬 CLI 回傳的東西不是物件' };
    }
    if (data.ok === false) {
      // 契約：失敗時是 { ok:false, reason, message }。
      // 舊版 CLI 用的是 { ok:false, error, hint } —— 兩個都收，避免版本落差就整個不能用。
      const message = data.message || data.error || data.reason || '記賬 CLI 回報失敗';
      return { ok: false, data, message: String(message) };
    }
    return { ok: true, data, message: '' };
  } catch (err) {
    const code = err && err.code;
    if (code === 'ETIMEDOUT') {
      return { ok: false, data: null, message: `記賬 CLI 逾時（${CLI_TIMEOUT_MS / 1000}s）` };
    }
    const stderrText = err && err.stderr ? String(err.stderr).trim().slice(0, 300) : '';
    return {
      ok: false,
      data: null,
      message: `記賬 CLI 執行失敗${stderrText ? `：${stderrText}` : ''}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// 形狀正規化（canonical 優先，舊版形狀做 fallback）
// ─────────────────────────────────────────────────────────────

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 正規化 status。canonical: data.status；舊版: data.session + data.usage。 */
function normalizeStatus(data) {
  if (data && data.status && typeof data.status === 'object') {
    const s = data.status;
    return {
      sessionId: typeof s.sessionId === 'string' ? s.sessionId : null,
      model: typeof s.model === 'string' ? s.model : null,
      used: num(s.used) ?? 0,
      size: num(s.size) ?? 0,
      remaining: num(s.remaining) ?? Math.max(0, (num(s.size) ?? 0) - (num(s.used) ?? 0)),
      percent: num(s.percent),
      updatedAt: num(s.updatedAt),
    };
  }

  // 舊版形狀：{ ok, db, session:{id,model,...}, usage:{used,size,remaining,percent}, credit:{...} }
  if (data && (data.session || data.usage)) {
    const s = data.session || {};
    const u = data.usage || {};
    const used = num(u.used) ?? 0;
    const size = num(u.size) ?? 0;
    return {
      sessionId: typeof s.id === 'string' ? s.id : null,
      model: typeof s.model === 'string' ? s.model : null,
      used,
      size,
      remaining: num(u.remaining) ?? Math.max(0, size - used),
      percent: num(u.percent),
      updatedAt: num(s.lastActivityAt) ?? num(s.updatedAt),
      derived: true, // 標記：這是從舊版形狀換算來的，數字口徑以新版為準
    };
  }
  return null;
}

/** 正規化 today。canonical: data.today；舊版: 由 credit 加總推算。 */
function normalizeToday(data) {
  if (data && data.today && typeof data.today === 'object') {
    return {
      amount: num(data.today.amount) ?? 0,
      count: num(data.today.count) ?? 0,
      derived: false,
    };
  }
  const fromCredit = creditTotal(data);
  if (fromCredit) {
    return { amount: fromCredit.amount, count: fromCredit.count, derived: true };
  }
  return null;
}

/** 舊版 credit（{ turnId: amount }）→ 合計與筆數。 */
function creditTotal(data) {
  const credit = data && data.credit;
  if (!credit || typeof credit !== 'object' || Array.isArray(credit)) return null;
  const values = Object.values(credit).map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (values.length === 0) return null;
  return {
    amount: Math.round(values.reduce((a, b) => a + b, 0) * 1e6) / 1e6,
    count: values.length,
  };
}

/** 正規化 ledger。canonical: data.ledger；舊版: 只能用 today 湊一個當日條目。 */
function normalizeLedger(data, today) {
  if (data && data.ledger && typeof data.ledger === 'object') {
    const days = Array.isArray(data.ledger.days) ? data.ledger.days : [];
    const turns = Array.isArray(data.ledger.turns) ? data.ledger.turns : [];
    return {
      days: days
        .filter((d) => d && typeof d === 'object')
        .map((d) => ({ date: String(d.date ?? ''), amount: num(d.amount) ?? 0, count: num(d.count) ?? 0 })),
      turns: turns
        .filter((t) => t && typeof t === 'object')
        .map((t) => ({
          ts: num(t.ts),
          sessionId: typeof t.sessionId === 'string' ? t.sessionId : null,
          amount: num(t.amount) ?? 0,
          model: typeof t.model === 'string' ? t.model : null,
        })),
      derived: false,
    };
  }
  if (today && today.derived) {
    return {
      days: [{ date: localDate(Date.now()), amount: today.amount, count: today.count }],
      turns: [],
      derived: true,
    };
  }
  return { days: [], turns: [], derived: false };
}

// ─────────────────────────────────────────────────────────────
// 人話格式化
// ─────────────────────────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地時間 YYYY-MM-DD HH:mm（不依賴 locale，避免機器設定不同就換格式）。 */
function localStamp(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本地日期 YYYY-MM-DD。 */
function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 額度點數用千分位顯示，避免「93041」這種沒人看得懂的數字。 */
function points(n) {
  const v = num(n);
  if (v === null) return '—';
  const rounded = Math.round(v * 100) / 100;
  return rounded.toLocaleString('en-US');
}

/**
 * 口徑提醒：這些數字是「額度點數」，不是金額。
 * 每一則回覆都帶上這句（或它的變體），避免 Agent 自己換算成錢。
 */
const UNIT_NOTE = '（單位是額度點數，不是金額，不要換算成錢）';

// ─────────────────────────────────────────────────────────────
// 工具實作
// ─────────────────────────────────────────────────────────────

async function toolUsageStatus() {
  const r = await callCli(['--status']);
  if (!r.ok) {
    return { isError: true, ...textContent(`查不到額度現況：${r.message}`) };
  }
  const s = normalizeStatus(r.data);
  if (!s) {
    return { isError: true, ...textContent('記賬 CLI 沒有回傳任何額度現況資料。') };
  }

  const lines = [];
  lines.push(`目前工作階段${s.model ? `（${s.model}）` : ''}的額度現況：`);
  lines.push(`- 已用 ${points(s.used)} / 總額 ${points(s.size)} 額度點`);
  if (s.percent !== null) lines.push(`- 已用 ${Math.round(s.percent * 10) / 10}%，剩 ${points(s.remaining)}`);
  else lines.push(`- 剩 ${points(s.remaining)}（這個階段沒有額度配額，算不出百分比）`);
  lines.push(`- 更新時間 ${localStamp(s.updatedAt)}`);
  if (s.sessionId) lines.push(`- session ${s.sessionId}`);
  if (s.derived) lines.push('- ⚠️ 這份資料是從舊版 CLI 輸出換算來的，口徑以新版為準');
  lines.push(UNIT_NOTE);

  return { ...textContent(lines.join('\n')), isError: false };
}

async function toolUsageToday() {
  const r = await callCli(['--today']);
  if (!r.ok) {
    return { isError: true, ...textContent(`查不到今日用量：${r.message}`) };
  }
  const t = normalizeToday(r.data);
  if (!t) {
    return { isError: true, ...textContent('記賬 CLI 沒有回傳今日用量資料。') };
  }

  const lines = [];
  lines.push(`今天（${localDate(Date.now())}）的額度消耗：`);
  lines.push(`- 共 ${points(t.amount)} 額度點，${t.count} 輪`);
  if (t.derived) lines.push('- ⚠️ 這份資料是由 credit 明細加總推算的，口徑以新版為準');
  lines.push(UNIT_NOTE);

  return { ...textContent(lines.join('\n')), isError: false };
}

async function toolUsageLedger(args) {
  const limitRaw = args && args.limit;
  const limit = Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
    ? Math.floor(Number(limitRaw))
    : DEFAULT_TURN_ROWS;

  const r = await callCli(['--ledger']);
  if (!r.ok) {
    return { isError: true, ...textContent(`查不到帳本：${r.message}`) };
  }
  const today = normalizeToday(r.data);
  const ledger = normalizeLedger(r.data, today);
  if (!ledger) {
    return { isError: true, ...textContent('記賬 CLI 沒有回傳帳本資料。') };
  }

  const lines = [];
  lines.push('額度帳本：');

  if (ledger.days.length === 0) {
    lines.push('- 逐日彙總：目前沒有紀錄');
  } else {
    lines.push('- 逐日彙總：');
    for (const d of ledger.days) {
      lines.push(`  · ${d.date}　${points(d.amount)} 額度點　${d.count} 輪`);
    }
  }

  if (ledger.turns.length === 0) {
    lines.push('- 逐輪明細：目前沒有紀錄');
  } else {
    const shown = ledger.turns.slice(0, limit);
    lines.push(`- 逐輪明細（最近 ${shown.length} 筆）：`);
    for (const t of shown) {
      const who = t.model || t.sessionId || '—';
      lines.push(`  · ${localStamp(t.ts)}　${who}　${points(t.amount)} 額度點`);
    }
    if (ledger.turns.length > shown.length) {
      lines.push(`  （還有 ${ledger.turns.length - shown.length} 筆未顯示，可用 limit 參數調整）`);
    }
  }

  if (ledger.derived) lines.push('- ⚠️ 這份帳本是由舊版 CLI 輸出換算來的，口徑以新版為準');
  lines.push(UNIT_NOTE);

  return { ...textContent(lines.join('\n')), isError: false };
}

function callTool(name, args) {
  switch (name) {
    case 'usage_status':
      return toolUsageStatus();
    case 'usage_today':
      return toolUsageToday();
    case 'usage_ledger':
      return toolUsageLedger(args);
    default:
      return { isError: true, ...textContent(`未知的工具：${name}`) };
  }
}

// ─────────────────────────────────────────────────────────────
// JSON-RPC 分派
// ─────────────────────────────────────────────────────────────

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      if (!isNotification) {
        sendResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }
      return;
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return;

    case 'ping':
      if (!isNotification) sendResult(id, {});
      return;

    case 'tools/list':
      if (!isNotification) sendResult(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      if (isNotification) return;
      const name = params && typeof params.name === 'string' ? params.name : '';
      const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      // 工具是 async 的（要 spawn CLI），所以要記著「還有多少在跑」，
      // 否則 stdin 一關、process.exit(0) 就會把還沒回應的呼叫砍掉。
      inflight += 1;
      try {
        sendResult(id, await callTool(name, args));
      } catch (err) {
        // 工具層級的意外不該讓整條連線掛掉。
        log(`tool ${name} failed: ${err && err.stack ? err.stack : String(err)}`);
        sendResult(id, {
          isError: true,
          ...textContent(`工具 ${name} 執行失敗：${err && err.message ? err.message : String(err)}`),
        });
      } finally {
        inflight -= 1;
        maybeExit();
      }
      return;
    }

    case 'resources/list':
      if (!isNotification) sendResult(id, { resources: [] });
      return;

    case 'prompts/list':
      if (!isNotification) sendResult(id, { prompts: [] });
      return;

    default:
      if (!isNotification) sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 主迴圈：stdin 一行一個 JSON
// ─────────────────────────────────────────────────────────────

/**
 * 進行中的非同步工具呼叫數。
 *
 * 為什麼要數：工具要 spawn CLI（~100ms+），客戶端可能送完 request 就關 stdin。
 * 若 stdin 一 end 就 process.exit(0)，還沒回完的呼叫會被砍掉、客戶端只收到 initialize 的回應。
 * 所以改成「stdin 結束 → 等所有進行中的呼叫收工 → 才退出」。
 */
let inflight = 0;
let stdinEnded = false;
let exitTimer = null;

/** stdin 已結束且沒有進行中的呼叫 → 可以退出了。 */
function maybeExit() {
  if (!stdinEnded || inflight > 0) return;
  process.exit(0);
}

/** 保險：進行中的呼叫卡住時不要讓行程永遠活著。 */
function armExitTimer() {
  if (exitTimer) return;
  exitTimer = setTimeout(() => {
    if (inflight > 0) {
      log(`forced exit with ${inflight} in-flight tool call(s)`);
    }
    process.exit(0);
  }, CLI_TIMEOUT_MS + 5000);
  if (typeof exitTimer.unref === 'function') exitTimer.unref();
}

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handleMessage(JSON.parse(line));
      } catch (err) {
        log(`failed to parse message: ${err && err.message ? err.message : String(err)}`);
      }
    }
    index = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  const line = buffer.trim();
  if (line) {
    try {
      handleMessage(JSON.parse(line));
    } catch { /* 收尾殘留資料解析失敗就忽略 */ }
  }
  stdinEnded = true;
  if (inflight > 0) armExitTimer();
  maybeExit();
});

process.stdin.on('error', (err) => {
  log(`stdin error: ${err && err.message ? err.message : String(err)}`);
  stdinEnded = true;
  maybeExit();
});
