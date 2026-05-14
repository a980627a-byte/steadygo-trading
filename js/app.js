// ═══════════════════════════════════════════
// 關鍵一條線 PRO — 核心邏輯 (app.js)
// ═══════════════════════════════════════════

(() => {
'use strict';

// ── 設定常數 ──
const PROXIES = [
  { label:'Yahoo直連', build:s=>`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=RANGE&includePrePost=false` },
  { label:'Yahoo備援', build:s=>`https://query2.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=RANGE&includePrePost=false` },
  { label:'corsproxy',  build:s=>`https://corsproxy.io/?${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=RANGE&includePrePost=false`)}` },
  { label:'allorigins', build:s=>`https://api.allorigins.win/get?url=${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=RANGE&includePrePost=false`)}`, wrapped:true },
];
let lastProxy = null;

// ── DOM 參考 ──
const $ = id => document.getElementById(id);
const stockInput   = $('stock-input');
const rangeSelect  = $('range-select');
const searchBtn    = $('search-btn');
const settingsBtn  = $('settings-toggle');
const settingsPanel= $('settings-panel');
const thresholdIn  = $('threshold-input');
const lookbackIn   = $('lookback-input');
const nearPctIn    = $('near-pct-input');
const welcomeEl    = $('welcome-screen');
const appLayout    = $('app-layout');
const infoBar      = $('stock-info-bar');
const bottomPanel  = $('bottom-panel');
const chartLoading = $('chart-loading');
const chartContainer=$('chart-container');
const toastBox     = $('toast-container');

// ── 圖表狀態 ──
let chart = null, candleSeries = null, volumeSeries = null;
let ma10Series = null, ma5Series = null, ma20Series = null;
let keylineLines = [];
let currentData = null;
let intradayMode = false;
let intradayTimer = null;

// ── 籌碼面資料抓取 (FinMind API) ──
async function fetchFinMindChipData(stockCode) {
  // 動態推算日期：涵蓋過去 7 天以確保抓到最近一個交易日
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 7);

  const formatDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);

  const instUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${stockCode}&start_date=${startStr}&end_date=${endStr}`;
  const marginUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale&data_id=${stockCode}&start_date=${startStr}&end_date=${endStr}`;

  try {
    const [instRes, marginRes] = await Promise.all([
      fetch(instUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => ({})),
      fetch(marginUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => ({}))
    ]);

    let instData = null;
    let marginData = null;

    if (instRes.msg === 'success' && instRes.data && instRes.data.length > 0) {
      // 找出最近的一個交易日
      const latestDate = instRes.data[instRes.data.length - 1].date;
      const latestRecords = instRes.data.filter(r => r.date === latestDate);
      
      let foreign = 0, trust = 0, dealer = 0;
      latestRecords.forEach(r => {
        const net = r.buy - r.sell;
        if (r.name.startsWith('Foreign_Investor')) foreign += net;
        else if (r.name === 'Investment_Trust') trust += net;
        else if (r.name.startsWith('Dealer')) dealer += net;
      });
      
      instData = {
        date: latestDate.replace(/-/g, ''), // 轉為 YYYYMMDD
        foreign,
        trust,
        dealer,
        total: foreign + trust + dealer
      };
    }

    if (marginRes.msg === 'success' && marginRes.data && marginRes.data.length > 0) {
      const latest = marginRes.data[marginRes.data.length - 1];
      marginData = {
        date: latest.date.replace(/-/g, ''), // 轉為 YYYYMMDD
        // FinMind 融資融券單位為「張」，配合前端 fmtShares 函式轉為「股」
        marginBuy: latest.MarginPurchaseBuy * 1000,
        marginSell: latest.MarginPurchaseSell * 1000,
        marginNet: (latest.MarginPurchaseTodayBalance - latest.MarginPurchaseYesterdayBalance) * 1000,
        marginBal: latest.MarginPurchaseTodayBalance * 1000,
        shortBuy: latest.ShortSaleBuy * 1000,
        shortSell: latest.ShortSaleSell * 1000,
        shortNet: (latest.ShortSaleTodayBalance - latest.ShortSaleYesterdayBalance) * 1000,
        shortBal: latest.ShortSaleTodayBalance * 1000
      };
    }

    return { instData, marginData };
  } catch (err) {
    console.error('FinMind API Error:', err);
    return { instData: null, marginData: null };
  }
}

function fmtShares(shares) {
  // 轉為張數（1張=1000股）並格式化
  const lots = Math.round(shares / 1000);
  if (Math.abs(lots) >= 10000) return (lots / 10000).toFixed(1) + '萬';
  return lots.toLocaleString();
}

// ═══ 工具函式 ═══
const fmt  = v => Number.isFinite(v) ? v.toFixed(2) : '—';
const fmtK = v => { if(!Number.isFinite(v)) return '—'; return v>=1e8?(v/1e8).toFixed(1)+'億':v>=1e4?(v/1e4).toFixed(0)+'萬':v.toLocaleString(); };
const fmtPct = v => Number.isFinite(v) ? `${v>=0?'+':''}${v.toFixed(2)}%` : '—';
const fmtDate = d => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
const lcDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

function toast(msg, type='info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  toastBox.appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transform='translateX(20px)'; setTimeout(()=>el.remove(),350); }, 3500);
}

// ═══ 中文名稱查詢 ═══
let twseNameMap = null;

async function loadTWSENames() {
  if (twseNameMap) return;
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('TWSE API failed');
    const arr = await res.json();
    twseNameMap = {};
    arr.forEach(item => { if (item.Code && item.Name) twseNameMap[item.Code] = item.Name; });
  } catch (_) {
    // CORS 或連線失敗時使用內建對照表
    twseNameMap = {};
  }
}

// 內建常用股票中文名稱（當 TWSE API 不可用時的備援）
const BUILTIN_NAMES = {
  '0050':'元大台灣50','0056':'元大高股息','0878':'國泰永續高股息','00919':'群益台灣精選高息',
  '1101':'台泥','1102':'亞泥','1216':'統一','1301':'台塑','1303':'南亞','1326':'台化',
  '1402':'遠東新','1476':'儒鴻','1477':'聚陽','1504':'東元','1513':'中興電','1519':'華城',
  '1590':'亞德客-KY','1605':'華新','1722':'台肥','1802':'台玻',
  '2002':'中鋼','2049':'上銀','2059':'川湖','2105':'正新','2201':'裕隆','2207':'和泰車',
  '2301':'光寶科','2303':'聯電','2308':'台達電','2312':'金寶','2313':'華通','2317':'鴻海',
  '2324':'仁寶','2327':'國巨','2330':'台積電','2337':'旺宏','2344':'華邦電','2345':'智邦',
  '2347':'聯強','2353':'宏碁','2354':'鴻準','2356':'英業達','2357':'華碩','2360':'致茂',
  '2376':'技嘉','2377':'微星','2379':'瑞昱','2382':'廣達','2383':'台光電','2385':'群光',
  '2388':'威盛','2392':'正崴','2395':'研華','2408':'南亞科','2409':'友達','2412':'中華電',
  '2449':'京元電子','2451':'創見','2454':'聯發科','2458':'義隆','2474':'可成',
  '2481':'強茂','2492':'華新科','2498':'宏達電',
  '2501':'國建','2504':'國產','2603':'長榮','2609':'陽明','2615':'萬海',
  '2801':'彰銀','2880':'華南金','2881':'富邦金','2882':'國泰金','2883':'開發金',
  '2884':'玉山金','2885':'元大金','2886':'兆豐金','2887':'台新金','2888':'新光金',
  '2889':'國票金','2890':'永豐金','2891':'中信金','2892':'第一金','2912':'統一超',
  '3008':'大立光','3034':'聯詠','3037':'欣興','3044':'健鼎','3189':'景碩',
  '3231':'緯創','3443':'創意','3481':'群創','3529':'力旺','3532':'台勝科',
  '3661':'世芯-KY','3665':'貿聯-KY','3669':'圓展','3706':'神達',
  '3711':'日月光投控','4904':'遠傳','4938':'和碩','5269':'祥碩','5274':'信驊',
  '5347':'世界','5871':'中租-KY','5876':'上海商銀','5880':'合庫金',
  '6005':'群益證','6116':'彩晶','6176':'瑞儀','6239':'力成','6269':'台郡',
  '6271':'同欣電','6409':'旭隼','6414':'樺漢','6415':'矽力-KY','6446':'藥華藥',
  '6488':'環球晶','6505':'台塑化','6515':'穎崴','6531':'愛普','6547':'高端疫苗',
  '6669':'緯穎','6770':'力積電','6789':'采鈺','8046':'南電','8454':'富邦媒',
  '9910':'豐泰','9914':'美利達','9921':'巨大','9941':'裕融','9945':'潤泰新',
};

// 內建公司簡介
const COMPANY_DESC = {
  '2330':'全球最大的晶圓代工半導體製造廠，專注於先進製程技術。',
  '2317':'全球最大的電子代工製造商(EMS)，主要客戶包含蘋果。',
  '2454':'全球領先的 IC 設計公司，專精於智慧型手機與智慧裝置晶片。',
  '2308':'全球電源管理與散熱解決方案領導廠商。',
  '2382':'全球筆記型電腦與伺服器代工大廠，近年積極發展AI伺服器。',
  '2603':'台灣最大的貨櫃航運公司，全球排名前段班。',
  '2881':'台灣金控業龍頭之一，涵蓋壽險、銀行與產險業務。',
  '2882':'台灣資產規模最大的金融控股公司。',
  '2412':'台灣規模最大的電信服務業者。',
  '1301':'台灣最大的塑膠高分子材料生產商。',
  '2002':'台灣最大的鋼鐵製造商，唯一擁有一貫作業鋼廠。',
  '2303':'全球知名的晶圓代工廠，主攻成熟製程。',
  '3231':'全球資通訊產品專業設計及製造大廠。',
  '0050':'追蹤台灣市值前 50 大企業的 ETF。',
  '0056':'追蹤台灣高股息企業的 ETF。',
  '0878':'追蹤 ESG 與高股息概念的 ETF。',
  '00919':'主打精選高息的台股 ETF。'
};

function getChineseName(code) {
  if (twseNameMap && twseNameMap[code]) return twseNameMap[code];
  if (BUILTIN_NAMES[code]) return BUILTIN_NAMES[code];
  return null;
}

function getCompanyDesc(code) {
  if (COMPANY_DESC[code]) return COMPANY_DESC[code];
  return '台灣上市 / 上櫃公司。詳細基本面與產業資訊，請參考「延伸資訊」頁籤內的外部連結。';
}

// ═══ 資料抓取 ═══
async function fetchProxy(symbol, pi, range) {
  const p = PROXIES[pi];
  const url = p.build(symbol).replace('RANGE', range);
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (p.wrapped) { const w = await res.json(); return JSON.parse(w.contents); }
  return res.json();
}

function parseYahoo(json) {
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r || !q || !r.timestamp) throw new Error('格式錯誤');
  const rows = r.timestamp.map((ts,i) => ({
    date: new Date(ts*1000), open:q.open?.[i], high:q.high?.[i],
    low:q.low?.[i], close:q.close?.[i], volume:q.volume?.[i]
  })).filter(x => [x.open,x.high,x.low,x.close].every(Number.isFinite));
  if (rows.length < 10) throw new Error('有效資料不足');
  return { name: r.meta?.shortName || r.meta?.symbol || '', rows };
}

async function fetchStock(code, range) {
  const suffixes = ['.TW','.TWO'];
  const order = lastProxy !== null
    ? [lastProxy, ...PROXIES.map((_,i)=>i).filter(i=>i!==lastProxy)]
    : PROXIES.map((_,i)=>i);
  for (const sfx of suffixes) {
    const sym = code + sfx;
    for (const pi of order) {
      try {
        const json = await fetchProxy(sym, pi, range);
        const data = parseYahoo(json);
        data.symbol = sym; data.code = code;
        // 優先使用中文名稱
        const cnName = getChineseName(code);
        if (cnName) data.name = cnName;
        lastProxy = pi;
        toast(`✓ ${data.name || code} 載入成功`, 'success');
        return data;
      } catch(_) {}
    }
  }
  throw new Error('所有資料來源均無法取得，請稍後再試');
}

// ═══ 技術指標計算 ═══
function calcMA(rows, period) {
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += rows[j].close;
    result.push(sum / period);
  }
  return result;
}

function calcRSI(rows, period) {
  const rsi = [];
  let gains = 0, losses = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i === 0) { rsi.push(null); continue; }
    const change = rows[i].close - rows[i-1].close;
    if (i <= period) {
      if (change > 0) gains += change;
      else losses -= change;
      if (i === period) {
        let avgGain = gains / period;
        let avgLoss = losses / period;
        gains = avgGain; losses = avgLoss; // For Wilder's smoothing
        let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi.push(100 - (100 / (1 + rs)));
      } else {
        rsi.push(null);
      }
    } else {
      let curGain = change > 0 ? change : 0;
      let curLoss = change < 0 ? -change : 0;
      gains = (gains * (period - 1) + curGain) / period;
      losses = (losses * (period - 1) + curLoss) / period;
      let rs = losses === 0 ? 100 : gains / losses;
      rsi.push(100 - (100 / (1 + rs)));
    }
  }
  return rsi;
}

function calcATR(rows, period) {
  const trs = [], atr = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === 0) {
      trs.push(rows[i].high - rows[i].low);
      atr.push(null);
    } else {
      const hl = rows[i].high - rows[i].low;
      const hc = Math.abs(rows[i].high - rows[i-1].close);
      const lc = Math.abs(rows[i].low - rows[i-1].close);
      trs.push(Math.max(hl, hc, lc));
      if (i < period - 1) {
        atr.push(null);
      } else if (i === period - 1) {
        let sum = 0;
        for (let j = 0; j <= i; j++) sum += trs[j];
        atr.push(sum / period);
      } else {
        atr.push((atr[i-1] * (period - 1) + trs[i]) / period);
      }
    }
  }
  return atr;
}

function calcBollingerBands(rows, period, stdDev) {
  const bands = [];
  const ma = calcMA(rows, period);
  for (let i = 0; i < rows.length; i++) {
    if (i < period - 1) { bands.push(null); continue; }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSq += Math.pow(rows[j].close - ma[i], 2);
    }
    const sd = Math.sqrt(sumSq / period);
    bands.push({
      upper: ma[i] + stdDev * sd,
      lower: ma[i] - stdDev * sd,
      mid: ma[i]
    });
  }
  return bands;
}

function calcMACD(rows, fast=12, slow=26, signal=9) {
  const macd = [];
  let emaFast = null, emaSlow = null;
  const alphaFast = 2 / (fast + 1);
  const alphaSlow = 2 / (slow + 1);
  const alphaSignal = 2 / (signal + 1);
  
  for (let i = 0; i < rows.length; i++) {
    const price = rows[i].close;
    if (i === 0) {
      emaFast = price; emaSlow = price;
      macd.push({ dif: null, dea: null, hist: null });
      continue;
    }
    emaFast = (price - emaFast) * alphaFast + emaFast;
    emaSlow = (price - emaSlow) * alphaSlow + emaSlow;
    
    if (i < slow - 1) {
      macd.push({ dif: null, dea: null, hist: null });
    } else {
      const dif = emaFast - emaSlow;
      let prevDea = macd[i-1] ? macd[i-1].dea : null;
      let dea;
      if (prevDea === null) {
        dea = dif; // Initialize DEA
      } else {
        dea = (dif - prevDea) * alphaSignal + prevDea;
      }
      macd.push({ dif, dea, hist: dif - dea });
    }
  }
  return macd;
}

function calcKeylines(rows, lookback, minGainPct) {
  const triggers = [];
  for (let i = lookback; i < rows.length; i++) {
    const cur = rows[i], prev = rows[i-1];
    if (!cur || !prev) continue;
    const isRed = cur.close > cur.open;
    const gain = ((cur.close - prev.close) / prev.close) * 100;
    let maxClose = -Infinity;
    for (let j = i - lookback; j < i; j++) if (rows[j].close > maxClose) maxClose = rows[j].close;
    if (isRed && gain >= minGainPct && cur.close > maxClose) {
      triggers.push({ idx:i, date:cur.date, price:cur.low, close:cur.close, gain });
    }
  }
  return triggers;
}

function analyzeSignal(rows, triggers, nearPct, instData = null) {
  const last = rows[rows.length - 1];
  const lastIdx = rows.length - 1;
  const ma5 = calcMA(rows, 5);
  const ma10 = calcMA(rows, 10);
  const ma20 = calcMA(rows, 20);
  const ma60 = calcMA(rows, 60);
  const ma120 = calcMA(rows, 120);
  const rsi14 = calcRSI(rows, 14);
  const rsi2 = calcRSI(rows, 2);
  const macdData = calcMACD(rows);
  const atrData = calcATR(rows, 14);
  const bbData = calcBollingerBands(rows, 20, 2);

  const ma10Val = ma10[lastIdx];
  const ma10Prev = ma10[lastIdx - 1];
  const ma10Dir = (ma10Val && ma10Prev) ? (ma10Val > ma10Prev ? '向上' : '向下') : '—';
  const deviation = ma10Val ? ((last.close - ma10Val) / ma10Val * 100) : null;
  const atr = atrData[lastIdx] || 0;
  
  const vols = rows.map(r => r.volume || 0);
  const vma20 = vols.slice(-20).reduce((a,b)=>a+b,0) / 20;

  // 找近 20 日高低點
  let high20 = -Infinity, low20 = Infinity;
  for (let i = Math.max(0, lastIdx - 20); i <= lastIdx; i++) {
    if (rows[i].high > high20) high20 = rows[i].high;
    if (rows[i].low < low20) low20 = rows[i].low;
  }

  // --- SteadyGo 四大策略計分 ---
  let scoreA = 0, scoreB = 0, scoreC = 0, scoreD = 0;
  
  // 策略 A: 趨勢回調
  if (ma20[lastIdx] > ma20[lastIdx-1]) scoreA += 30; // 核心: 20MA向上
  if (bbData[lastIdx] && last.close > ma20[lastIdx] && last.close < bbData[lastIdx].upper) scoreA += 20; // 核心: 在均線與上軌間
  if (last.volume < vma20) scoreA += 20; // 重要: 量縮
  if (rsi14[lastIdx] > 40 && rsi14[lastIdx] < 65) scoreA += 10; // 重要: RSI適中
  if (ma60[lastIdx] && last.close > ma60[lastIdx]) scoreA += 10; // 輔助: 站穩中期均線
  if (last.close > last.open) scoreA += 10; // 輔助: 收紅

  // 策略 B: 突破回測
  const distToHigh = (high20 - last.close) / high20 * 100;
  if (distToHigh < 5) scoreB += 30; // 核心: 突破近期高點附近
  if (last.volume > vma20) scoreB += 20; // 重要: 放量確認
  if (rsi14[lastIdx] > 50) scoreB += 20; // 重要: 動能偏多
  if (macdData[lastIdx] && macdData[lastIdx].hist > 0) scoreB += 20; // 輔助: MACD翻正
  if (last.close > ma5[lastIdx]) scoreB += 10; // 輔助: 站穩短期均線

  // 策略 C: RSI(2) 均值回歸
  if (rsi2[lastIdx] !== null) {
    if (rsi2[lastIdx] < 10) scoreC += 50; // 核心: 極度超賣
    else if (rsi2[lastIdx] < 20) scoreC += 30;
  }
  if (ma60[lastIdx] && last.close > ma60[lastIdx]) scoreC += 20; // 重要: 中長線趨勢仍多
  if (last.volume > vma20) scoreC += 10; // 輔助: 爆量承接
  if (last.close > last.open) scoreC += 20; // 輔助: 收紅確認反彈

  // 策略 D: 底部反轉
  const distToLow = (last.close - low20) / low20 * 100;
  if (distToLow < 5) scoreD += 40; // 核心: 接近20日低點
  if (rsi14[lastIdx] < 30) scoreD += 20; // 重要: RSI超賣
  if (macdData[lastIdx] && macdData[lastIdx].hist > macdData[lastIdx-1].hist) scoreD += 20; // 輔助: MACD收斂
  if (last.close > last.open && last.close > rows[lastIdx-1].close) scoreD += 20; // 輔助: 多頭吞噬/確認反轉

  // 決定主導策略與基礎技術分數
  const stratScores = [
    { name: 'A:趨勢回調', s: scoreA },
    { name: 'B:突破回測', s: scoreB },
    { name: 'C:均值回歸', s: scoreC },
    { name: 'D:底部反轉', s: scoreD }
  ];
  stratScores.sort((a,b) => b.s - a.s);
  const bestStrat = stratScores[0];
  let tech = bestStrat.s;

  const info = { 
    ma10Val, ma10Dir, deviation, signal:'', signalClass:'', detail:'', ma10Data:ma10,
    scores: { fund: 0, tech: 0, chip: 0, total: 0 },
    bestStratName: bestStrat.name,
    atr: atr,
    trendHealth: '正常'
  };

  // 趨勢健康判讀
  if (rsi14[lastIdx] > 75) info.trendHealth = '⚠️ 短線過熱';
  else if (ma20[lastIdx] && last.close < ma20[lastIdx]) info.trendHealth = '🔴 跌破月線';
  else if (ma20[lastIdx] > ma20[lastIdx-1]) info.trendHealth = '🟢 趨勢健康';

  // --- 計算四大面向評分 ---
  // 1. 基本面 (長線趨勢與公司規模估算)
  let fund = COMPANY_DESC[rows.code] ? 80 : 60;
  if (ma60[lastIdx] && last.close > ma60[lastIdx]) fund += 10;
  if (ma120[lastIdx] && last.close > ma120[lastIdx]) fund += 10;

  // 3. 籌碼面 (優先使用三大法人真實數據，fallback 到價量估算)
  let chip = 50;
  if (instData) {
    // 基底 50 分
    chip = 50;
    if (instData.total > 0) chip += 25;        // 法人合計買超
    else if (instData.total < 0) chip -= 15;   // 法人合計賣超
    if (instData.foreign > 0) chip += 15;      // 外資買超
    if (instData.trust > 0) chip += 15;        // 投信買超
    if (instData.foreign > 0 && instData.trust > 0) chip += 10; // 雙法人共振
    if (instData.foreign < 0 && instData.trust < 0) chip -= 15; // 雙法人同步賣超
  } else {
    // fallback: 原有價量配合度估算
    const last5 = rows.slice(-5);
    let upVol = 0, downVol = 0;
    last5.forEach(r => {
      if (r.close > r.open) upVol += r.volume || 0;
      else downVol += r.volume || 0;
    });
    if (upVol > downVol * 1.5) chip = 90;
    else if (upVol > downVol) chip = 70;
    else if (upVol < downVol * 0.5) chip = 30;
    else chip = 50;
  }

  info.scores = {
    fund: Math.min(100, Math.max(0, fund)),
    tech: Math.min(100, Math.max(0, tech)),
    chip: Math.min(100, Math.max(0, chip)),
  };
  info.scores.total = Math.round((info.scores.fund + info.scores.tech + info.scores.chip) / 3);

  // --- 原有關鍵線判斷與風控輸出 ---
  if (triggers.length === 0) {
    info.signal = '❌ 無進場訊號';
    info.signalClass = 'no-line';
    info.detail = '目前尚未出現明顯的關鍵突破線或型態，建議觀望。';
    return info;
  }

  const active = triggers[triggers.length - 1];
  const dist = ((last.close - active.price) / active.price) * 100;
  const isNear = dist >= 0 && dist <= nearPct;
  const isBroken = last.close < active.price;

  // 動態停損停利 (以關鍵線或現價為基準，結合 ATR)
  const stopLossPrice = active.price - (1.5 * atr);
  const takeProfitPrice = last.close + (3.0 * atr);
  info.stopLoss = stopLossPrice;
  info.takeProfit = takeProfitPrice;

  // 定義正乖離門檻 (例如 10%)
  const isHighDeviation = deviation !== null && deviation >= 10;

  if (isBroken) {
    info.signal = '🟢 跌破防守';
    info.signalClass = 'broken';
    info.detail = `股價已跌破防守線 ${fmt(active.price)}。建議停損價位：${fmt(stopLossPrice)} (關鍵線 - 1.5 ATR)。`;
  } else if (isHighDeviation) {
    info.signal = '💰 乖離過大 (建議停利)';
    info.signalClass = 'watch'; // 顯示黃色警告
    info.detail = `目前股價距離 10MA 的正乖離已達 ${fmtPct(deviation)}，短線過熱容易拉回。建議您利用此「正乖離過大」的時機分批獲利了結。`;
  } else if (isNear) {
    info.signal = '🔴 強力買點';
    info.signalClass = 'strong-buy';
    info.detail = `股價回測防守線。動態停損設於 ${fmt(stopLossPrice)}，目標停利參考 ${fmt(takeProfitPrice)}。`;
  } else {
    info.signal = '📊 持續觀察';
    info.signalClass = '';
    info.detail = `尚未進入買點區間。動態停損參考：${fmt(stopLossPrice)}，目標停利參考：${fmt(takeProfitPrice)}。`;
  }
  return info;
}

// ═══ 盤中模式分析 ═══
function isMarketHours() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false; // 週末
  const h = now.getHours(), m = now.getMinutes();
  const mins = h * 60 + m;
  return mins >= 9 * 60 && mins <= 13 * 60 + 30; // 09:00 ~ 13:30
}

function analyzeIntraday(rows, triggers, atr) {
  if (triggers.length === 0 || rows.length < 20) return null;

  const lastIdx = rows.length - 1;
  const last = rows[lastIdx];
  const active = triggers[triggers.length - 1];
  const keyPrice = active.price;

  // 計算技術指標
  const ma10 = calcMA(rows, 10);
  const ma10Up = ma10[lastIdx] > ma10[lastIdx - 1];
  
  const vols = rows.map(r => r.volume || 0);
  const vma5 = vols.slice(-5).reduce((a,b)=>a+b,0) / 5;
  
  const rsi14Arr = calcRSI(rows, 14);
  const rsi14 = rsi14Arr[lastIdx];

  // ① 價格與趨勢 (35分)
  const distPct = ((last.close - keyPrice) / keyPrice) * 100;
  let s1 = 0;
  if (distPct >= 0 && distPct <= 3) {
    s1 = ma10Up ? 35 : 15; // 接近買點且均線向上拿滿分，否則大扣分
  } else if (distPct < 0 && distPct >= -1.5) {
    s1 = ma10Up ? 20 : 0; // 假跌破必須均線向上才安全
  } else {
    s1 = 0;
  }

  // ② 量能結構 (25分)
  let s2 = 0;
  if (last.volume > 0 && vma5 > 0) {
    const volRatio = last.volume / vma5;
    if (volRatio < 0.8) s2 = 25;        // 量縮回測 (低於5日均量80%)
    else if (volRatio <= 1.2) s2 = 15;   // 量能適中
    else if (last.close > last.open) s2 = 10; // 爆量但收紅 (有承接)
    else s2 = 0;                          // 爆量下殺
  }

  // ③ 買黑不買紅 (25分)
  let s3 = 0;
  const isRed = last.close > last.open;
  // K棒實體大小 (判斷是否為大長黑)
  const bodyPct = Math.abs(last.close - last.open) / last.open * 100;
  // 下影線長度大於 0.5% 視為有效測支撐
  const lowerShadowPct = (Math.min(last.open, last.close) - last.low) / last.low * 100;
  const hasLowerShadow = lowerShadowPct > 0.5;

  if (!isRed) {
    // 嚴格遵守「黑K進場」
    if (hasLowerShadow) s3 = 25;       // 黑K帶下影線：完美測支撐
    else if (bodyPct < 2.0) s3 = 20;   // 實體小黑K：量縮整理無賣壓
    else s3 = 0;                       // 實體長大黑：賣壓沉重，不接刀
  } else {
    // 買黑不買紅：遇到紅K原則上不追高
    if (hasLowerShadow && distPct <= 1.5) s3 = 10; // 緊貼關鍵線的紅K帶下影，勉強給一點分
    else s3 = 0; // 其餘紅K皆為 0 分，拒絕追高
  }

  // ④ 動能指標 (15分)
  let s4 = 0;
  if (rsi14 >= 50) s4 = 15;       // 多方控盤
  else if (rsi14 >= 40) s4 = 10;  // 趨勢偏弱但未完全破壞
  else s4 = 0;                    // 空方主導

  let total = s1 + s2 + s3 + s4;

  // 絕對安全機制：跌破超過 2 倍 ATR 直接判定不宜進場
  const absBreak = keyPrice - (2 * atr);
  if (last.close < absBreak) {
    total = 0;
    s1 = 0; s2 = 0; s3 = 0; s4 = 0;
  }

  // 判定結果
  let signal, signalClass, detail;
  if (total >= 80) {
    signal = '🔴 盤中強力買點';
    signalClass = 'intra-strong';
    detail = `評分 ${total} 分！完美符合「量縮回測+均線向上+紅K支撐」的高勝率買點。`;
  } else if (total >= 60) {
    signal = '🟡 盤中觀察中';
    signalClass = 'intra-watch';
    detail = `評分 ${total} 分，型態不錯但少數條件未到位，建議等收盤確認再決定。`;
  } else if (total >= 40) {
    signal = '🟦 暫時觀望';
    signalClass = 'intra-wait';
    detail = `評分 ${total} 分，條件不足 (可能跌破均線或量能失控)，建議等待更好時機。`;
  } else {
    signal = '⚫ 盤中不宜進場';
    signalClass = 'intra-danger';
    detail = `評分 ${total} 分，趨勢轉弱且無支撐，風險極高，絕對不要接刀。`;
  }

  return { s1, s2, s3, s4, total, signal, signalClass, detail, distPct };
}

function updateIntradayCard(data, triggers, atr) {
  const card = $('intraday-card');
  if (!intradayMode || !data || triggers.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';

  const result = analyzeIntraday(data.rows, triggers, atr);
  if (!result) { card.style.display = 'none'; return; }

  // 更新時間
  const now = new Date();
  $('intraday-time').textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  // 訊號 badge
  const badge = $('intraday-badge');
  badge.textContent = result.signal;
  badge.className = `signal-badge ${result.signalClass}`;

  // 總分
  const scoreEl = $('intraday-total-score');
  scoreEl.textContent = result.total;
  scoreEl.style.color = result.total >= 80 ? '#f472b6' : result.total >= 60 ? '#fbbf24' : result.total >= 40 ? '#60a5fa' : '#9ca3af';

  // 四大評分條
  const maxScores = [35, 25, 25, 15];
  const scores = [result.s1, result.s2, result.s3, result.s4];
  for (let i = 0; i < 4; i++) {
    const fillEl = $(`intra-s${i+1}-fill`);
    const valEl = $(`intra-s${i+1}-val`);
    const pct = (scores[i] / maxScores[i]) * 100;
    fillEl.style.width = pct + '%';
    fillEl.style.backgroundColor = pct >= 80 ? '#f472b6' : pct >= 50 ? '#fbbf24' : '#60a5fa';
    valEl.textContent = scores[i];
  }

  // 詳細說明
  $('intraday-detail').textContent = result.detail;
}

// ═══ 首頁掃描推薦 ═══
let scanAborted = false;

async function loadAllStockCodes() {
  const codes = new Set();

  // 1. 優先使用已載入的 twseNameMap（DOMContentLoaded 時載入）
  if (twseNameMap && Object.keys(twseNameMap).length > 0) {
    Object.keys(twseNameMap).forEach(code => {
      if (/^\d{4,6}$/.test(code)) codes.add(code);
    });
  }

  // 2. 如果 twseNameMap 太少或為空，透過 CORS proxy 再次取得 TWSE 資料
  if (codes.size < 100) {
    const twseUrls = [
      'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      `https://corsproxy.io/?${encodeURIComponent('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL')}`,
      `https://api.allorigins.win/get?url=${encodeURIComponent('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL')}`
    ];
    for (const url of twseUrls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) continue;
        let arr = await res.json();
        if (arr.contents) arr = JSON.parse(arr.contents); // allorigins wrapper
        arr.forEach(item => {
          if (item.Code && /^\d{4,6}$/.test(item.Code)) codes.add(item.Code);
        });
        if (codes.size > 100) break; // 成功取得，跳出
      } catch(_) {}
    }
  }

  // 3. 透過 CORS proxy 取得 TPEX（上櫃）股票
  const tpexUrls = [
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_L',
    `https://corsproxy.io/?${encodeURIComponent('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_L')}`,
    `https://api.allorigins.win/get?url=${encodeURIComponent('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_L')}`
  ];
  for (const url of tpexUrls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      let arr = await res.json();
      if (arr.contents) arr = JSON.parse(arr.contents);
      const before = codes.size;
      arr.forEach(item => {
        const code = item.SecuritiesCompanyCode || item['公司代號'] || item.code;
        if (code && /^\d{4,6}$/.test(code.trim())) codes.add(code.trim());
      });
      if (codes.size > before) break; // 成功取得，跳出
    } catch(_) {}
  }

  // 4. 加入內建對照表的股票（確保常見股不遺漏）
  Object.keys(BUILTIN_NAMES).forEach(code => codes.add(code));

  // 5. 過濾 ETF（代碼以 00 開頭），只保留 0050
  const filtered = [...codes].filter(code => {
    if (code.startsWith('00') && code !== '0050') return false;
    return true;
  });

  return filtered.sort((a,b) => a.localeCompare(b));
}

async function scanStocks() {
  const scanBtn = $('scan-btn');
  const progressEl = $('scan-progress');
  const progressFill = $('scan-progress-fill');
  const progressText = $('scan-progress-text');
  const resultsEl = $('scan-results');
  const statsEl = $('scan-stats');

  scanAborted = false;
  scanBtn.textContent = '停止掃描';
  scanBtn.disabled = false;
  scanBtn.onclick = () => { scanAborted = true; };
  progressEl.classList.remove('hidden');
  resultsEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1rem;">正在載入全部股票清單…</p>';
  if (statsEl) statsEl.textContent = '';

  // 載入所有股票代碼
  const allCodes = await loadAllStockCodes();
  const total = allCodes.length;
  toast(`📋 已取得 ${total} 檔股票，開始掃描…`, 'info');
  resultsEl.innerHTML = '';

  const results = [];
  let scanned = 0, found = 0, failed = 0;
  const BATCH_SIZE = 3; // 3 路平行

  for (let i = 0; i < total; i += BATCH_SIZE) {
    if (scanAborted) break;

    const batch = allCodes.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (code) => {
      try {
        const data = await fetchStock(code, '3mo');
        const lookback = 20, threshold = 4, nearPct = 3;
        const triggers = calcKeylines(data.rows, lookback, threshold);
        if (triggers.length === 0) return;

        const analysis = analyzeSignal(data.rows, triggers, nearPct);
        const intResult = analyzeIntraday(data.rows, triggers, analysis.atr);
        if (!intResult || intResult.total < 40) return; // 只收 >= 40 分

        const last = data.rows[data.rows.length - 1];
        results.push({
          code, name: data.name, price: last.close,
          score: intResult.total, signal: intResult.signal,
          signalClass: intResult.signalClass, detail: intResult.detail,
          instTotal: null // 改為點擊個股時即時載入，掃描清單暫不顯示
        });
        found++;
      } catch(_) { failed++; }
    });

    await Promise.allSettled(promises);
    scanned += batch.length;

    // 更新進度
    const pct = Math.min(100, (scanned / total * 100));
    progressFill.style.width = pct + '%';
    const currentCode = batch[batch.length - 1];
    const currentName = getChineseName(currentCode) || '';
    progressText.textContent = `${scanned}/${total} (${currentCode} ${currentName}) — 已找到 ${found} 檔`;

    // 即時更新結果排序
    if (results.length > 0) {
      results.sort((a,b) => b.score - a.score);
      renderScanResults(results, resultsEl);
      sessionStorage.setItem('scanResults', JSON.stringify(results));
    }
  }

  progressEl.classList.add('hidden');
  scanBtn.textContent = '重新掃描';
  scanBtn.disabled = false;
  scanBtn.onclick = () => scanStocks();

  if (results.length === 0) {
    resultsEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1rem;">目前無符合條件的股票（評分 ≥ 40）</p>';
  }

  // 更新統計
  if (statsEl) {
    statsEl.textContent = `共掃描 ${scanned} 檔 ｜ 符合 ${found} 檔 ｜ 失敗 ${failed} 檔`;
    sessionStorage.setItem('scanStats', statsEl.textContent);
  }
  sessionStorage.setItem('scanResults', JSON.stringify(results));

  toast(scanAborted ? `⏹ 已手動停止，找到 ${found} 檔` : `✓ 掃描完成，${found} 檔符合條件`, 'success');
}

function renderScanResults(results, container) {
  container.innerHTML = results.map(r => {
    const scoreColor = r.score >= 80 ? '#f472b6' : r.score >= 60 ? '#fbbf24' : r.score >= 40 ? '#60a5fa' : '#9ca3af';
    return `<div class="scan-card" data-code="${r.code}">
      <div class="scan-card-top">
        <div class="scan-stock-info">
          <span class="scan-code">${r.code}</span>
          <span class="scan-name">${r.name}</span>
        </div>
        <div class="scan-score" style="color:${scoreColor}">${r.score}</div>
      </div>
      <div class="scan-signal ${r.signalClass}">${r.signal}</div>
      <div class="scan-card-bottom">
        <span class="scan-price">${fmt(r.price)}</span>
        ${r.instTotal !== null && r.instTotal !== undefined ? `<span class="scan-inst ${r.instTotal > 0 ? 'buy' : r.instTotal < 0 ? 'sell' : 'neutral'}">${r.instTotal > 0 ? '▲' : r.instTotal < 0 ? '▼' : '—'} 法人${fmtShares(r.instTotal)}張</span>` : ''}
      </div>
    </div>`;
  }).join('');

  // 綁定點擊事件
  container.querySelectorAll('.scan-card').forEach(card => {
    card.addEventListener('click', () => {
      const code = card.dataset.code;
      stockInput.value = code;
      loadStock(code);
    });
  });
}


// ═══ 圖表渲染 ═══
function initChart() {
  if (chart) { chart.remove(); chart = null; }
  keylineLines = [];
  const w = chartContainer.clientWidth;
  const h = chartContainer.clientHeight || 520;
  chart = LightweightCharts.createChart(chartContainer, {
    width: w, height: h,
    layout: { background:{ type:'solid', color:'#0a0e17' }, textColor:'#9ca3af', fontFamily:"'Inter',sans-serif", fontSize:11 },
    grid: { vertLines:{ color:'rgba(255,255,255,0.04)' }, horzLines:{ color:'rgba(255,255,255,0.04)' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor:'rgba(255,255,255,0.1)', scaleMargins:{ top:0.05, bottom:0.25 } },
    timeScale: { borderColor:'rgba(255,255,255,0.1)', timeVisible:false, fixLeftEdge:true, fixRightEdge:true },
    handleScroll: true, handleScale: true,
  });

  // MA 系列 (先建立以便畫在 K 線底層)
  ma10Series = chart.addLineSeries({ color:'rgba(59, 130, 246, 0.7)', lineWidth:1.5, title:'', priceScaleId:'right' });
  ma5Series  = chart.addLineSeries({ color:'rgba(167, 139, 250, 0.7)', lineWidth:1, title:'', priceScaleId:'right', visible:false });
  ma20Series = chart.addLineSeries({ color:'rgba(249, 115, 22, 0.7)', lineWidth:1, title:'', priceScaleId:'right', visible:false });

  // 台灣慣例：紅漲綠跌
  candleSeries = chart.addCandlestickSeries({
    upColor:'#ef4444', downColor:'#22c55e', borderUpColor:'#ef4444', borderDownColor:'#22c55e',
    wickUpColor:'#ef4444', wickDownColor:'#22c55e',
  });

  volumeSeries = chart.addHistogramSeries({
    priceFormat:{ type:'volume' }, priceScaleId:'vol',
  });
  chart.priceScale('vol').applyOptions({ scaleMargins:{ top:0.82, bottom:0 } });

  window.addEventListener('resize', () => {
    if (chart) chart.applyOptions({ width: chartContainer.clientWidth });
  });
}

function renderChart(data, triggers, analysis) {
  const rows = data.rows;
  initChart();

  // K 線
  const cData = rows.map(r => ({ time:lcDate(r.date), open:r.open, high:r.high, low:r.low, close:r.close }));
  candleSeries.setData(cData);

  // 成交量 (依據富果標準：與昨日收盤價比較)
  const vData = rows.map((r, i) => {
    let color = 'rgba(156,163,175,0.35)'; // 預設平盤為灰色
    if (i > 0) {
      const prevClose = rows[i-1].close;
      if (r.close > prevClose) color = 'rgba(239,68,68,0.35)';      // 上漲：紅柱
      else if (r.close < prevClose) color = 'rgba(34,197,94,0.35)'; // 下跌：綠柱
    } else {
      // 第一天無昨日收盤，使用收盤與開盤比較
      if (r.close > r.open) color = 'rgba(239,68,68,0.35)';
      else if (r.close < r.open) color = 'rgba(34,197,94,0.35)';
    }
    return { time: lcDate(r.date), value: r.volume || 0, color };
  });
  volumeSeries.setData(vData);

  // MA 線
  const ma10 = analysis.ma10Data;
  const ma5  = calcMA(rows, 5);
  const ma20 = calcMA(rows, 20);
  ma10Series.setData(ma10.map((v,i) => v ? { time:lcDate(rows[i].date), value:v } : null).filter(Boolean));
  ma5Series.setData(ma5.map((v,i)   => v ? { time:lcDate(rows[i].date), value:v } : null).filter(Boolean));
  ma20Series.setData(ma20.map((v,i)  => v ? { time:lcDate(rows[i].date), value:v } : null).filter(Boolean));

  // 關鍵一條線
  keylineLines.forEach(l => { try { candleSeries.removePriceLine(l); } catch(_){} });
  keylineLines = [];
  triggers.forEach((t, idx) => {
    const isActive = idx === triggers.length - 1;
    const line = candleSeries.createPriceLine({
      price: t.price,
      color: isActive ? '#f7c948' : 'rgba(255,255,255,0.13)',
      lineWidth: isActive ? 2 : 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: isActive,
      title: '', // 移除文字以免擋住 K 線
    });
    keylineLines.push(line);
  });

  // 突破點標記
  const markers = triggers.map((t, idx) => ({
    time: lcDate(t.date),
    position: 'belowBar',
    color: idx === triggers.length - 1 ? '#f7c948' : 'rgba(255,255,255,0.25)',
    shape: 'arrowUp',
    text: '', // 移除文字以免擋住 K 線
  }));
  candleSeries.setMarkers(markers);

  chart.timeScale().fitContent();
}

// ═══ UI 更新 ═══
function setVal(id, text, cls) {
  const el = $(id);
  if (!el) return;
  const v = el.querySelector('.info-value') || el;
  if (v.classList.contains('info-value')) v.textContent = text;
  else v.textContent = text;
  if (cls) { v.classList.remove('up','down'); v.classList.add(cls); }
}

function updateInfoBar(data) {
  const r = data.rows, last = r[r.length-1], prev = r[r.length-2];
  const chg = prev ? last.close - prev.close : 0;
  const chgPct = prev ? (chg / prev.close * 100) : 0;
  const cls = chg >= 0 ? 'up' : 'down';

  const items = [
    ['info-name',   `${data.code} ${data.name}`],
    ['info-price',  fmt(last.close), cls],
    ['info-change', `${chg>=0?'+':''}${fmt(chg)} (${fmtPct(chgPct)})`, cls],
    ['info-volume', fmtK(last.volume)],
    ['info-high',   fmt(last.high)],
    ['info-low',    fmt(last.low)],
  ];
  items.forEach(([id, txt, c]) => {
    const el = $(id);
    if (!el) return;
    const v = el.querySelector('.info-value');
    if (v) { v.textContent = txt; v.classList.remove('up','down'); if(c) v.classList.add(c); }
  });
  infoBar.classList.remove('hidden');
}

function updateSidebar(data, triggers, analysis) {
  const last = data.rows[data.rows.length - 1];

  // 公司簡介與四大面評分
  const scoreEl = $('stock-score');
  const t = analysis.scores.total;
  scoreEl.textContent = t;
  scoreEl.style.color = t >= 80 ? '#ef4444' : t >= 60 ? '#f59e0b' : '#22c55e';
  $('company-desc').textContent = getCompanyDesc(data.code);

  // 策略標籤與趨勢標籤
  $('tag-strategy').textContent = `🔥 主導: ${analysis.bestStratName}`;
  $('tag-health').textContent = analysis.trendHealth;
  if (analysis.trendHealth.includes('過熱') || analysis.trendHealth.includes('跌破')) {
    $('tag-health').style.background = 'rgba(239,68,68,0.15)';
    $('tag-health').style.color = '#f87171';
  } else {
    $('tag-health').style.background = 'rgba(34,197,94,0.15)';
    $('tag-health').style.color = '#4ade80';
  }

  $('score-bars-container').style.display = 'flex';
  const setBar = (id, val) => {
    $(id+'-val').textContent = val;
    const fill = $(id+'-fill');
    fill.style.width = val + '%';
    fill.style.backgroundColor = val >= 80 ? '#ef4444' : val >= 60 ? '#f59e0b' : '#22c55e';
  };
  setBar('score-fund', analysis.scores.fund);
  setBar('score-tech', analysis.scores.tech);
  setBar('score-chip', analysis.scores.chip);

  // 關鍵線卡片
  if (triggers.length > 0) {
    const active = triggers[triggers.length - 1];
    const dist = ((last.close - active.price) / active.price * 100);
    $('keyline-price').textContent = fmt(active.price);
    $('keyline-date').textContent = `觸發日：${fmtDate(active.date)}`;
    $('keyline-deviation').textContent = fmtPct(dist);
    $('keyline-deviation').style.color = dist >= 0 ? '#ef4444' : '#22c55e';
    $('keyline-gain').textContent = `+${active.gain.toFixed(1)}%`;
    $('keyline-gain').style.color = '#ef4444';
    $('keyline-count').textContent = `${triggers.length} 次`;
    $('elim-card').style.display = 'none';
  } else {
    $('keyline-price').textContent = '未找到';
    $('keyline-date').textContent = '';
    $('keyline-deviation').textContent = '—';
    $('keyline-gain').textContent = '—';
    $('keyline-count').textContent = '0 次';
    $('elim-card').style.display = 'block';
  }

  // 10MA 卡片
  $('ma-value').textContent = fmt(analysis.ma10Val);
  $('ma-direction').textContent = analysis.ma10Dir;
  $('ma-direction').style.color = analysis.ma10Dir === '向上' ? '#ef4444' : analysis.ma10Dir === '向下' ? '#22c55e' : '';
  $('ma-deviation').textContent = fmtPct(analysis.deviation);
  $('ma-deviation').style.color = analysis.deviation >= 0 ? '#ef4444' : '#22c55e';

  // 訊號卡片
  const badge = $('signal-badge');
  badge.textContent = analysis.signal;
  badge.className = `signal-badge ${analysis.signalClass}`;
  $('signal-detail').textContent = analysis.detail;

  // 顯示 ATR 動態風控
  $('atr-value').textContent = `ATR: ${analysis.atr.toFixed(2)}`;
  if (triggers.length > 0) {
    $('atr-box').style.display = 'grid';
    $('stop-loss-val').textContent = fmt(analysis.stopLoss);
    $('take-profit-val').textContent = fmt(analysis.takeProfit);
  } else {
    $('atr-box').style.display = 'none';
  }

  // 三大法人動態卡片更新
  updateInstCard(data.code);
}

async function updateInstCard(stockCode) {
  const card = $('inst-card');
  const errEl = $('inst-error');

  // 顯示 Loading 狀態
  card.style.display = 'block';
  errEl.style.display = 'none';
  ['inst-foreign','inst-trust','inst-dealer','inst-total', 'margin-bal', 'margin-chg', 'short-bal', 'short-chg', 'margin-ratio'].forEach(id => {
    const el = $(id);
    if (el) { el.textContent = '載入中...'; el.className = 'inst-value neutral'; }
  });
  $('inst-date').textContent = '讀取中';
  if ($('inst-analysis')) $('inst-analysis').textContent = '正在分析籌碼動態...';

  const { instData, marginData } = await fetchFinMindChipData(stockCode);

  if (!instData && !marginData) {
    // 兩者都無法取得：顯示卡片但標記錯誤
    errEl.style.display = 'block';
    ['inst-foreign','inst-trust','inst-dealer','inst-total', 'margin-bal', 'margin-chg', 'short-bal', 'short-chg', 'margin-ratio'].forEach(id => {
      const el = $(id);
      if (el) { el.textContent = '—'; el.className = 'inst-value neutral'; }
    });
    $('inst-date').textContent = '';
    if ($('inst-analysis')) $('inst-analysis').textContent = '資料不足，無法判定';
    return;
  }

  const setInstVal = (id, shares) => {
    const el = $(id);
    if (!el) return;
    if (shares === null || shares === undefined) {
      el.textContent = '—';
      el.className = 'inst-value neutral';
      return;
    }
    const lots = Math.round(shares / 1000);
    const prefix = lots > 0 ? '+' : '';
    el.textContent = prefix + fmtShares(shares) + ' 張';
    el.className = 'inst-value ' + (lots > 0 ? 'buy' : lots < 0 ? 'sell' : 'neutral');
  };

  const setBalVal = (id, shares) => {
    const el = $(id);
    if (!el) return;
    if (shares === null || shares === undefined) {
      el.textContent = '—';
      el.className = 'inst-value neutral';
      return;
    }
    el.textContent = fmtShares(shares) + ' 張';
    el.className = 'inst-value'; // 餘額不特別標顏色
  };

  if (instData) {
    setInstVal('inst-foreign', instData.foreign);
    setInstVal('inst-trust', instData.trust);
    setInstVal('inst-dealer', instData.dealer);
    setInstVal('inst-total', instData.total);
  } else {
    ['inst-foreign','inst-trust','inst-dealer','inst-total'].forEach(id => setInstVal(id, null));
  }

  if (marginData) {
    const marginNet = marginData.marginNet;
    const shortNet = marginData.shortNet;
    
    setBalVal('margin-bal', marginData.marginBal);
    setInstVal('margin-chg', marginNet);
    setBalVal('short-bal', marginData.shortBal);
    setInstVal('short-chg', shortNet);

    const ratioEl = $('margin-ratio');
    if (ratioEl && marginData.marginBal > 0) {
      const ratio = (marginData.shortBal / marginData.marginBal) * 100;
      ratioEl.textContent = ratio.toFixed(2) + '%';
      ratioEl.className = 'inst-value ' + (ratio > 10 ? 'buy' : 'neutral'); // 券資比高容易軋空
    } else if (ratioEl) {
      ratioEl.textContent = '—';
      ratioEl.className = 'inst-value neutral';
    }
  } else {
    ['margin-bal', 'short-bal'].forEach(id => setBalVal(id, null));
    ['margin-chg', 'short-chg'].forEach(id => setInstVal(id, null));
    if ($('margin-ratio')) {
      $('margin-ratio').textContent = '—';
      $('margin-ratio').className = 'inst-value neutral';
    }
  }

  // 日期
  const dataDate = (instData && instData.date) || (marginData && marginData.date);
  if (dataDate) {
    $('inst-date').textContent = `${dataDate.slice(0,4)}/${dataDate.slice(4,6)}/${dataDate.slice(6,8)}`;
  }

  // 籌碼綜合判定
  const analysisEl = $('inst-analysis');
  if (analysisEl) {
    if (!instData && !marginData) {
      analysisEl.textContent = '資料不足，無法判定';
    } else {
      let text = '';
      let score = 0;

      if (instData) {
        if (instData.total > 0) {
          text += '法人偏多操作。';
          score += 1;
        } else if (instData.total < 0) {
          text += '法人偏空操作。';
          score -= 1;
        } else {
          text += '法人動向不明。';
        }
        
        if (instData.foreign > 0 && instData.trust > 0) {
          text += '土洋同買，籌碼穩定。';
          score += 1;
        } else if (instData.foreign < 0 && instData.trust < 0) {
          text += '土洋同賣，賣壓沉重。';
          score -= 1;
        }
      }

      if (marginData) {
        const marginNet = marginData.marginNet;
        if (marginNet > 0) {
          text += '散戶融資進場，';
          score -= 1;
        } else if (marginNet < 0) {
          text += '融資減肥，浮額洗淨。';
          score += 1;
        }

        if (marginData.marginBal > 0) {
          const ratio = (marginData.shortBal / marginData.marginBal) * 100;
          if (ratio > 10) {
            text += '券資比高，具軋空契機。';
            score += 1;
          }
        }
      }

      if (score >= 2) {
        analysisEl.innerHTML = `<span style="color:#ef4444; font-weight:bold;">【偏多】</span> ${text}可尋找進場契機。`;
      } else if (score <= -1) {
        analysisEl.innerHTML = `<span style="color:#22c55e; font-weight:bold;">【偏空】</span> ${text}建議觀望。`;
      } else {
        analysisEl.innerHTML = `<span style="color:#f59e0b; font-weight:bold;">【中性】</span> ${text}短線震盪。`;
      }
    }
  }
  return instData;
}

function buildAnalysisTab(data, triggers, analysis) {
  const last = data.rows[data.rows.length - 1];
  let html = '';

  html += `<h3>📊 ${data.code} ${data.name} 綜合分析</h3>`;
  html += `<p>最新收盤 <strong>${fmt(last.close)}</strong>`;

  if (triggers.length > 0) {
    const a = triggers[triggers.length - 1];
    const dist = ((last.close - a.price) / a.price * 100);
    html += `，關鍵一條線 <span class="tag gold">${fmt(a.price)}</span>（觸發於 ${fmtDate(a.date)}）</p>`;
    html += `<h3>關鍵線狀態</h3>`;
    html += `<p>現價與關鍵線距離：<span class="tag ${dist>=0?'red':'green'}">${fmtPct(dist)}</span>`;
    if (last.close < a.price) html += ` — <span class="tag green">已跌破</span>，進場條件消失`;
    else if (dist <= parseFloat(nearPctIn.value)) html += ` — <span class="tag gold">接近關鍵線，留意進場機會</span>`;
    else html += ` — 尚在安全距離`;
    html += `</p>`;
  } else {
    html += `</p><p><span class="tag gold">注意</span> 觀察期間無符合條件的突破紅K，無法畫出關鍵一條線。</p>`;
  }

  html += `<h3>10MA 均線分析</h3>`;
  html += `<p>10MA 現值 <strong>${fmt(analysis.ma10Val)}</strong>，方向 <span class="tag ${analysis.ma10Dir==='向上'?'red':'green'}">${analysis.ma10Dir}</span>`;
  html += `，乖離率 <span class="tag ${analysis.deviation>=0?'red':'green'}">${fmtPct(analysis.deviation)}</span></p>`;

  html += `<h3>操作建議</h3>`;
  html += `<p>${analysis.detail}</p>`;

  $('analysis-text').innerHTML = html;
}

function buildHistoryTab(triggers) {
  if (triggers.length === 0) {
    $('history-table-wrap').innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;padding:1rem 0;">觀察期間內無觸發記錄。</p>';
    return;
  }
  let html = '<table class="history-table"><thead><tr><th>#</th><th>日期</th><th>收盤</th><th>漲幅</th><th>關鍵線價位</th><th>狀態</th></tr></thead><tbody>';
  triggers.forEach((t, i) => {
    const isActive = i === triggers.length - 1;
    html += `<tr class="${isActive?'active-row':''}">`;
    html += `<td>${i+1}</td><td>${fmtDate(t.date)}</td><td>${fmt(t.close)}</td>`;
    html += `<td style="color:#ef4444">+${t.gain.toFixed(1)}%</td>`;
    html += `<td>${fmt(t.price)}</td>`;
    html += `<td>${isActive?'✦ 有效':'歷史'}</td></tr>`;
  });
  html += '</tbody></table>';
  $('history-table-wrap').innerHTML = html;
}

function buildLinksTab(code) {
  const links = [
    { icon:'📈', text:'Goodinfo', desc:'基本面/技術面', url:`https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=${code}` },
    { icon:'📊', text:'Yahoo 股市', desc:'即時報價', url:`https://tw.stock.yahoo.com/quote/${code}.TW` },
    { icon:'🏛️', text:'證交所', desc:'公開資訊', url:`https://www.twse.com.tw/zh/trading/single/STOCK_DAY?stockNo=${code}` },
    { icon:'📰', text:'CMoney', desc:'籌碼/法人', url:`https://www.cmoney.tw/finance/f00025.aspx?s=${code}` },
    { icon:'💹', text:'TradingView', desc:'國際圖表', url:`https://tw.tradingview.com/chart/?symbol=TWSE%3A${code}` },
    { icon:'🔍', text:'Wantgoo', desc:'技術分析', url:`https://www.wantgoo.com/stock/${code}` },
  ];
  $('links-content').innerHTML = links.map(l =>
    `<a class="link-card" href="${l.url}" target="_blank" rel="noopener">
      <span class="link-icon">${l.icon}</span>
      <div><div class="link-text">${l.text}</div><div class="link-desc">${l.desc}</div></div>
    </a>`
  ).join('');
}

// ═══ 主流程 ═══
function findCodeByNameOrCode(input) {
  if (/^\d{4,6}$/.test(input)) return input;
  if (twseNameMap) {
    for (let [code, name] of Object.entries(twseNameMap)) {
      if (name === input || name.includes(input)) return code;
    }
  }
  for (let [code, name] of Object.entries(BUILTIN_NAMES)) {
    if (name === input || name.includes(input)) return code;
  }
  return null;
}

async function loadStock(input) {
  const code = findCodeByNameOrCode(input);
  if (!code) { toast('找不到符合的股票代碼或名稱','error'); return; }
  
  // 若使用者輸入中文，自動幫他把輸入框換成「代碼」以便辨識
  if (input !== code) stockInput.value = code;

  welcomeEl.classList.add('hidden');
  appLayout.classList.remove('hidden');
  chartLoading.classList.remove('hidden');
  searchBtn.disabled = true;
  searchBtn.textContent = '載入中…';

  try {
    const range = rangeSelect.value;
    const data = await fetchStock(code, range);
    currentData = data;

    const lookback = parseInt(lookbackIn.value) || 20;
    const threshold = parseFloat(thresholdIn.value) || 4;
    const nearPct = parseFloat(nearPctIn.value) || 3;

    const triggers = calcKeylines(data.rows, lookback, threshold);
    const analysis = analyzeSignal(data.rows, triggers, nearPct);

    renderChart(data, triggers, analysis);
    updateInfoBar(data);
    updateSidebar(data, triggers, analysis);
    buildAnalysisTab(data, triggers, analysis);
    buildHistoryTab(triggers);
    buildLinksTab(code);
    bottomPanel.classList.remove('hidden');

    // 盤中模式分析
    updateIntradayCard(data, triggers, analysis.atr);

    // 存儲以便盤中自動刷新
    currentData = data;
    currentData._triggers = triggers;
    currentData._atr = analysis.atr;

    // 非同步載入三大法人與融資融券資料（不阻塞主流程）
    updateInstCard(code).then(instData => {
      // 如果法人數據到位，重新計算 chip 評分並更新側邊欄
      if (instData) {
        // 暫存法人資料供 analyzeSignal 使用
        currentData._instData = instData;
        const newAnalysis = analyzeSignal(data.rows, triggers, nearPct, instData);
        const setBar = (id, val) => {
          $(id+'-val').textContent = val;
          const fill = $(id+'-fill');
          fill.style.width = val + '%';
          fill.style.backgroundColor = val >= 80 ? '#ef4444' : val >= 60 ? '#f59e0b' : '#22c55e';
        };
        setBar('score-chip', newAnalysis.scores.chip);
        const t = newAnalysis.scores.total;
        $('stock-score').textContent = t;
        $('stock-score').style.color = t >= 80 ? '#ef4444' : t >= 60 ? '#f59e0b' : '#22c55e';
      }
    }).catch(console.error);

  } catch (err) {
    toast(err.message || '載入失敗', 'error');
    appLayout.classList.add('hidden');
    welcomeEl.classList.remove('hidden');
  } finally {
    chartLoading.classList.add('hidden');
    searchBtn.disabled = false;
    searchBtn.textContent = '分析';
  }
}

// ═══ 事件綁定 ═══
searchBtn.addEventListener('click', () => loadStock(stockInput.value.trim()));
stockInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); loadStock(stockInput.value.trim()); } });

settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('hidden'));

// 快速選股按鈕
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const code = btn.dataset.code;
    stockInput.value = code;
    loadStock(code);
  });
});

// Tab 切換
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const pane = $('tab-' + btn.dataset.tab);
    if (pane) pane.classList.add('active');
  });
});

// 設定變更後自動重新分析
[thresholdIn, lookbackIn, nearPctIn].forEach(el => {
  el.addEventListener('change', () => {
    const code = stockInput.value.trim();
    if (code && currentData) loadStock(code);
  });
});

// ═══ 盤中模式切換 ═══
const intradayCheckbox = $('intraday-checkbox');
const intradayToggle = $('intraday-toggle');

intradayCheckbox.addEventListener('change', () => {
  intradayMode = intradayCheckbox.checked;
  intradayToggle.classList.toggle('active', intradayMode);
  document.body.classList.toggle('intraday-active', intradayMode);

  if (intradayMode) {
    toast('🕒 盤中模式已啟動，每 60 秒自動刷新', 'success');
    // 立即分析
    if (currentData && currentData._triggers) {
      updateIntradayCard(currentData, currentData._triggers, currentData._atr);
    }
    // 定時自動刷新
    intradayTimer = setInterval(() => {
      const code = stockInput.value.trim();
      if (code && intradayMode && isMarketHours()) {
        loadStock(code);
      }
    }, 60000); // 60 秒
  } else {
    toast('盤中模式已關閉', 'info');
    if (intradayTimer) { clearInterval(intradayTimer); intradayTimer = null; }
    $('intraday-card').style.display = 'none';
  }
});

// ═══ 頁面載入時背景載入中文名稱 & 掃描按鈕 ═══
window.addEventListener('DOMContentLoaded', () => {
  loadTWSENames();

  // 掃描按鈕
  const scanBtn = $('scan-btn');
  if (scanBtn) {
    scanBtn.addEventListener('click', () => scanStocks());
  }

  // 點擊 Logo 回到首頁 (保留掃描結果)
  const logo = document.querySelector('.logo');
  if (logo) {
    logo.style.cursor = 'pointer';
    logo.addEventListener('click', () => {
      $('app-layout').classList.add('hidden');
      $('welcome-screen').classList.remove('hidden');
    });
  }

  // 恢復上次掃描結果
  try {
    const savedResults = sessionStorage.getItem('scanResults');
    const savedStats = sessionStorage.getItem('scanStats');
    if (savedResults) {
      const results = JSON.parse(savedResults);
      if (results && results.length > 0) {
        renderScanResults(results, $('scan-results'));
      }
    }
    if (savedStats && $('scan-stats')) {
      $('scan-stats').textContent = savedStats;
    }
  } catch(e) {}
});

})();
