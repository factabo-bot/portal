// 自分用ポータルの窓口。
// 合言葉は2つ（Secret.js、tools/deploy.py が .local.json から書き出す）：
//   WEBAPP_TOKEN … ブラウザ用。読む・リンクの保存だけ
//   PUSH_TOKEN   … PCの見回り役だけが持つ。セッション一覧の書き込み用
// 合言葉はURLに載せないため、問い合わせはすべて POST の本文で受ける。GET は生存確認だけ。

var VERSION = 6;
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

  // やりたいことの進み具合（PCの見立て役だけが書く）
  if (body.type === 'wishProgress') {
    if (!same_(body.key, PUSH_TOKEN)) return json_({ ok: false, error: 'key' });
    var STAGES = ['未着手', '考え中', '進んでいる', 'ほぼできた', 'かなったかも'];
    var n = 0;
    (body.items || []).slice(0, 200).forEach(function (it) {
      var id = String(it.id || '');
      if (!/^[0-9a-f]{8}$/.test(id)) return;
      var cur = props.getProperty('wish_' + id);
      if (!cur) return;
      var w = JSON.parse(cur);
      w.progress = {
        stage: STAGES.indexOf(it.stage) >= 0 ? it.stage : '未着手',
        line: String(it.line || '').slice(0, 80),
        sessions: (it.sessions || []).slice(0, 5).map(function (s) {
          return { t: String(s.t || '').slice(0, 60), d: String(s.d || '').slice(0, 10) };
        }),
        at: new Date().toISOString()
      };
      props.setProperty('wish_' + id, JSON.stringify(w));
      n++;
    });
    return json_({ ok: true, updated: n });
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
    out.wishes = wishes_(props);
    return json_(out);
  }
  // やりたいこと：1件ずつ別のキー（wish_<id>）に置く。1つの値の上限（9KB）に全体が縛られないように
  if (body.type === 'wishAdd') {
    var text = String(body.text || '').trim().slice(0, 200);
    if (!text) return json_({ ok: false, error: 'text' });
    if (wishes_(props).length >= 500) return json_({ ok: false, error: 'too_many' });
    var w = { id: Utilities.getUuid().slice(0, 8), text: text, at: wishDate_(body.at), state: 'open' };
    props.setProperty('wish_' + w.id, JSON.stringify(w));
    return json_({ ok: true, wish: w });
  }
  if (body.type === 'wishUpdate') {
    var id = String(body.id || '');
    if (!/^[0-9a-f]{8}$/.test(id)) return json_({ ok: false, error: 'id' });
    var cur = props.getProperty('wish_' + id);
    if (!cur) return json_({ ok: false, error: 'notfound' });
    var w2 = JSON.parse(cur);
    if (body.state !== undefined) {
      if (['open', 'done', 'drop'].indexOf(body.state) < 0) return json_({ ok: false, error: 'state' });
      w2.state = body.state;
      w2.closedAt = body.state === 'open' ? '' : Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    }
    if (body.text !== undefined) w2.text = String(body.text).trim().slice(0, 200) || w2.text;
    if (body.note !== undefined) w2.note = String(body.note).trim().slice(0, 300);
    props.setProperty('wish_' + id, JSON.stringify(w2));
    return json_({ ok: true, wish: w2 });
  }
  if (body.type === 'wishDelete') {
    var id3 = String(body.id || '');
    if (!/^[0-9a-f]{8}$/.test(id3)) return json_({ ok: false, error: 'id' });
    props.deleteProperty('wish_' + id3);
    return json_({ ok: true });
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

function wishes_(props) {
  var all = props.getProperties();
  var list = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('wish_') !== 0) return;
    try { list.push(JSON.parse(all[k])); } catch (err) {}
  });
  list.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  return list;
}
function wishDate_(s) {
  s = String(s || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
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
