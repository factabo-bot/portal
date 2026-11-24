// 経費の振り分け（ポータルから）。元の仕訳アプリ projects/keihi-shiwake-gas と同じラベル・保存先・記録の形。
// できることは2つだけ：①未仕分けの一覧（日付・店・金額・品名の頭）②一覧に今ある分を 事業／私用／対象外 に分ける。
// 取り消し・ほかのメールを読む・本文を返す、はしない（取り消しはログインが要る元のアプリで）。
// 合言葉は経費専用の KEIHI_TOKEN。1時間に60件まで。
// 元のアプリの検索条件・読み取りを直したら、ここも合わせる（K_ で始まるものは元の Code.js の写し）。

var K_SINCE = '2026/10/01';
var K_FOLDER_PATH = ['obsidian', '10_Tomato', '02_経営・資金', '05_税務・会計', '開業前の購入記録'];
var K_LABELS = { biz: '経費/事業', personal: '経費/私用', none: '経費/対象外' };
var K_BUY_SUBJECTS = ['Amazon.co.jpでのご注文', 'ご注文ありがとうございます', 'ご注文内容確認', '注文確認', '領収書',
  'ご購入が完了', 'ご注文明細', 'Amazon Pay ご請求', '定期購入を更新'];
var K_QUERY = [
  'after:' + K_SINCE,
  '-label:経費-事業 -label:経費-私用 -label:経費-対象外',
  '-category:promotions',
  '-subject:(発送 OR 出荷 OR 配達 OR お届け OR 受け取り OR 会員登録 OR 解約 OR 予約購入 OR キャンセル OR 認証 OR 第三者)',
  '(from:auto-confirm@amazon.co.jp OR subject:(' + K_BUY_SUBJECTS.map(function (x) { return '"' + x + '"'; }).join(' OR ') + '))',
].join(' ');
var K_PENDING_CACHE = 'keihi_pending_ids';
var K_RATE = 60;

function keihiHandle_(body) {
  if (!same_(body.key, KEIHI_TOKEN)) return { ok: false, error: 'key' };
  if (body.type === 'keihiList') return { ok: true, items: kList_() };
  if (body.type === 'keihiClassify') {
    var kind = String(body.kind || '');
    if (!K_LABELS[kind]) return { ok: false, error: 'kind' };
    var id = String(body.id || '');
    if (!/^[0-9a-f]{12,20}$/.test(id)) return { ok: false, error: 'id' };
    var cache = CacheService.getScriptCache();
    var pending = JSON.parse(cache.get(K_PENDING_CACHE) || '[]');
    if (pending.indexOf(id) < 0) return { ok: false, error: 'not_pending' };   // 一覧に出した物以外は触らない
    var hour = 'keihi_rate_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHH');
    var used = Number(cache.get(hour) || 0);
    if (used >= K_RATE) return { ok: false, error: 'rate' };
    cache.put(hour, String(used + 1), 3700);
    return kClassify_(id, kind);
  }
  return { ok: false, error: 'type' };
}

function kList_() {
  var threads = GmailApp.search(K_QUERY, 0, 60);
  var msgs = GmailApp.getMessagesForThreads(threads);
  var out = [];
  msgs.forEach(function (ms) {
    ms.forEach(function (m) {
      if (out.length >= 60) return;
      var s = kSummarize_(m);
      out.push({ id: s.id, date: s.date.slice(0, 10), shop: s.shop.slice(0, 30), amount: s.amount,
        item: (s.items[0] || '').slice(0, 40), more: Math.max(0, s.items.length - 1) });
    });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  CacheService.getScriptCache().put(K_PENDING_CACHE, JSON.stringify(out.map(function (x) { return x.id; })), 21600);
  return out;
}

function kLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function kBaseFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('KEIHI_BASE_FOLDER');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* 探し直す */ }
  }
  var f = DriveApp.getRootFolder();
  K_FOLDER_PATH.forEach(function (n) {
    var it = f.getFoldersByName(n);
    f = it.hasNext() ? it.next() : f.createFolder(n);
  });
  props.setProperty('KEIHI_BASE_FOLDER', f.getId());
  return f;
}

function kReceiptFolder_() {
  var b = kBaseFolder_();
  var it = b.getFoldersByName('領収書');
  return it.hasNext() ? it.next() : b.createFolder('領収書');
}

function kSummarize_(m) {
  var from = m.getFrom();
  var subj = m.getSubject();
  var body = m.getPlainBody() || '';
  var shop = (from.match(/^"?([^"<]+)"?\s*</) || [, from])[1].trim();
  if (/amazon/i.test(from)) shop = 'Amazon';
  if (/Amazon Pay/.test(subj)) shop = (subj.split(/[:：]/)[0] || '').trim() + '（Amazon Pay）';
  var items = [];
  var r;
  var reStar = /^\* (.+)$/gm;
  while ((r = reStar.exec(body)) !== null) items.push(r[1].trim());
  var reName = /(?:ご注文商品名|商品名|品名)[：:]\s*(.+)/g;
  while (items.length === 0 && (r = reName.exec(body)) !== null) items.push(r[1].trim());
  var a1 = body.match(/合計\s*\n\s*([\d,]+)\s*JPY/);
  var a2 = body.match(/(?:合計金額[^\d¥￥]{0,10}|ご請求金額|お支払い?金額|ご利用金額|合計)[^\d¥￥\n]{0,15}[¥￥]?\s*([\d,]{3,})/);
  var a3 = body.match(/[¥￥]\s*([\d,]{3,})/);
  var amount = ((a1 || a2 || a3 || [])[1] || '').replace(/,/g, '');
  var order = (body.match(/\d{3}-\d{7}-\d{7}/) || body.match(/(?:注文コード|注文番号)[：:\s]*([A-Za-z0-9-]+)/) || [''])[0]
    .replace(/^(?:注文コード|注文番号)[：:\s]*/, '');
  return {
    id: m.getId(),
    date: Utilities.formatDate(m.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'),
    shop: shop,
    items: items.length ? items : [subj.replace(/^注文済み[:：]\s*/, '')],
    amount: amount,
    order: order,
  };
}

function kSafe_(s) {
  return String(s).replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
}
function kEscape_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function kSaveReceipt_(m, s) {
  var folder = kReceiptFolder_();
  var item = kSafe_(s.items[0] || '').slice(0, 24);
  var name = kSafe_([s.date.slice(0, 10), s.shop, s.amount || '金額不明', item, s.order || m.getId()].join('_'));
  var head = '<div style="font:13px sans-serif;border-bottom:1px solid #999;padding:6px 0;margin:0 0 10px">'
    + '件名：' + kEscape_(m.getSubject()) + '<br>差出人：' + kEscape_(m.getFrom())
    + '<br>受信：' + s.date + '（JST）<br>Gmailから保存（' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd') + '・ポータルから）。原本は同名の .eml</div>';
  var body = m.getBody() || ('<pre style="white-space:pre-wrap">' + kEscape_(m.getPlainBody()) + '</pre>');
  var html = '<!doctype html><meta charset="utf-8">' + head + body;
  var pdf = Utilities.newBlob(html, 'text/html', name + '.html').getAs('application/pdf').setName(name + '.pdf');
  folder.createFile(pdf);
  folder.createFile(Utilities.newBlob(m.getRawContent(), 'message/rfc822', name + '.eml'));
  return name;
}

function kAppendCsv_(row) {
  var base = kBaseFolder_();
  var it = base.getFilesByName('仕分け記録.csv');
  var line = row.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',') + '\n';
  if (it.hasNext()) {
    var f = it.next();
    f.setContent(f.getBlob().getDataAsString('UTF-8') + line);
  } else {
    base.createFile('仕分け記録.csv', '"仕分けた日","受信日","店","金額","品名","注文番号","保存した名前","メールID"\n' + line, 'text/csv');
  }
}

function kClassify_(id, kind) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var m = GmailApp.getMessageById(id);
    var t = m.getThread();
    var names = t.getLabels().map(function (l) { return l.getName(); });
    if (names.indexOf(K_LABELS.biz) >= 0 || names.indexOf(K_LABELS.personal) >= 0 || names.indexOf(K_LABELS.none) >= 0) {
      return { ok: true, already: true };
    }
    var saved = '';
    if (kind === 'biz') {
      var s = kSummarize_(m);
      saved = kSaveReceipt_(m, s);
      kAppendCsv_([Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') + '（ポータル）', s.date, s.shop, s.amount,
        s.items.join(' / '), s.order, saved, id]);
    }
    t.addLabel(kLabel_(K_LABELS[kind]));
    return { ok: true, saved: saved ? true : false };
  } finally {
    lock.releaseLock();
  }
}
