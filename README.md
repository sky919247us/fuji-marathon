# 富士山への道

從 6 公里到河口湖畔 —— 一份給一週跑 2–3 次的人的 68 週馬拉松訓練計畫，
目標是 2027 年 12 月的富士山馬拉松。

靜態網站（GitHub Pages）＋ Google 試算表當資料庫（Apps Script）。

## 功能

- **總覽** — 賽事倒數、本週課表、68 週爬升曲線
- **天氣排跑** — 串接中央氣象署預報，計算路跑指數，自動把本週三次課表排到條件最好的日子，並依體感溫度給出當天該用的配速
- **現況分析** — 基準訓練紀錄、配速與步頻診斷、各距離完賽推算
- **訓練計畫** — 68 週分期課表，前 30 週逐次開課，2027 年 6 月起依組別分兩條路徑
- **配速與技術** — 訓練配速區間、步頻矯正、走跑策略、肌力與補給
- **賽事情報** — TATTA RUN 四季種目差異、實體賽組別與關門、報名時程、十二月河口湖天候
- **訓練日誌** — 新增紀錄、週跑量對照計畫達成率

## 檔案

```
index.html              整個應用程式（單檔，含 CSS 與 JS）
config.js               後端網址設定 ← 部署前要填
apps-script/Code.gs     Google Apps Script 後端
apps-script/README.md   後端設定步驟
.nojekyll               讓 GitHub Pages 原樣提供檔案
```

## 部署

**1. 後端** — 照 [`apps-script/README.md`](apps-script/README.md) 建立試算表、貼上 Code.gs、設定 `CWA_KEY`、部署成網頁應用程式，取得網址。

**2. 填設定** — 把網址填進 `config.js` 的 `gasUrl`。

**3. 上 GitHub Pages**

```bash
git init
git add .
git commit -m "富士山訓練計畫網站"
git branch -M main
git remote add origin https://github.com/<你的帳號>/<repo>.git
git push -u origin main
```

然後在 repo 的 **Settings → Pages** 選 **Deploy from a branch**，分支 `main`、資料夾 `/ (root)`。
約一分鐘後網站會出現在 `https://<你的帳號>.github.io/<repo>/`。

## 安全性

- **前端不含任何金鑰。** 氣象署金鑰放在 Apps Script 的指令碼屬性，網頁透過後端代理取得預報。
- `config.js` 裡的 Apps Script 網址是一把能讀寫訓練資料的鑰匙。網址不可猜測，但別主動公開；外流就重新部署換網址。
- 不要把 `cwaKeyForLocalFileOnly` 填了之後 commit 上去 —— 那個欄位只給「直接雙擊本機 HTML 檔」的情境用。

## 離線

網站是本機優先：畫面先用瀏覽器 localStorage 的資料畫出來，再跟雲端對帳。
沒網路時照常可以記錄與勾課表，操作會排進佇列，恢復連線後自動補送（右上角同步標籤會顯示待同步筆數）。

## 資料出處

- 訓練基準：2026/08/03–08/18 共 9 次跑步紀錄
- 天氣：[交通部中央氣象署開放資料平臺](https://opendata.cwa.gov.tw/)，臺中市潭子區逐 12 小時與逐 3 小時預報
- 賽事：[富士山馬拉松官網](https://www.mtfujimarathon.com/) 與各季 TATTA RUN 頁面

賽事日期凡標「推測」者，均依官網上一屆檔期推算，實際請以官方公告為準。
