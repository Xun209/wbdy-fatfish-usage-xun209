/**
 * WorkBuddy 記賬核心：逐輪明細 + 逐日彙總的金額帳本。
 *
 * ── 這是 DSH 版 `lib/accounting.mjs` 的 WorkBuddy 移植 ──────────────────────
 * 參考：`dsh-whale-widget-fork/lib/accounting.mjs`（MIT）。
 *
 * 兩邊的差異在「觀測是什麼」：
 *   DSH 版觀測的是**帳戶餘額**（餘額下降 = 消費、上升 = 需核對的調整），
 *   所以要處理校正（correction）與「待核對」狀態。
 *   WorkBuddy 的 `session_usage.credit_json` 直接給了**逐筆的真實金額**
 *   （`{"<itemId>": 金額}`），所以：
 *     · 消費是「已知金額」，不需要用餘額差去推，也不需要人工校正；
 *     · 但仍要處理「同一筆的金額被下修/沖回」（refund）→ 記成 credit；
 *     · 逐輪明細因此是**真實的逐筆金額**，而不是估算。
 *   其餘模型（8 位小數定點、逐日列、保留期、封存）與 DSH 版同構。
 *
 * 金額一律用 8 位小數定點（單位 = 金額 × 1e8）計算：
 *   `credit_json` 的值是浮點（0.45999999999999996），直接用浮點累加會漂。
 *
 * 帳本結構（與 DSH 版同構）：
 *   {
 *     version, accounting: { version, active, books: { <scope>: { days: { <day>: row } } } },
 *     history, date, dayStart, lastBalance, todayUsage
 *   }
 *   `scope` 在 DSH 版是「帳戶／金鑰指紋」，在 WorkBuddy 版是**會話 id**
 *   （每個會話有各自的額度 used/size，天然就是一本分帳）。
 *
 * @module wbdy-fatfish-usage/scripts/accounting
 */

import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 帳本格式版本。改了結構就要 +1（舊帳本會被視為不可讀，重新起一本）。 */
export const ACCOUNTING_VERSION = 1;

/** 金額定點刻度：1 單位 = 1e-8 元（8 位小數，與 DSH 版一致）。 */
export const SCALE = 100000000;

/** 逐輪明細保留天數（與 DSH 版一致：90 天）。 */
export const TURN_RETENTION_DAYS = 90;

/** 逐輪明細最多保留筆數（與 DSH 版一致：2 萬條）。 */
export const TURN_RETENTION_MAX = 20000;

/** 逐日彙總保留天數（與 DSH 版一致：365 天）。 */
export const DAY_RETENTION_DAYS = 365;

/** 幣種。WorkBuddy 的 credit_json 沒有幣種欄位，一律當 CNY（與 DSH 版事件估算同口徑）。 */
export const CURRENCY = 'CNY';

/**
 * 金額 → 定點單位。
 *
 * @param {number|string} value - 金額。
 * @returns {number} 定點單位（整數）。
 */
export function moneyUnits(value) {
  const n = Number(value);
  const units = Math.round(n * SCALE);
  if (!Number.isFinite(n) || !Number.isSafeInteger(units)) throw new Error('金额无效或超出可记账范围');
  return units;
}

/**
 * 定點單位 → 金額。
 *
 * @param {number} units - 定點單位。
 * @returns {number} 金額。
 */
export function preciseMoney(units) {
  return units / SCALE;
}

/**
 * 加總金額。
 *
 * @param {Array<number|string>} values - 金額清單。
 * @returns {number} 合計金額。
 */
export function sumMoney(values) {
  let units = 0;
  for (const value of values) units += moneyUnits(value);
  if (!Number.isSafeInteger(units)) throw new Error('金额合计超出可记账范围');
  return units / SCALE;
}

/**
 * 加兩個金額。
 *
 * @param {number|string} a - 第一個金額。
 * @param {number|string} b - 第二個金額。
 * @returns {number} 合計。
 */
export function addMoney(a, b) {
  return sumMoney([a, b]);
}

/**
 * 北京時間的日期 key（YYYY-MM-DD）。
 *
 * 為什麼固定用北京時間：帳本的「今日」要跟使用者看到的日曆日一致，
 * 而 WorkBuddy 是中國大陸的產品（DSH 版也是同一個口徑）。
 *
 * @param {number} [time] - 毫秒時間戳。
 * @returns {string} 日期 key。
 */
export function beijingDay(time = Date.now()) {
  const d = new Date(Number(time) + 8 * 3600000);
  if (!Number.isFinite(d.getTime())) throw new Error('无效的观测时间');
  return d.toISOString().slice(0, 10);
}

/**
 * 日期 key 加減天數。
 *
 * @param {string} day - 日期 key。
 * @param {number} offset - 天數偏移（可負）。
 * @returns {string} 新的日期 key。
 */
export function dayOffset(day, offset) {
  return beijingDay(Date.parse(day + 'T00:00:00+08:00') + offset * 86400000);
}

/**
 * 新帳本。
 *
 * @param {number} [at] - 建立時間。
 * @returns {object} 空帳本。
 */
export function emptyLedger(at = Date.now()) {
  return {
    version: 1,
    accounting: {
      version: ACCOUNTING_VERSION,
      active: '',
      books: {},
      migratedAt: at,
    },
    history: {},
    date: '',
    dayStart: 0,
    lastBalance: 0,
    todayUsage: 0,
  };
}

/**
 * 目前這一本帳（active scope）。
 *
 * @param {object} ledger - 帳本。
 * @returns {object|null} 帳本本體。
 */
export function currentBook(ledger) {
  const a = ledger?.accounting;
  return a && a.version === ACCOUNTING_VERSION && a.books && a.books[a.active] ? a.books[a.active] : null;
}

/**
 * 所有分帳（DSH 版換金鑰後舊帳本要看得見 —— 同一個道理：換會話後舊帳本別消失）。
 *
 * @param {object} ledger - 帳本。
 * @returns {Array<{scope: string, book: object, active: boolean}>} 分帳清單。
 */
export function booksOf(ledger) {
  const a = ledger?.accounting;
  if (!a || a.version !== ACCOUNTING_VERSION || !a.books) return [];
  return Object.keys(a.books).map((scope) => ({
    scope,
    book: a.books[scope],
    active: scope === a.active,
  }));
}

/**
 * 核心：吃一次觀測，更新帳本。
 *
 * 觀測的形狀：
 *   {
 *     at: number,            // 觀測時間（毫秒）
 *     sessionId: string,     // 分帳 key（一個會話一本帳）
 *     model?: string|null,   // 該會話的模型
 *     title?: string|null,   // 該會話的標題
 *     items: Array<{id: string, amount: number}>,  // 逐筆金額（credit_json）
 *   }
 *
 * 語意：items 是「累計值」快照 —— 同一個 id 再出現一次，
 * 金額增加 = 又花了一筆（記 debit），金額減少 = 被下修/退款（記 credit）。
 *
 * @param {object} ledger - 帳本（會被就地更新）。
 * @param {object} observation - 觀測。
 * @returns {object} 當日的摘要。
 */
export function observeUsage(ledger, observation) {
  const at = Number(observation?.at ?? Date.now());
  if (!Number.isFinite(at)) throw new Error('觀測時間無效');
  const scope = String(observation?.sessionId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(scope)) throw new Error('會話標識無效');
  const day = beijingDay(at);
  const items = Array.isArray(observation?.items) ? observation.items : [];

  const a = ledger.accounting;
  if (!a || a.version !== ACCOUNTING_VERSION) {
    // 舊格式沒有可信的餘額基準 → 留著當參考，重新起一本明確的觀測窗。
    ledger.accounting = {
      version: ACCOUNTING_VERSION,
      active: scope,
      books: {},
      migratedAt: at,
      legacyHistory: { ...(ledger.history || {}) },
    };
  }
  const books = ledger.accounting.books;
  let book = books[scope];
  if (!book) book = books[scope] = { currency: CURRENCY, model: observation.model ?? null, title: observation.title ?? null, days: {} };
  if (observation.model) book.model = observation.model;
  if (observation.title) book.title = observation.title;
  ledger.accounting.active = scope;

  let row = book.days[day];
  if (!row) {
    row = book.days[day] = {
      day,
      firstAt: at,
      lastAt: at,
      openingUnits: 0,
      lastUnits: 0,
      debitUnits: 0,
      creditUnits: 0,
      revision: 0,
      correction: null,
      turns: {},
      turnCount: 0,
    };
  }

  // 逐筆比對：金額增加 = 消費；減少 = 沖回（記 credit，不會蓋掉已記的消費）。
  let debit = 0;
  let credit = 0;
  let newTurns = 0;
  for (const item of items) {
    const id = String(item?.id ?? '');
    if (id === '') continue;
    const amountUnits = moneyUnits(item?.amount ?? 0);
    const known = row.turns[id];
    if (!known) {
      row.turns[id] = { amountUnits, at, model: observation.model ?? null, sessionId: scope };
      row.turnCount += 1;
      newTurns += 1;
      debit += amountUnits;
      continue;
    }
    const delta = amountUnits - known.amountUnits;
    if (delta === 0) continue;
    if (delta > 0) debit += delta;
    else credit += -delta;
    known.amountUnits = amountUnits;
    known.at = at;
  }

  row.debitUnits += debit;
  row.creditUnits += credit;
  row.lastUnits += debit - credit;
  row.lastAt = at;
  if (newTurns > 0 || debit !== 0 || credit !== 0) row.revision = (row.revision || 0) + 1;
  book.lastAt = at;

  const summary = daySummary(ledger, day);
  ledger.date = day;
  ledger.dayStart = row.openingUnits / SCALE;
  ledger.lastBalance = row.lastUnits / SCALE;
  ledger.todayUsage = summary.amount;
  ledger.history = ledger.history || {};
  ledger.history[day] = summary.amount;
  return summary;
}

/**
 * 某一天的摘要（跨所有分帳）。
 *
 * @param {object} ledger - 帳本。
 * @param {string} day - 日期 key。
 * @returns {object|null} 摘要；沒有資料回 null。
 */
export function daySummary(ledger, day) {
  const books = booksOf(ledger);
  let total = 0;
  let count = 0;
  let firstAt = null;
  let lastAt = null;
  let found = false;
  for (const { book } of books) {
    const row = book.days?.[day];
    if (!row) continue;
    found = true;
    total += row.debitUnits - row.creditUnits;
    count += row.turnCount || Object.keys(row.turns || {}).length;
    if (firstAt === null || row.firstAt < firstAt) firstAt = row.firstAt;
    if (lastAt === null || row.lastAt > lastAt) lastAt = row.lastAt;
  }
  if (!found) return null;
  return {
    date: day,
    amount: preciseMoney(total),
    count,
    currency: CURRENCY,
    firstObservedAt: firstAt,
    lastObservedAt: lastAt,
  };
}

/**
 * 所有分帳的日期並集（照 DSH 版：換帳戶後舊日期也要看得到）。
 *
 * @param {object} ledger - 帳本。
 * @returns {string[]} 排序後的日期清單。
 */
export function ledgerDays(ledger) {
  const set = new Set();
  for (const { book } of booksOf(ledger)) {
    for (const day of Object.keys(book.days || {})) set.add(day);
  }
  return Array.from(set).sort();
}

/**
 * 逐輪明細（最近 n 筆，依時間倒序）。
 *
 * @param {object} ledger - 帳本。
 * @param {object} options - 選項。
 * @param {number} [options.limit] - 最多回傳幾筆。
 * @param {string} [options.day] - 只看某一天。
 * @returns {Array<{ts: number, sessionId: string, amount: number, model: string|null}>} 逐輪明細。
 */
export function turnsOf(ledger, { limit = 20, day = '' } = {}) {
  const out = [];
  for (const { scope, book } of booksOf(ledger)) {
    for (const [rowDay, row] of Object.entries(book.days || {})) {
      if (day && rowDay !== day) continue;
      for (const turn of Object.values(row.turns || {})) {
        out.push({
          ts: Number(turn.at) || 0,
          sessionId: turn.sessionId || scope,
          amount: preciseMoney(Number(turn.amountUnits) || 0),
          model: turn.model ?? null,
        });
      }
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, Math.max(0, Number(limit) || 0));
}

/**
 * 保留期清理：超期的逐輪明細與逐日列要移出主帳本（不丟資料，移到封存檔）。
 *
 * @param {object} ledger - 帳本（會被就地更新）。
 * @param {object} options - 選項。
 * @param {number} [options.now] - 現在時間。
 * @param {number} [options.turnDays] - 逐輪保留天數。
 * @param {number} [options.turnMax] - 逐輪最多筆數。
 * @param {number} [options.dayDays] - 逐日保留天數。
 * @returns {{ledger: object, archived: {turns: object[], days: object[]}}} 結果。
 */
export function pruneLedger(ledger, { now = Date.now(), turnDays = TURN_RETENTION_DAYS, turnMax = TURN_RETENTION_MAX, dayDays = DAY_RETENTION_DAYS } = {}) {
  const turnCut = dayOffset(beijingDay(now), -turnDays);
  const dayCut = dayOffset(beijingDay(now), -dayDays);
  const archived = { turns: [], days: [] };

  for (const { scope, book } of booksOf(ledger)) {
    for (const [day, row] of Object.entries(book.days || {})) {
      // 逐輪：超期或超量的移出
      const turns = Object.entries(row.turns || {});
      turns.sort((a, b) => (Number(a[1].at) || 0) - (Number(b[1].at) || 0));
      for (const [id, turn] of turns) {
        const expired = day < turnCut;
        if (expired) {
          archived.turns.push({ scope, day, id, ...turn });
          delete row.turns[id];
          row.turnCount = Math.max(0, (row.turnCount || 0) - 1);
        }
      }
      // 逐日：超期的整列移出
      if (day < dayCut) {
        archived.days.push({ scope, day, ...row, turns: undefined });
        delete book.days[day];
      }
    }
  }
  // 超量的逐輪（超過 turnMax）→ 移出最舊的
  const allTurns = [];
  for (const { scope, book } of booksOf(ledger)) {
    for (const [day, row] of Object.entries(book.days || {})) {
      for (const [id, turn] of Object.entries(row.turns || {})) allTurns.push({ scope, day, id, turn });
    }
  }
  if (allTurns.length > turnMax) {
    allTurns.sort((a, b) => (Number(a.turn.at) || 0) - (Number(b.turn.at) || 0));
    for (const entry of allTurns.slice(0, allTurns.length - turnMax)) {
      const book = ledger.accounting.books[entry.scope];
      const row = book?.days?.[entry.day];
      if (!row?.turns) continue;
      archived.turns.push({ scope: entry.scope, day: entry.day, id: entry.id, ...entry.turn });
      delete row.turns[entry.id];
      row.turnCount = Math.max(0, (row.turnCount || 0) - 1);
    }
  }
  return { ledger, archived };
}

/**
 * 帳本目錄。
 *
 * 優先序：
 *   1. WORKBUDDY_USAGE_DIR —— 明確指定
 *   2. WORKBUDDY_WHALE_STATE_DIR\usage —— 與寵物主機同一個狀態根
 *   3. %LOCALAPPDATA%\workbuddy-whale\usage —— 預設
 *   4. ~/.workbuddy-whale\usage
 *
 * @param {object} [env] - 環境變數（測試可注入）。
 * @returns {string} 帳本目錄。
 */
export function resolveUsageDir(env = process.env) {
  const explicit = (env.WORKBUDDY_USAGE_DIR || '').trim();
  if (explicit) return explicit;
  const stateDir = (env.WORKBUDDY_WHALE_STATE_DIR || '').trim();
  if (stateDir) return join(stateDir, 'usage');
  const localAppData = (env.LOCALAPPDATA || '').trim();
  if (localAppData) return join(localAppData, 'workbuddy-whale', 'usage');
  return join(homedir(), '.workbuddy-whale', 'usage');
}

/**
 * 帳本檔路徑。
 *
 * @param {string} dir - 帳本目錄。
 * @returns {string} 帳本檔路徑。
 */
export function ledgerPath(dir) {
  return join(dir, 'usage-ledger.json');
}

/**
 * 封存檔路徑（對應 DSH 版的 `.dshw-usage-archive.json`）。
 *
 * @param {string} dir - 帳本目錄。
 * @returns {string} 封存檔路徑。
 */
export function archivePath(dir) {
  return join(dir, 'usage-archive.json');
}

/**
 * 私有 JSON 寫入（與 DSH 版 `writePrivateJson` 同口徑）。
 *
 * 為什麼要「暫存 + rename」：直接寫會有「寫到一半被讀到」的視窗；
 * rename 在同一個磁碟上是原子的。權限 0600 是為了不讓同機其它帳號看到金額明細。
 *
 * @param {string} path - 目標路徑。
 * @param {unknown} data - 資料。
 */
export function writePrivateJson(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* ignore */ }
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch { /* Windows 上沒有 POSIX 權限概念，忽略 */ }
}

/**
 * 讀私有 JSON；不存在或壞掉回 null（不讓帳本問題拖垮查詢）。
 *
 * @param {string} path - 路徑。
 * @returns {object|null} 資料。
 */
export function readPrivateJson(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 讀帳本；不存在或版本不符回一份空的。
 *
 * @param {string} dir - 帳本目錄。
 * @returns {object} 帳本。
 */
export function readLedger(dir) {
  const data = readPrivateJson(ledgerPath(dir));
  if (!data || !data.accounting || data.accounting.version !== ACCOUNTING_VERSION) return emptyLedger();
  return data;
}

/**
 * 把封存檔併回帳本（用於「看得到歷史」的查詢）。
 *
 * @param {object} ledger - 帳本。
 * @param {object|null} archive - 封存資料。
 * @returns {object} 合併後的帳本（不修改傳入的 ledger）。
 */
export function mergeArchive(ledger, archive) {
  if (!archive || !Array.isArray(archive.days) || archive.days.length === 0) return ledger;
  const merged = JSON.parse(JSON.stringify(ledger));
  const books = merged.accounting.books;
  for (const entry of archive.days) {
    const book = books[entry.scope] || (books[entry.scope] = { currency: CURRENCY, model: null, title: null, days: {} });
    if (!book.days[entry.day]) book.days[entry.day] = { ...entry, turns: {} };
  }
  return merged;
}

/**
 * 自測：建一份暫存帳本、寫入假資料、驗證彙總與封存、清理暫存檔。
 *
 * @returns {{ok: boolean, lines: string[]}} 自測結果。
 */
export function runSelfTest() {
  const lines = [];
  let ok = true;
  const check = (name, condition, detail = '') => {
    lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!condition) ok = false;
  };

  try {
    // --- 金額定點 ---
    check('8 位小數定點不漂', moneyUnits(0.1) + moneyUnits(0.2) === moneyUnits(0.3), `${moneyUnits(0.1)}+${moneyUnits(0.2)}=${moneyUnits(0.3)}`);
    check('浮點雜訊被吸收', preciseMoney(moneyUnits(0.45999999999999996)) === 0.46, String(preciseMoney(moneyUnits(0.45999999999999996))));

    // --- 日期 ---
    check('北京時間日 key', beijingDay(Date.parse('2026-11-02T23:30:00Z')) === '2026-11-03', beijingDay(Date.parse('2026-11-02T23:30:00Z')));
    check('日 key 可加減天', dayOffset('2026-11-02', -1) === '2026-11-01', dayOffset('2026-11-02', -1));

    // --- 帳本 ---
    const ledger = emptyLedger(Date.parse('2026-11-02T02:00:00Z'));
    // 注意：用「觀測當下」的北京日當 key（02:10Z = 北京 10:10 = 2026-11-02）
    const day = beijingDay(Date.parse('2026-11-02T02:10:00Z'));
    observeUsage(ledger, {
      at: Date.parse('2026-11-02T02:10:00Z'),
      sessionId: 'sess-a',
      model: 'minimax-m3.1-flash',
      title: '測試會話',
      items: [{ id: 'i1', amount: 0.66 }, { id: 'i2', amount: 6.03 }],
    });
    observeUsage(ledger, {
      at: Date.parse('2026-11-02T03:10:00Z'),
      sessionId: 'sess-a',
      model: 'minimax-m3.1-flash',
      items: [{ id: 'i1', amount: 0.66 }, { id: 'i2', amount: 6.03 }, { id: 'i3', amount: 1.5 }],
    });
    const summary = daySummary(ledger, day);
    check('逐日彙總 = 逐筆合計', summary && Math.abs(summary.amount - 8.19) < 1e-9, summary ? String(summary.amount) : 'null');
    check('逐輪筆數', summary && summary.count === 3, summary ? String(summary.count) : 'null');

    // 重複觀測不應重複計錢
    observeUsage(ledger, {
      at: Date.parse('2026-11-02T03:20:00Z'),
      sessionId: 'sess-a',
      items: [{ id: 'i1', amount: 0.66 }, { id: 'i2', amount: 6.03 }, { id: 'i3', amount: 1.5 }],
    });
    const again = daySummary(ledger, day);
    check('重複觀測不重複計', again && Math.abs(again.amount - 8.19) < 1e-9, again ? String(again.amount) : 'null');

    // 金額被下修 → 記 credit（沖回），不蓋掉已記消費
    observeUsage(ledger, {
      at: Date.parse('2026-11-02T03:30:00Z'),
      sessionId: 'sess-a',
      items: [{ id: 'i1', amount: 0.66 }, { id: 'i2', amount: 5.03 }, { id: 'i3', amount: 1.5 }],
    });
    const adjusted = daySummary(ledger, day);
    check('金額下修 → 淨額扣掉 1 元', adjusted && Math.abs(adjusted.amount - 7.19) < 1e-9, adjusted ? String(adjusted.amount) : 'null');

    // 逐輪明細
    const turns = turnsOf(ledger, { limit: 10 });
    check('逐輪明細可列出', turns.length === 3, `${turns.length} 筆`);
    check('逐輪明細含模型', turns.every((t) => t.model === 'minimax-m3.1-flash'));

    // --- 保留期 / 封存 ---
    const old = Date.parse('2025-01-02T02:00:00Z');
    const oldDay = beijingDay(old);
    const ledger2 = emptyLedger(old);
    observeUsage(ledger2, { at: old, sessionId: 'sess-old', items: [{ id: 'old1', amount: 2 }] });
    const pruned = pruneLedger(ledger2, { now: Date.parse('2026-11-02T02:00:00Z') });
    check('超期逐日列被移出', pruned.archived.days.length === 1, `${pruned.archived.days.length} 列`);
    check('超期逐輪被移出', pruned.archived.turns.length === 1, `${pruned.archived.turns.length} 筆`);
    check('主帳本不再留超期日', daySummary(pruned.ledger, oldDay) === null);

    // --- 私有 JSON 讀寫 ---
    const tmpDir = join(homedir(), '.workbuddy-whale', 'usage-selftest-tmp');
    try {
      const file = ledgerPath(tmpDir);
      writePrivateJson(file, { hello: '世界' });
      const back = readPrivateJson(file);
      check('私有 JSON 讀寫往返', back && back.hello === '世界');
    } finally {
      try { unlinkSync(ledgerPath(tmpDir)); } catch { /* ignore */ }
      try { unlinkSync(archivePath(tmpDir)); } catch { /* ignore */ }
    }
  } catch (error) {
    ok = false;
    lines.push(`FAIL  自測例外：${error instanceof Error ? error.message : String(error)}`);
  }

  return { ok, lines };
}
