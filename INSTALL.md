# 安裝說明 —— 請交給 WorkBuddy 裡的 AI 執行

> 這份文件是寫給 **AI 助手** 的操作指令。人類用戶可只讀第 0 節。

---

## 0. 這是什麼

一個 WorkBuddy 插件：把帳號的**訂閱額度**記成可查的帳本（逐輪明細 + 逐日彙總），
並註冊三個 MCP 工具（`usage_status` / `usage_today` / `usage_ledger`），
讓 Agent 隨時能回答「我今天用了多少、還剩多少」。

資料全部來自本機 `workbuddy.db`（**只讀、不聯網、不改動任何資料**）。

---

## 1. 安裝前檢查（AI 必須先做）

```bash
# ① Node 22+（記賬核心需要內建 node:sqlite）
node --version
node -e "require('node:sqlite');console.log('node:sqlite OK')" || echo "需要 Node 22+"

# ② WorkBuddy 資料庫在不在
node -e "const {existsSync}=require('fs');const {join}=require('path');const h=require('os').homedir();const p=[join(h,'.workbuddy','workbuddy.db'),join(h,'.workbuddy-ai','workbuddy.db')].find(existsSync);console.log(p||'NOT FOUND')"

# ③ 裡面有沒有額度資料
node -e "const {existsSync}=require('fs');const {join}=require('path');const h=require('os').homedir();const p=join(h,'.workbuddy','workbuddy.db');if(!existsSync(p)){console.log('NOT FOUND');process.exit(0)}const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(p,{readOnly:true});console.log('session_usage =',db.prepare('SELECT COUNT(*) c FROM session_usage').get().c,'筆');db.close()"
```

若 ② 報 NOT FOUND 或 ③ 是 0 筆：請使用者**先在 WorkBuddy 裡跑一個會話**，否則沒有資料可查。

---

## 2. 安裝插件

### 2.1 放到本機市集

市集根目錄（WorkBuddy 實際吃的形狀）：

- 國內版：`~/.workbuddy/plugins/marketplaces/<市集名>/`
- 國際版：`~/.workbuddy-ai/plugins/marketplaces/<市集名>/`

把插件本體放進 `plugins/<插件名>/`：

```
~/.workbuddy/plugins/marketplaces/fatfish-local/
├─ .codebuddy-plugin/marketplace.json
└─ plugins/fatfish-usage/          ← 插件本體（實體複製整個目錄）
```

### 2.2 市集清單

在市集根目錄的 `.codebuddy-plugin/marketplace.json` 註冊（若該檔已存在，**追加**一筆，
不要覆蓋別的插件）：

```json
{
  "name": "fatfish-local",
  "description": "本機插件市集",
  "owner": { "name": "local" },
  "plugins": [
    {
      "name": "fatfish-usage",
      "description": "記賬掛件：額度現況與消耗帳本（CLI + Skill + MCP）。",
      "version": "1.0.0",
      "source": "./plugins/fatfish-usage",
      "category": "tool",
      "license": "MIT"
    }
  ]
}
```

### 2.3 讓 WorkBuddy 知道這個市集

`~/.workbuddy/plugins/known_marketplaces.json` 加一筆：

```json
"fatfish-local": {
  "manifestName": "fatfish-local",
  "type": "directory",
  "source": { "source": "directory", "path": "<市集根的絕對路徑>" },
  "installLocation": "<市集根的絕對路徑>",
  "description": "本機插件市集",
  "lastUpdated": "<ISO8601>",
  "autoUpdate": false,
  "isBuiltIn": false
}
```

### 2.4 啟用插件

`~/.workbuddy/settings.json` 的 `enabledPlugins` 加一筆（`@` 後面是市集名）：

```json
{
  "enabledPlugins": {
    "fatfish-usage@fatfish-local": true
  }
}
```

也可以到 **WorkBuddy → 設定 → 插件** 手動啟用。

### 2.5 重載

> **不需要重啟 WorkBuddy。**
> 在對話框輸入 `/reload-plugins`（可加 `--force`）即可重載插件、技能與 MCP。

---

## 3. 驗證

```bash
# ① CLI 有沒有資料
node "<市集根>/plugins/fatfish-usage/scripts/usage.mjs" --json --status

# ② MCP server 三個工具會不會動
node "<市集根>/plugins/fatfish-usage/scripts/wb-usage-mcp.mjs" <<< '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

① 期望看到：

```json
{
  "ok": true,
  "status": { "sessionId": "…", "model": "…", "used": 93041, "size": 300000,
              "remaining": 206959, "percent": 31.0, "updatedAt": 1793608807116 },
  "today": { "amount": 7.15, "count": 3 },
  "ledger": { "days": [ … ], "turns": [ … ] }
}
```

若 `ok: false`：
- `reason`/`message` 提到「找不到 workbuddy.db」→ 使用者還沒跑過會話
- 提到 `node:sqlite` → Node 版本太舊

---

## 4. 使用方式（Agent 該怎麼用）

| 使用者問 | Agent 該做的 | 回覆範例 |
|---|---|---|
| 「我今天用了多少額度」 | 呼叫 `usage_today` | 「今天（2026-11-02）用了 7.15 額度點，共 3 輪。」 |
| 「還剩多少」 | 呼叫 `usage_status` | 「已用 93,041 / 300,000 額度點（31%），還剩 206,959。」 |
| 「帳本」 | 呼叫 `usage_ledger` | 逐日彙總 + 最近幾筆逐輪 |

回答時要講清楚：

- 這是**帳號訂閱額度點數**口徑，**不是金額**，不要換算成錢。
- `size` 為 0 → 該階段沒配額，百分比算不出來，如實說，不要編數字。

---

## 5. 常見問題

| 現象 | 處理 |
|---|---|
| `Cannot find module 'node:sqlite'` | Node 版本太舊，升級到 22+ |
| 找不到 workbuddy.db | 使用者還沒在 WorkBuddy 跑過會話 |
| `size` 是 0 | 該階段沒有配額，percent 會是 null —— 如實說明 |
| 插件沒出現在設定裡 | marketplace.json 的 `name` 與 settings.json 裡 `@` 後面的市集名要一致；改完 `/reload-plugins` |
| MCP 工具不出現 | 確認 `.mcp.json` 在插件根、且 `cwd` 在插件根內；再 `/reload-plugins --force` |
| 資料庫被鎖 | 只讀開啟，WorkBuddy 正在寫入時可能短暫失敗，稍後重試 |

---

## 6. 素材與授權

程式 MIT。角色形象為社群二創的 DeepSeek「大肥魚」（鯨魚娘），**非官方形象**；
美術按 **CC BY-NC-SA 4.0**，**禁止商用**。轉發請保留署名。
