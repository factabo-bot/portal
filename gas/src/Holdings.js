// 保有資産（マネーフォワード ME などの保有一覧を貼り付けて取り込む）。お金の合言葉（KEIHI_TOKEN）でだけ読める。
// 株は Yahoo Finance の値段とドル円で評価し直す。投資信託は貼り付けた時点の基準価額のまま。

var HOLD_KEY = 'portal_holdings';

function holdingsHandle_(body, props) {
  if (!same_(body.key, KEIHI_TOKEN)) return { ok: false, error: 'key' };
  if (body.type === 'holdingsImport') {
    var h = parseHoldings_(String(body.text || '').slice(0, 60000));
    if (!h.stocks.length && !h.funds.length) return { ok: false, error: 'parse' };
    var s = JSON.stringify(h);
    if (s.length > 8800) return { ok: false, error: 'too_large' };
    props.setProperty(HOLD_KEY, s);
    return { ok: true, stocks: h.stocks.length, funds: h.funds.length };
  }
  if (body.type === 'holdingsGet') {
    var raw = props.getProperty(HOLD_KEY);
    if (!raw) return { ok: true, holdings: null };
    return { ok: true, holdings: valueHoldings_(JSON.parse(raw)) };
  }
  return { ok: false, error: 'type' };
}

// 1銘柄のローソク足。期間ごとに1本の長さを変える（1日＝5分足、1か月・1年＝日足、5年＝週足、15年＝月足）
var CHART_RANGES = {
  '1d': { q: 'range=1d&interval=5m', ttl: 300 },
  '1mo': { q: 'range=1mo&interval=1d', ttl: 1800 },
  '1y': { q: 'range=1y&interval=1d', ttl: 3600 },
  '5y': { q: 'range=5y&interval=1wk', ttl: 3600 },
  '15y': { years: 15, interval: '1mo', ttl: 21600 }
};
function chart_(code, range) {
  var r = CHART_RANGES[range];
  code = code.trim().toUpperCase();
  if (!r || !/^[0-9A-Z][0-9A-Z .\-]{0,9}$/.test(code)) return { ok: false, error: 'arg' };
  var sym = ySymbol_(code);
  var cache = CacheService.getScriptCache();
  var k = 'ch_' + range + '_' + sym;
  var c = cache.get(k);
  if (c) return JSON.parse(c);
  var q = r.q;
  if (!q) {
    var now = Math.floor(Date.now() / 1000);
    q = 'period1=' + (now - r.years * 365.25 * 86400).toFixed(0) + '&period2=' + now + '&interval=' + r.interval;
  }
  var res = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?' + q,
    { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'HTTP ' + res.getResponseCode() };
  var d = JSON.parse(res.getContentText()).chart.result[0];
  var qt = (d.indicators && d.indicators.quote && d.indicators.quote[0]) || {};
  var ts = d.timestamp || [];
  var dig = d.meta.currency === 'JPY' ? 1 : 100;
  var rd = function (v) { return Math.round(v * dig) / dig; };
  var bars = [];
  for (var i = 0; i < ts.length; i++) {
    if (qt.open[i] == null || qt.close[i] == null) continue;   // 値のない足（取引のない時間）は飛ばす
    bars.push([ts[i], rd(qt.open[i]), rd(qt.high[i]), rd(qt.low[i]), rd(qt.close[i])]);
  }
  var out = { ok: true, code: code, range: range, currency: d.meta.currency, gmtoffset: d.meta.gmtoffset || 0,
    prev: range === '1d' ? (d.meta.chartPreviousClose || d.meta.previousClose || null) : null, bars: bars };
  var s = JSON.stringify(out);
  if (s.length < 90000) cache.put(k, s, r.ttl);
  return out;
}

function num_(s) { var n = Number(String(s || '').replace(/[,円%\s]/g, '')); return isFinite(n) ? n : 0; }

// 表の貼り付け（タブ区切り）を読む。「株式(現物)」「投資信託」の見出しで切り替える
function parseHoldings_(text) {
  var sec = '';
  var stocks = [], funds = [];
  text.split(/\r?\n/).forEach(function (line) {
    if (/^株式/.test(line.trim())) { sec = 'stock'; return; }
    if (/^投資信託/.test(line.trim())) { sec = 'fund'; return; }
    var c = line.split('\t').map(function (x) { return x.trim(); });
    if (c.length < 9) return;
    if (sec === 'stock' && /^[0-9A-Z][0-9A-Z .]{0,9}$/.test(c[0]) && num_(c[2]) > 0) {
      stocks.push({ code: c[0], name: c[1].slice(0, 30), qty: num_(c[2]), avg: num_(c[3]), price: num_(c[4]),
        value: num_(c[5]), cost: num_(c[5]) - num_(c[7]), inst: c[9] || '' });
    } else if (sec === 'fund' && num_(c[1]) > 0 && num_(c[4]) > 0) {
      funds.push({ name: c[0].replace(/\(.*?\)$/, '').slice(0, 40), qty: num_(c[1]), avg: num_(c[2]), nav: num_(c[3]),
        value: num_(c[4]), pnl: num_(c[6]), inst: c[8] || '' });
    }
  });
  return { at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'), stocks: stocks, funds: funds };
}

// 銘柄コード → Yahoo の記号（日本株は .T、BRK B → BRK-B）
function ySymbol_(code) {
  if (/^\d{3}[0-9A-Z]$/.test(code)) return code + '.T';
  return code.replace(/\s+/g, '-');
}

function quote_(sym) {
  var cache = CacheService.getScriptCache();
  var k = 'q1d_' + sym;
  var c = cache.get(k);
  if (c) return JSON.parse(c);
  var q = {};
  var r = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1d&interval=1d',
    { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });   // range=1d：chartPreviousClose が前日の終値になる
  if (r.getResponseCode() !== 200) return { error: 'HTTP ' + r.getResponseCode() };
  var meta = JSON.parse(r.getContentText()).chart.result[0].meta;
  q = { price: meta.regularMarketPrice, prev: meta.chartPreviousClose || meta.previousClose, currency: meta.currency, time: meta.regularMarketTime };
  cache.put(k, JSON.stringify(q), 600);
  return q;
}

function valueHoldings_(h) {
  var fx = quote_('USDJPY=X');
  var usd = fx.price || 0, usdPrev = fx.prev || usd;
  var stockTotal = 0, stockDay = 0, stockPnl = 0, latest = 0;
  var rows = h.stocks.map(function (s) {
    var sym = ySymbol_(s.code);
    var q = {};
    try { q = quote_(sym); } catch (err) { q = { error: String(err).slice(0, 60) }; }
    var isUsd = q.currency === 'USD' || !/\.T$/.test(sym);
    var rate = isUsd ? usd : 1, ratePrev = isUsd ? usdPrev : 1;
    var price = q.price != null ? q.price : s.price;
    var prev = q.prev != null ? q.prev : price;
    var value = q.error || !rate ? s.value : price * s.qty * rate;
    var day = q.error || !rate ? 0 : (price * rate - prev * ratePrev) * s.qty;
    var cost = s.cost != null ? s.cost : s.avg * s.qty * rate;   // 円での取得額＝貼った表の「評価額−評価損益」（米株は買ったときのレートが入っている）
    var pnl = value - cost;
    if (q.time) latest = Math.max(latest, q.time);
    stockTotal += value; stockDay += day; stockPnl += pnl;
    return { code: s.code, name: s.name, qty: s.qty, price: price, cur: isUsd ? 'USD' : 'JPY', value: Math.round(value),
      day: Math.round(day), pnl: Math.round(pnl), pnlPct: cost ? pnl / cost * 100 : 0, inst: s.inst, stale: !!q.error };
  });
  var fundTotal = 0, fundPnl = 0;
  var funds = h.funds.map(function (f) {
    fundTotal += f.value; fundPnl += f.pnl;
    var cost = f.value - f.pnl;
    return { name: f.name, value: f.value, pnl: f.pnl, pnlPct: cost ? f.pnl / cost * 100 : 0, inst: f.inst };
  });
  return {
    at: h.at, fx: usd, quoteTime: latest,
    stockTotal: Math.round(stockTotal), stockDay: Math.round(stockDay), stockPnl: Math.round(stockPnl),
    fundTotal: Math.round(fundTotal), fundPnl: Math.round(fundPnl),
    stocks: rows, funds: funds
  };
}
