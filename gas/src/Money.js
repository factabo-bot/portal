// 家計（マネーフォワード ME のウィークリーメールから今月の支出の目安）と株価。
// マネーフォワードにはログインしない（規約第13条(43)・パスワードを置かないため）。数字はメールから読むだけ。

var MF_BUDGET_KEY = 'portal_mf_budget';
var STOCKS_KEY = 'portal_stocks';

// 今月の支出の目安：対象期間が今月にかかる週の「今週の支出」を、今月に入る日数の割合で足す
function mfMonth_() {
  var tz = 'Asia/Tokyo';
  var now = new Date();
  var ym = Utilities.formatDate(now, tz, 'yyyy-MM');
  var first = new Date(ym + '-01T00:00:00+09:00');
  var after = Utilities.formatDate(new Date(first.getTime() - 9 * 86400000), tz, 'yyyy/MM/dd');
  var threads = GmailApp.search('from:feedback@moneyforward.com subject:ウィークリーメール after:' + after, 0, 10);
  var weeks = [];
  GmailApp.getMessagesForThreads(threads).forEach(function (ms) {
    ms.forEach(function (m) {
      var b = m.getPlainBody() || '';
      var amt = b.match(/今週の支出\s*\n\s*([\d,]+)円/);
      var per = b.match(/対象期間：(\d{4})年(\d{1,2})月(\d{1,2})日-(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (!amt || !per) return;
      var from = new Date(per[1], per[2] - 1, per[3]);
      var to = new Date(per[4], per[5] - 1, per[6]);
      weeks.push({ from: fmt_(from), to: fmt_(to), amount: Number(amt[1].replace(/,/g, '')) });
    });
  });
  // 重なりを除く（同じ週が2通あれば新しい方）
  var seen = {};
  weeks = weeks.filter(function (w) { if (seen[w.from]) return false; seen[w.from] = 1; return true; });
  var monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  var est = 0;
  var used = [];
  weeks.forEach(function (w) {
    var f = new Date(w.from.replace(/-/g, '/')), t = new Date(w.to.replace(/-/g, '/'));
    var days = Math.round((t - f) / 86400000);            // 例：11/14-11/21 → 7日
    if (days <= 0) return;
    var s = Math.max(f.getTime(), monthStart.getTime()), e = Math.min(t.getTime(), nextMonth.getTime());
    var inDays = Math.max(0, Math.round((e - s) / 86400000));
    if (!inDays) return;
    var part = Math.round(w.amount * inDays / days);
    est += part;
    used.push({ from: w.from, to: w.to, amount: w.amount, part: part });
  });
  used.sort(function (a, b) { return a.from < b.from ? -1 : 1; });
  var lastTo = used.length ? used[used.length - 1].to : '';
  var budget = Number(PropertiesService.getScriptProperties().getProperty(MF_BUDGET_KEY) || 0);
  return { month: ym, budget: budget, estimate: est, weeks: used, through: lastTo };
}
function fmt_(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd'); }

// 株価（Yahoo Finance の公開チャート。10分キャッシュ）
function stocks_() {
  var list = JSON.parse(PropertiesService.getScriptProperties().getProperty(STOCKS_KEY) || '[]');
  if (!list.length) return { list: [], quotes: [] };
  var cache = CacheService.getScriptCache();
  var quotes = list.map(function (s) {
    var k = 'q1d_' + s.code;
    var c = cache.get(k);
    if (c) return JSON.parse(c);
    var q = { code: s.code, name: s.name || s.code };
    try {
      var r = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s.code) + '?range=1d&interval=1d',
        { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.getResponseCode() === 200) {
        var meta = JSON.parse(r.getContentText()).chart.result[0].meta;
        q.price = meta.regularMarketPrice;
        q.prev = meta.chartPreviousClose || meta.previousClose;
        q.currency = meta.currency;
        q.time = meta.regularMarketTime;
      } else {
        q.error = 'HTTP ' + r.getResponseCode();
      }
    } catch (err) { q.error = String(err).slice(0, 80); }
    if (!q.error) cache.put(k, JSON.stringify(q), 600);
    return q;
  });
  return { list: list, quotes: quotes };
}

function saveMoneySettings_(props, body) {
  if (body.budget !== undefined) {
    var b = Math.max(0, Math.min(100000000, Math.round(Number(body.budget) || 0)));
    props.setProperty(MF_BUDGET_KEY, String(b));
  }
  if (body.stocks !== undefined) {
    var list = (Array.isArray(body.stocks) ? body.stocks : []).slice(0, 30).map(function (s) {
      return { code: String(s.code || '').trim().toUpperCase().slice(0, 15), name: String(s.name || '').trim().slice(0, 20) };
    }).filter(function (s) { return /^[A-Z0-9.^=-]{1,15}$/.test(s.code); });
    props.setProperty(STOCKS_KEY, JSON.stringify(list));
  }
  return { ok: true };
}
