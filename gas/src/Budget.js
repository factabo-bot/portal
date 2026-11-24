// 家計の分類別（マネーフォワードの「収入・支出詳細」CSV をドライブから読む）。お金の合言葉（KEIHI_TOKEN）でだけ読める。
// 数え方は vault の 50_生活/家計レポート_2026年1-10月/_作業/集計.py と同じ：
//   計算対象=1・振替=0 だけ、収入・特別な支出・税・社会保障・中項目「電子マネー」（Suicaへの入金）は除く。
// 目標：自分で整理した目標＝50_生活/18_生活費_月額予算目標.md（年額÷12）。MFの予算＝11/24の予算画面（使った＋残り）。

// 目標額（BUDGET_OWN・BUDGET_MF）は公開しないファイル src/BudgetPrivate.js に置く（git に入れない。clasp では送る）
var BUDGET_EXCLUDE = ['収入', '特別な支出', '税・社会保障'];

function budgetHandle_(body) {
  if (!same_(body.key, KEIHI_TOKEN)) return { ok: false, error: 'key' };
  if (body.type === 'budgetGet') return { ok: true, budget: budget_() };
  return { ok: false, error: 'type' };
}

// いちばん新しい月の CSV（同じ月が複数なら更新が新しい方）
function latestMfCsv_() {
  var it = DriveApp.searchFiles("title contains '収入・支出詳細_' and trashed = false");
  var best = null;
  while (it.hasNext()) {
    var f = it.next();
    var m = f.getName().match(/収入・支出詳細_(\d{4}-\d{2})-01_(\d{4}-\d{2}-\d{2})/);
    if (!m || !/\.csv$/i.test(f.getName())) continue;
    var key = m[1] + '|' + m[2] + '|' + f.getLastUpdated().toISOString();
    if (!best || key > best.key) best = { key: key, file: f, month: m[1], to: m[2] };
  }
  return best;
}

function budget_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('budget_v1');
  if (hit) return JSON.parse(hit);
  var b = latestMfCsv_();
  if (!b) return null;
  var rows = Utilities.parseCsv(b.file.getBlob().getDataAsString('Shift_JIS'));
  var sum = {}, lastDate = '';
  rows.slice(1).forEach(function (x) {
    if (x.length < 9 || x[0] !== '1' || x[8] !== '0') return;
    if (BUDGET_EXCLUDE.indexOf(x[5]) >= 0 || x[6] === '電子マネー') return;
    var v = -Number(x[3]);
    if (!isFinite(v)) return;
    sum[x[5]] = (sum[x[5]] || 0) + v;
    if (x[1] > lastDate) lastDate = x[1];
  });
  var names = Object.keys(sum);
  Object.keys(BUDGET_OWN).forEach(function (k) { if (names.indexOf(k) < 0) names.push(k); });
  var cats = names.map(function (k) {
    return { name: k, actual: Math.round(sum[k] || 0), own: BUDGET_OWN[k] ? Math.round(BUDGET_OWN[k]) : 0, mf: BUDGET_MF[k] || 0 };
  });
  cats.sort(function (a, b) { return (b.own ? 1 : 0) - (a.own ? 1 : 0) || b.actual - a.actual; });
  var ownCats = cats.filter(function (c) { return c.own; });
  var out = {
    month: b.month, through: lastDate.replace(/\//g, '-'), file: b.file.getName(), updated: b.file.getLastUpdated().toISOString(),
    living: ownCats.reduce(function (a, c) { return a + c.actual; }, 0),       // 純生活費（目標のある分類の合計）
    livingTarget: ownCats.reduce(function (a, c) { return a + c.own; }, 0),
    all: cats.reduce(function (a, c) { return a + c.actual; }, 0),
    cats: cats
  };
  cache.put('budget_v1', JSON.stringify(out), 600);
  return out;
}
