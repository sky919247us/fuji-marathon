/**
 * 富士山への道 —— 後端（Google Apps Script）
 *
 * 職責兩件：
 *   1. 訓練資料的讀寫（存在這份 Google 試算表裡）
 *   2. 代理中央氣象署 API —— 讓 CWA 金鑰留在伺服器端，不出現在 GitHub Pages 的前端原始碼裡
 *
 * 安裝步驟見 README.md。
 */

/* ═══════════ 設定 ═══════════ */

// CWA 金鑰不寫在程式碼裡，改放「指令碼屬性」。
// 設定路徑：Apps Script 編輯器左側齒輪「專案設定」→ 指令碼屬性 → 新增
//   屬性 = CWA_KEY   值 = CWA-你的金鑰
const CWA_KEY = () => PropertiesService.getScriptProperties().getProperty('CWA_KEY');

const TOWN     = '潭子區';
const DS_WEEK  = 'F-D0047-075';  // 臺中市未來1週天氣預報（逐12小時）
const DS_HOUR  = 'F-D0047-073';  // 臺中市未來2天天氣預報（逐3小時）
const WX_CACHE_SEC = 3600;       // 氣象資料快取 1 小時，避免打爆 CWA

const SHEETS = {
  runs: ['id', 'date', 'clock', 'km', 'sec', 'type', 'steps', 'up', 'down', 'kcal', 'note', 'created'],
  done: ['key', 'value', 'updated'],
  meta: ['key', 'value', 'updated']
};

/* ═══════════ 路由 ═══════════ */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'data';
  try {
    if (action === 'weather') return json({ ok: true, weather: getWeather(e.parameter.force === '1') });
    if (action === 'data')    return json({ ok: true, data: getData() });
    if (action === 'all')     return json({ ok: true, data: getData(), weather: getWeather(false) });
    if (action === 'ping')    return json({ ok: true, pong: new Date().toISOString() });
    return json({ ok: false, error: '未知的 action：' + action });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);                       // 避免多裝置同時寫入互相蓋掉
    try {
      switch (body.action) {
        case 'addRun':    return json({ ok: true, run: upsertRun(body.run) });
        case 'deleteRun': return json({ ok: true, deleted: deleteRun(body.id) });
        case 'setDone':   return json({ ok: true, done: setDone(body.key, body.value) });
        case 'setMeta':   return json({ ok: true, meta: setMeta(body.key, body.value) });
        case 'sync':      return json({ ok: true, data: applyQueue(body.ops || []) });
        default:          return json({ ok: false, error: '未知的 action：' + body.action });
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ═══════════ 試算表 ═══════════ */

function sheet(name) {
  const ss = SpreadsheetApp.getActive();
  const want = SHEETS[name];
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(want);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, want.length).setFontWeight('bold');
  } else {
    // 非破壞性補欄：既有資料不動，只把缺少的欄位加到最右邊。
    // 這樣舊版部署留下的表格可以直接沿用，不必手動搬資料。
    const lastCol = Math.max(sh.getLastColumn(), 1);
    const have = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    const missing = want.filter(function (w) { return have.indexOf(w) < 0; });
    if (missing.length) {
      sh.getRange(1, lastCol + 1, 1, missing.length)
        .setValues([missing]).setFontWeight('bold');
    }
  }
  // 文字型欄位鎖成純文字。否則 "11.1"、"0930" 會被判定為數值、"22:07" 會被
  // 判定為時間，讀回來都對不上原本的字串（勾選狀態遺失、時段變成 1899 年的日期）。
  const TEXT_COLS = { runs: ['id', 'clock', 'type'], done: ['key'], meta: ['key'] };
  if (sh.getMaxRows() > 1) {
    const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
    (TEXT_COLS[name] || []).forEach(function (c) {
      const i = head.indexOf(c);
      if (i >= 0) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  }
  return sh;
}

/** 依實際標題列讀寫，不假設欄位順序 —— 這樣補欄之後舊資料仍然對得上 */
function headerOf(sh) {
  return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
}

function rows(name) {
  const sh = sheet(name);
  const head = headerOf(sh);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, head.length).getValues()
    .map(function (r) { const o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; })
    .filter(function (o) { return o[head[0]] !== '' && o[head[0]] !== null; });
}

function findRow(name, keyCol, keyVal) {
  const sh = sheet(name);
  const head = headerOf(sh);
  const col = head.indexOf(keyCol) + 1;
  const last = sh.getLastRow();
  if (col < 1 || last < 2) return -1;
  const vals = sh.getRange(2, col, last - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(keyVal)) return i + 2;
  }
  return -1;
}

/** 日期一律正規化成 YYYY-MM-DD 字串，避免試算表把它轉成 Date 物件後時區跑掉 */
function ymd(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

/** 時段一律正規化成 "HH:mm"。試算表會把 "22:07" 判定成時間型別存成 Date，
    讀回來會變成 1899-12-30T22:07，所以讀取端要能還原。 */
function hhmm(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'HH:mm');
  return String(v || '').slice(0, 5);
}

function numOrBlank(v) {
  const n = Number(v);
  return (v === null || v === undefined || v === '' || !isFinite(n)) ? '' : n;
}

function getData() {
  const done = {};
  rows('done').forEach(r => { done[String(r.key)] = r.value === true || r.value === 'TRUE' || r.value === 'true'; });
  const meta = {};
  rows('meta').forEach(r => { meta[String(r.key)] = String(r.value); });
  return {
    runs: rows('runs').map(r => ({
      id:    String(r.id),
      d:     ymd(r.date),
      clock: hhmm(r.clock),
      km:    Number(r.km),
      sec:   Number(r.sec),
      type:  String(r.type || 'E'),
      steps: numOrBlank(r.steps) === '' ? null : Number(r.steps),
      up:    numOrBlank(r.up)    === '' ? null : Number(r.up),
      down:  numOrBlank(r.down)  === '' ? null : Number(r.down),
      kcal:  numOrBlank(r.kcal)  === '' ? null : Number(r.kcal),
      note:  String(r.note || '')
    })).filter(r => r.km > 0 && r.sec > 0),
    done: done,
    meta: meta,
    serverTime: new Date().toISOString()
  };
}

function upsertRun(run) {
  if (!run || !run.id) throw new Error('缺少 run.id');
  const sh = sheet('runs');
  const head = headerOf(sh);
  const rec = {
    id:      String(run.id),
    date:    ymd(run.d),
    clock:   String(run.clock || ''),
    km:      Number(run.km),
    sec:     Number(run.sec),
    type:    String(run.type || 'E'),
    steps:   numOrBlank(run.steps),
    up:      numOrBlank(run.up),
    down:    numOrBlank(run.down),
    kcal:    numOrBlank(run.kcal),
    note:    String(run.note || ''),
    created: new Date()
  };
  const row = head.map(function (h) { return (h in rec) ? rec[h] : ''; });
  const at = findRow('runs', 'id', run.id);
  if (at > 0) sh.getRange(at, 1, 1, row.length).setValues([row]);
  else        sh.appendRow(row);
  return run.id;
}

function deleteRun(id) {
  const at = findRow('runs', 'id', id);
  if (at > 0) { sheet('runs').deleteRow(at); return true; }
  return false;
}

function setDone(key, value) {
  const sh = sheet('done');
  const at = findRow('done', 'key', key);
  if (value) {
    const row = [String(key), true, new Date()];
    if (at > 0) sh.getRange(at, 1, 1, 3).setValues([row]);
    else        sh.appendRow(row);
  } else if (at > 0) {
    sh.deleteRow(at);                            // 取消勾選就刪列，表格保持乾淨
  }
  return !!value;
}

function setMeta(key, value) {
  const sh = sheet('meta');
  const at = findRow('meta', 'key', key);
  const row = [String(key), String(value), new Date()];
  if (at > 0) sh.getRange(at, 1, 1, 3).setValues([row]);
  else        sh.appendRow(row);
  return value;
}

/** 離線期間累積的操作，一次補送 */
function applyQueue(ops) {
  ops.forEach(op => {
    if (op.action === 'addRun')    upsertRun(op.run);
    else if (op.action === 'deleteRun') deleteRun(op.id);
    else if (op.action === 'setDone')   setDone(op.key, op.value);
    else if (op.action === 'setMeta')   setMeta(op.key, op.value);
  });
  return getData();
}

/* ═══════════ 中央氣象署代理 ═══════════ */

function cwaUrl(id) {
  const key = CWA_KEY();
  if (!key) throw new Error('尚未設定 CWA_KEY 指令碼屬性');
  return 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/' + id +
         '?Authorization=' + encodeURIComponent(key) +
         '&LocationName=' + encodeURIComponent(TOWN) + '&format=JSON';
}

function getWeather(force) {
  const cache = CacheService.getScriptCache();
  if (!force) {
    const hit = cache.get('wx');
    if (hit) { const o = JSON.parse(hit); o.cached = true; return o; }
  }
  const res = UrlFetchApp.fetchAll([
    { url: cwaUrl(DS_WEEK), muteHttpExceptions: true },
    { url: cwaUrl(DS_HOUR), muteHttpExceptions: true }
  ]);
  res.forEach(r => {
    if (r.getResponseCode() !== 200) throw new Error('CWA 回應 HTTP ' + r.getResponseCode());
  });
  const week = parseWeek(JSON.parse(res[0].getContentText()));
  const hourly = parseHourly(JSON.parse(res[1].getContentText()));
  const out = { ts: Date.now(), week: week, hourly: hourly, cached: false };
  // 快取值有大小上限，超過就跳過快取而不是整支失敗
  try { cache.put('wx', JSON.stringify(out), WX_CACHE_SEC); } catch (e) {}
  return out;
}

function locOf(j) {
  if (!j || !j.records || !j.records.Locations || !j.records.Locations.length)
    throw new Error('CWA 查無 ' + TOWN + ' 的預報資料');
  return j.records.Locations[0].Location[0];
}
function elMap(loc) {
  const m = {};
  loc.WeatherElement.forEach(e => m[e.ElementName] = e.Time);
  return m;
}
function numOf(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
function valOf(t, k) {
  return (t && t.ElementValue && t.ElementValue[0]) ? t.ElementValue[0][k] : null;
}

function parseWeek(j) {
  const el = elMap(locOf(j));
  const base = el['最低體感溫度'] || [];
  return base.map(function (T, i) {
    const g = (name, key) => valOf((el[name] || [])[i], key);
    return {
      st: T.StartTime, et: T.EndTime,
      atMin: numOf(valOf(T, 'MinApparentTemperature')),
      atMax: numOf(g('最高體感溫度', 'MaxApparentTemperature')),
      tMin:  numOf(g('最低溫度', 'MinTemperature')),
      tMax:  numOf(g('最高溫度', 'MaxTemperature')),
      rh:    numOf(g('平均相對濕度', 'RelativeHumidity')),
      ws:    numOf(g('風速', 'WindSpeed')),
      pop:   numOf(g('12小時降雨機率', 'ProbabilityOfPrecipitation')),
      wx:    g('天氣現象', 'Weather') || '—'
    };
  });
}

function parseHourly(j) {
  const el = elMap(locOf(j));
  const at = el['體感溫度'] || [];
  const rhArr = el['相對濕度'] || [];
  const pops = el['3小時降雨機率'] || [];
  const rhBy = {};
  rhArr.forEach(t => rhBy[t.DataTime] = numOf(valOf(t, 'RelativeHumidity')));
  function popAt(iso) {
    const t = new Date(iso).getTime();
    for (let i = 0; i < pops.length; i++) {
      if (new Date(pops[i].StartTime).getTime() <= t && t < new Date(pops[i].EndTime).getTime())
        return numOf(valOf(pops[i], 'ProbabilityOfPrecipitation'));
    }
    return null;
  }
  return at.map(t => ({
    time: t.DataTime,
    at:   numOf(valOf(t, 'ApparentTemperature')),
    rh:   rhBy[t.DataTime] != null ? rhBy[t.DataTime] : null,
    pop:  popAt(t.DataTime)
  })).filter(h => h.at !== null);
}

/* ═══════════ 安裝自檢 ═══════════ */

/** 在 Apps Script 編輯器裡選這個函式按「執行」，可確認金鑰與試算表都正常。 */
function selfTest() {
  const out = [];
  out.push('CWA_KEY 已設定：' + (CWA_KEY() ? '是' : '否 ← 請先到專案設定新增指令碼屬性'));
  ['runs', 'done', 'meta'].forEach(n => { sheet(n); out.push('工作表 ' + n + '：就緒'); });
  try {
    const w = getWeather(true);
    out.push('氣象取得成功：未來 ' + w.week.length + ' 個時段、逐時 ' + w.hourly.length + ' 點');
  } catch (e) {
    out.push('氣象取得失敗：' + e.message);
  }
  const d = getData();
  out.push('目前資料：' + d.runs.length + ' 筆跑步、' + Object.keys(d.done).length + ' 個已完成課表');
  Logger.log(out.join('\n'));
  return out.join('\n');
}
