---
name: model-usage
description: |
  記賬掛件：查 WorkBuddy 的額度用量與消耗帳本。
  觸發詞：額度、餘額、用量、用了多少、還剩多少、配額、記賬、帳本、消耗、額度掛件、
  token 用量、quota、usage、how much quota、how much is left。
  使用者問「我今天用了多少額度」「還剩多少」「帳本看一下」「最近消耗都在幹嘛」時使用。
  資料全部來自本機 ~/.workbuddy/workbuddy.db（唯讀），不聯網。
description_en: |
  Accounting widget: reports WorkBuddy quota usage and a credit ledger read from the local
  ~/.workbuddy/workbuddy.db (read-only, never networks). Use when the user asks how much quota
  or credits were used today, how much is left, or wants the spending ledger.
license: MIT
version: 1.0.0
---

# 記賬掛件（WorkBuddy 版）

把 WorkBuddy 帳號的**訂閱額度**記成一本可查的帳本，逐輪明細 + 逐日彙總。
資料來自本機 `~/.workbuddy/workbuddy.db`（國際版 `~/.workbuddy-ai/workbuddy.db`）的
`session_usage` 與 `sessions` 兩張表，**唯讀查詢，不聯網、不改動 WorkBuddy 的任何資料**。

## 三個 MCP 工具（優先用這個）

| 工具 | 回什麼 | 什麼時候用 |
|---|---|---|
| `usage_status` | 已用 / 總額 / 剩餘 / 已用百分比 / 模型 / 更新時間 | 「還剩多少」「用了多少」「配額還有嗎」 |
| `usage_today` | 今日總量 + 輪數 | 「我今天用了多少額度」 |
| `usage_ledger` | 逐日彙總 + 最近逐輪明細（可傳 `limit` 控制顯示筆數） | 「帳本」「記賬」「最近消耗都在幹嘛」 |

### 怎麼回使用者

**「我今天用了多少額度」**
1. 呼叫 `usage_today`
2. 用**一句話**回報金額（其實是額度點數）與次數，例如：
   「今天（2026-11-02）用了 7.15 額度點，共 3 輪。」

**「還剩多少」**
1. 呼叫 `usage_status`
2. 回報已用 / 總額 / 百分比與剩餘，例如：
   「目前這個階段已用 93,041 / 300,000 額度點（31%），還剩 206,959。」

**「帳本」**
1. 呼叫 `usage_ledger`
2. 回報逐日（日期 / 總量 / 輪數）與最近幾筆逐輪（時間 / 模型 / 量），例如：
   「帳本：2026-11-02 用 7.15 額度點、3 輪；最近一輪是 20:40 的 minimax-m3.1-flash，0.66 額度點。」

> 回覆時**不要貼整份原始 JSON**，挑使用者在問的那幾個數字講清楚就好。

## 直接跑 CLI（工具掛掉時的備援）

```bash
node "<plugin-root>/scripts/usage.mjs" --json            # 全部
node "<plugin-root>/scripts/usage.mjs" --json --status   # 只回現況
node "<plugin-root>/scripts/usage.mjs" --json --today    # 只回今日
node "<plugin-root>/scripts/usage.mjs" --json --ledger   # 只回帳本
node "<plugin-root>/scripts/usage.mjs" --summary         # ≤50 字元單行摘要
```

`<plugin-root>` 是插件根目錄（WorkBuddy 會注入 `${CODEBUDDY_PLUGIN_ROOT}`）。

## 口徑說明（回答時要講清楚）

- 這些數字是 **WorkBuddy 帳號的訂閱額度點數**，**不是金額**。
  **不要擅自換算成錢，也不要加任何貨幣符號。** 使用者若問「花了多少錢」，
  請說明這是額度點數、要換算成錢得看 WorkBuddy 官方的計價頁。
- `size` 為 0 代表那個工作階段沒有額度配額，此時 `percent` 會是 `null`（算不出百分比）——
  照實說，不要編一個數字。
- 剛開一個新工作階段時可能還沒有資料 → 如實說「這個階段還沒有用量數據」。
- 資料是**只讀**的，本機查詢，不聯網。
- 讀到的 `status` 只是工作階段的生命週期，額度另有 `session_usage` 表，兩者別搞混。

## 環境需求

- **Node 22 或更新**（記賬核心用到內建的 `node:sqlite`，不需要額外套件）
- 若報「找不到 workbuddy.db」→ 請使用者先在 WorkBuddy 裡跑一次會話
- 若報 `node:sqlite` 相關錯誤 → Node 版本太舊，請升級到 LTS

## 順便餵給桌寵（可選）

若使用者同時裝了 `fatfish-pet` 桌寵，可以把摘要推到她的狀態橋接：

```bash
node "<plugin-root>/scripts/usage.mjs" --summary
# 再把輸出餵給桌寵的狀態橋接
node "<fatfish-pet-plugin-root>/scripts/wb-state-hook.mjs" < "<summary 的 hook JSON>"
```
