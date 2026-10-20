# tw-stock-mcp

台股行情的遠端 MCP server，部署在 Cloudflare Workers。盤中即時資料來自[富果 Fugle MarketData API](https://developer.fugle.tw/)，盤後資料（估值、融資融券、當沖標的、注意／處置股）來自[臺灣證券交易所 OpenAPI](https://openapi.twse.com.tw/)。
給 Claude 的連接器（含雲端排程）使用。

## 工具

| 工具 | 用途 |
|---|---|
| `get_quotes` | 個股／指數即時報價（最多 10 檔，上市上櫃皆可）：開高低收、昨收、漲跌幅、開盤跳空 %、成交量、最佳五檔、漲跌停價與距漲跌停 %；個股另附可否現沖、注意／處置、撮合秒數 |
| `get_market_overview` | 加權指數 IX0001、櫃買指數 IX0043 |
| `get_intraday_candles` | 今日分時 K（1/5/10/15/30/60 分） |
| `get_daily_history` | 最近 N 日日 K（新到舊，含漲跌幅與振幅；振幅 =（高 − 低）÷ 前一日收盤） |

證交所 OpenAPI（僅上市股票、免金鑰、**不吃富果額度**，快取 10 分鐘）：

| 工具 | 用途 |
|---|---|
| `get_daytrade_status` | 當沖前檢查：可否當沖、是否暫停先賣後買、是否注意股、是否處置中（含期間與措施） |
| `get_margin_trading` | 融資融券：買賣、餘額與增減、融資使用率、券資比、資券互抵 |
| `get_valuation` | 本益比、殖利率、股價淨值比 |
| `get_alert_lists` | 全部注意股與處置股清單 |

盤中監控（當沖條件通知）：

| 工具 | 用途 |
|---|---|
| `set_daytrade_watchlist` | 寫入當日當沖條件（最多 5 檔）；伺服器在台北 09:01–13:25 每分鐘檢查，成立時以 Telegram 通知 |
| `get_daytrade_watchlist` | 查看清單、各條件狀態（監控中／已觸發／已放棄）與通知紀錄 |

監控規則：每個條件只通知一次；可設「需連續成立幾分鐘」與量能倍數（量比＝今日累計量 ÷ 近 5 日同一時刻的平均累計量，依富果 1 分 K 的實際分時分布計算；分 K 取不到時退回日均量線性估算）；跌破失效價、變成處置股、分盤撮合或不可當沖時通知失效並停止監控；12:30 後不再發進場通知；13:15 對已觸發標的發平倉提醒。

## 部署

1. Cloudflare 後台 → **Workers & Pages** → **Create** → **Import a repository**，選這個 repo，其他設定用預設值。
2. 部署完成後，到該 Worker 的 **Settings → Variables and Secrets**，新增兩個 **Secret**：
   - `FUGLE_API_KEY`：富果行情 API 金鑰
   - `MCP_TOKEN`：一串隨機字串（至少 16 字元）
3. 盤中監控通知（選用）：再新增兩個 Secret：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`，然後打開 `https://<worker 網址>/notify-test/<MCP_TOKEN>` 測試。
4. 打開 `https://<worker 網址>/health`，看到 `{"ok":true,...}` 就是活著。
   打開 `https://<worker 網址>/selftest/<MCP_TOKEN>` 可同時檢查富果與證交所是否連得到。
5. 連接器網址：`https://<worker 網址>/mcp/<MCP_TOKEN>`

> 這個 repo 是公開的，所以程式碼裡**沒有任何金鑰**；兩個 Secret 只存在 Cloudflare。網址裡的 `MCP_TOKEN` 就是密碼，不要外流。

## 本機測試

```bash
npm test          # 離線冒煙測試（假資料，不需金鑰）
npx wrangler dev  # 本機啟動；Secret 放在 .dev.vars（已加入 .gitignore）
```

## 注意

- 免費基本方案：日內行情 API 每分鐘 60 次。`get_quotes` 每檔算一次；個股當天第一次查詢會多查一次 Ticker（漲跌停價等），之後快取一整天。
- 富果時間戳為 epoch 微秒，已轉成台北時間。
- **成交量一律為「張」**：富果日 K 原始單位是「股」，已在伺服器端換算；指數分 K 的 volume 其實是成交金額，改以 `tradeValue` 回傳。
- 開盤前或休市日查詢盤中工具，回傳的是最近一個交易日的資料，回應會附 `isToday` 與 `note`。
- 證交所資料為**前一個交易日盤後**公布，盤中不會變動；上櫃股票目前不支援。
- 資料僅供參考，非投資建議。
