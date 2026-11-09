# WorkBuddy 大肥魚記賬掛件 · 勛

WorkBuddy 用量掛件：讀 ~/.workbuddy/workbuddy.db 的 session_usage 表，回報真實用量與訂閱剩餘額度。

> 本倉庫為 **勛** 的版本，改編自
> [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（DeepSeek Harness 的大肥魚桌寵，MIT）與
> [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（小鯨魚記賬掛件，MIT）。
> 角色形象為社群二創的 DeepSeek「大肥魚」（鯨魚娘），非官方形象，美術素材 CC BY-NC-SA 4.0（禁止商用）。
> 詳見 [LICENSE](LICENSE)。

---

# 記賬掛件 · WorkBuddy 版（fatfish-usage）

把 WorkBuddy 帳號的**訂閱額度**記成一本可查的帳本：
逐輪明細 + 逐日彙總，Agent 隨時能回答「我今天用了多少、還剩多少」。

全部資料來自本機 `~/.workbuddy/workbuddy.db`（國際版 `~/.workbuddy-ai/`），
**只讀、不聯網、不改動任何資料**。

```
WorkBuddy 本機 DB ──▶ session_usage (session_id / used / size / updated_at / credit_json)
                        sessions     (id / title / status / model / …)
```

## 三個 MCP 工具

| 工具 | 參數 | 回什麼 |
|---|---|---|
| `usage_status` | 無 | 已用 / 總額 / 剩餘 / 已用百分比 / 模型 / 更新時間 |
| `usage_today` | 無 | 今日總量 + 輪數 |
| `usage_ledger` | `limit`（選填，預設 20） | 逐日彙總 + 最近逐輪明細 |

插件載入後這三個工具就會出現在 Agent 的工具清單裡（工具名 `mcp__fatfish-usage__usage_status` 等）。

## CLI 契約

MCP 層是**呼叫 CLI** 拿資料的（不直接 import 記賬核心），所以核心改版時這裡不用動。

```bash
node "<plugin-root>/scripts/usage.mjs" --json            # 全部
node "<plugin-root>/scripts/usage.mjs" --json --status   # 只回現況
node "<plugin-root>/scripts/usage.mjs" --json --today    # 只回今日
node "<plugin-root>/scripts/usage.mjs" --json --ledger   # 只回帳本
node "<plugin-root>/scripts/usage.mjs" --summary         # ≤50 字元單行
```

`--json` 的輸出形狀：

```json
{
  "ok": true,
  "status": { "sessionId": "…", "model": "…", "used": 93041, "size": 300000,
              "remaining": 206959, "percent": 31.0, "updatedAt": 1793608807116 },
  "today":  { "amount": 7.15, "count": 3 },
  "ledger": { "days": [ { "date": "2026-11-02", "amount": 7.15, "count": 3 } ],
              "turns": [ { "ts": 1793608807116, "sessionId": "…", "amount": 0.66,
                           "model": "minimax-m3.1-flash" } ] }
}
```

失敗時 stdout 仍是 JSON：`{"ok": false, "reason": "…", "message": "…"}`，exit code 非 0。

## 目錄結構

```
wbdy-fatfish-usage/
├─ .codebuddy-plugin/
│  └─ plugin.json               WorkBuddy 插件清單（宣告 skills / mcpServers）
├─ .mcp.json                    MCP server 註冊（stdio）
├─ skills/model-usage/
│  ├─ SKILL.md                  教 Agent 怎麼查、怎麼講
│  └─ agents/openai.yaml        技能介面描述（display_name / default_prompt）
├─ scripts/
│  ├─ wb-usage-mcp.mjs          MCP server（零相依手刻 JSON-RPC 2.0）
│  ├─ usage.mjs                 記賬 CLI（記賬核心，由另一位同事實作）
│  └─ accounting.mjs             記賬核心
├─ README.md
├─ INSTALL.md                   ← 給 AI 看的安裝指令
└─ LICENSE                      MIT
```

## 安裝

見 [INSTALL.md](INSTALL.md)。

本機市集（`fatfish-local`）的實際形狀：

```
~/.workbuddy/plugins/marketplaces/fatfish-local/
├─ .codebuddy-plugin/marketplace.json
└─ plugins/fatfish-usage/           ← 插件本體（實體複製）
```

註冊完之後**不需要重啟 WorkBuddy**，在對話框打 `/reload-plugins` 即可。

## 環境需求

- **Node 22 或更新**（記賬核心用內建的 `node:sqlite`，不需額外套件）
- WorkBuddy 至少跑過一次會話（否則 `session_usage` 是空的）

## 口徑

- 這些數字是 **WorkBuddy 帳號的訂閱額度點數**，**不是金額**。
  不要換算成錢，也不要加貨幣符號。
- `size` 為 0 表示該階段沒有配額，此時 `percent` 為 `null` —— 如實說，不要編數字。
- `sessions.status` 只代表工作階段的生命週期，額度另有 `session_usage` 表，兩者別混。

## 素材與授權

程式 MIT。角色形象為社群二創的 DeepSeek「大肥魚」（鯨魚娘），**非官方形象**，
美術按 **CC BY-NC-SA 4.0**，**禁止商用**。轉發請保留署名。
