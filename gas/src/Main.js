// 自分用ポータルの窓口。
// 合言葉は2つ（Secret.js、tools/deploy.py が .local.json から書き出す）：
//   WEBAPP_TOKEN … ブラウザ用。読む・リンクの保存だけ
//   PUSH_TOKEN   … PCの見回り役だけが持つ。セッション一覧の書き込み用
// 合言葉はURLに載せないため、問い合わせはすべて POST の本文で受ける。GET は生存確認だけ。

var VERSION = 4;
var PEST_LOG_NAME = '発生予察_新着ログ.md';
var LINKS_KEY = 'portal_links';
var SESSIONS_KEY = 'portal_sessions';

function doGet(e) {
  return json_({ ok: true, version: VERSION });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'json' }); }
  var props = PropertiesService.getScriptProperties();

  if (body.type === 'pushSessions') {
    if (!same_(body.key, PUSH_TOKEN)) return json_({ ok: false, error: 'key' });
    var s = JSON.stringify({ at: new Date().toISOString(), host: String(body.host || '').slice(0, 30), sessions: (body.sessions || []).slice(0, 30) });
    if (s.length > 8500) return json_({ ok: false, error: 'too_large' });
    props.setProperty(SESSIONS_KEY, s);
    return json_({ ok: true });
  }

  if (!same_(body.key, WEBAPP_TOKEN)) return json_({ ok: false, error: 'key' });

  if (body.type === 'get') {
    var out = { ok: true, version: VERSION };
    try { out.events = events_(); } catch (err) { out.eventsError = String(err); }
    try { out.pest = pest_(); } catch (err) { out.pestError = String(err); }
    var links = props.getProperty(LINKS_KEY);
    out.links = links ? JSON.parse(links) : null;
    var ses = props.getProperty(SESSIONS_KEY);
    out.sessions = ses ? JSON.parse(ses) : null;
    return json_(out);
  }
  if (body.type === 'saveLinks') {
    if (!body.links || !Array.isArray(body.links.sections)) return json_({ ok: false, error: 'links' });
    body.links.savedAt = new Date().toISOString();
    var t = JSON.stringify(body.links);
    if (t.length > 8500) return json_({ ok: false, error: 'too_large' });
    props.setProperty(LINKS_KEY, t);
    return json_({ ok: true, savedAt: body.links.savedAt });
  }
  return json_({ ok: false, error: 'type' });
}

// 合言葉の比較（長さと全文字を必ず見る）
function same_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!b || a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// 今日0時〜明後日0時の予定（表示しているカレンダーすべて）
function events_() {
  var tz = 'Asia/Tokyo';
  var start = new Date(Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'00:00:00XXX"));
  var end = new Date(start.getTime() + 2 * 86400000);
  var list = [];
  CalendarApp.getAllCalendars().forEach(function (cal) {
    if (cal.isHidden()) return;
    cal.getEvents(start, end).forEach(function (ev) {
      list.push({
        title: ev.getTitle(),
        start: ev.getStartTime().toISOString(),
        end: ev.getEndTime().toISOString(),
        allDay: ev.isAllDayEvent(),
        location: ev.getLocation() || '',
        color: cal.getColor()
      });
    });
  });
  list.sort(function (a, b) {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
  });
  return list;
}

// 予察ログの最後の「## ○○ 時点」の塊を表にして返す
function pest_() {
  var it = DriveApp.getFilesByName(PEST_LOG_NAME);
  if (!it.hasNext()) return null;
  var file = it.next();
  var text = file.getBlob().getDataAsString('UTF-8');
  var blocks = text.split(/\n(?=## )/);
  var last = blocks[blocks.length - 1];
  var head = (last.match(/^## (.+)$/m) || [])[1] || '';
  var rows = [];
  var mark = '';
  last.split(/\r?\n/).forEach(function (line) {
    var m = line.match(/^### (\S+)\s+(.+)$/);
    if (m) { mark = m[1]; return; }
    if (!/^\|/.test(line) || /^\|\s*区分|^\|\s*-/.test(line)) return;
    var c = line.split('|').slice(1, -1).map(function (s) { return s.trim(); });
    if (c.length < 5) return;
    rows.push({ mark: mark, kind: c[0], date: c[1], pref: c[2], crop: c[3], pest: c[4] });
  });
  return { heading: head, rows: rows, updated: file.getLastUpdated().toISOString() };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// エディタでこれを1回実行して、カレンダーとドライブを読む許可を出す
function authorize() {
  Logger.log(JSON.stringify({ events: events_().length, pest: pest_() ? 'ok' : 'none' }));
}
