# 關鍵一條線 — 技術分析工具 (SteadyGo Quantitative Decision Engine)

這是一個專業等級的台股量化決策引擎，結合了「關鍵一條線」突破理論、SteadyGo 四大波段策略以及 ATR 動態風險管理系統。

## 核心功能

- **多策略量化引擎**：實作了趨勢回調 (A)、突破回測 (B)、RSI(2) 均值回歸 (C)、底部反轉 (D) 四種核心策略。
- **動態風險管理**：整合 ATR 指標，自動計算建議停損 (-1.5 ATR) 與預期停利 (+3.0 ATR) 價格。
- **技術指標分析**：即時計算 RSI, MACD, ATR, Bollinger Bands 以及 10MA 乖離率。
- **智慧搜尋**：支援台股代碼與中文名稱模糊搜尋。
- **專業級圖表**：採用 TradingView Lightweight Charts，提供流暢的 K 線與量能互動體驗。

## 使用技術

- HTML5 / CSS3 (Vanilla CSS)
- JavaScript (ES6+)
- [Lightweight Charts](https://github.com/tradingview/lightweight-charts)
- Yahoo Finance API (透過 Proxy 串接)

## 部署

此專案為純前端應用，可直接部署於 GitHub Pages。
