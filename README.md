# tw-stock-mcp

台股即時行情的遠端 MCP server，部署在 Cloudflare Workers，資料來自[富果 Fugle MarketData API](https://developer.fugle.tw/)。
給 Claude 的連接器（含雲端排程）使用。

## 工具

| 工具 | 用途 |
|---|---|
| `get_quotes` | 個股／指數即時報價（最多 10 檔）：開高低收、昨收、漲跌幅、開盤跳空 %、成交量、漲跌停、最佳五檔 |
| `get_market_overview` | 加權指數 IX0001、櫃買指數 IX0043 |
| `get_intraday_candles` | 今日分時 K（1/5/10/15/30/60 分） |
| `get_daily_history` | 最近 N 日日 K（含振幅） |

## 部署

1. Cloudflare 後台 → **Workers & Pages** → **Create** → **Import a repository**，選這個 repo，其他設定用預設值。
2. 部署完成後，到該 Worker 的 **Settings → Variables and Secrets**，新增兩個 **Secret**：
   - `FUGLE_API_KEY`：富果行情 API 金鑰
   - `MCP_TOKEN`：一串隨機字串（至少 16 字元）
3. 打開 `https://<worker 網址>/health`，看到 `{"ok":true,...}` 就是活著。
4. 連接器網址：`https://<worker 網址>/mcp/<MCP_TOKEN>`

> 這個 repo 是公開的，所以程式碼裡**沒有任何金鑰**；兩個 Secret 只存在 Cloudflare。網址裡的 `MCP_TOKEN` 就是密碼，不要外流。

## 本機測試

```bash
npm test          # 離線冒煙測試（假資料，不需金鑰）
npx wrangler dev  # 本機啟動；Secret 放在 .dev.vars（已加入 .gitignore）
```

## 注意

- 免費基本方案：日內行情 API 每分鐘 60 次。`get_quotes` 每檔算一次。
- 富果時間戳為 epoch 微秒，已轉成台北時間。成交量單位：個股為「張」。
- 資料僅供參考，非投資建議。
