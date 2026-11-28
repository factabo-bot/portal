// 自分用ポータルの窓口。
// 合言葉は2つ（Secret.js、tools/deploy.py が .local.json から書き出す）：
//   WEBAPP_TOKEN … ブラウザ用。読む・リンクの保存だけ
//   PUSH_TOKEN   … PCの見回り役だけが持つ。セッション一覧の書き込み用
//   KEIHI_TOKEN  … 経費の振り分け専用（Keihi.js）。読める範囲・できる操作を絞ってある
// 合言葉はURLに載せないため、問い合わせはすべて POST の本文で受ける。GET は生存確認だけ。

var VERSION = 26;
var PEST_LOG_NAME = '発生予察_新着ログ.md';
var LINKS_KEY = 'portal_links';
var SESSIONS_KEY = 'portal_sessions';        // 旧：1台分だけ（11/27まで）。今は portal_sessions_<PC名> に1台ずつ
var SESSIONS_PREFIX = 'portal_sessions_';
var SESSION_PC_TTL = 72 * 3600 * 1000;        // 72時間送ってこないPCの分は捨てる
var SESSION_HIDE_KEY = 'portal_session_hide';   // 「済みにする」を押した会話 {id: その時点の最後の会話の時刻}

function doGet(e) {
  return json_({ ok: true, version: VERSION });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'json' }); }
  var props = PropertiesService.getScriptProperties();

  if (body.type === 'pushSessions') {
    if (!same_(body.key, PUSH_TOKEN)) return json_({ ok: false, error: 'key' });
    var quota = {};
    ['vscode', 'desktop'].forEach(function (k) {   // 使用量（%）。新しく開く先を選ぶのに使う
      var q = (body.quota || {})[k];
      if (!q) return;
      quota[k] = { fh: Math.max(0, Math.min(100, Number(q.fh) || 0)), sd: Math.max(0, Math.min(100, Number(q.sd) || 0)),
        at: Number(q.at) || 0, fhReset: Number(q.fhReset) || 0, sdReset: Number(q.sdReset) || 0, sdResetEnd: Number(q.sdResetEnd) || 0, est: !!q.est };
    });
    var voice = {};   // まだ文字起こししていない音声の数 {日付: 件数}
    Object.keys(body.voice || {}).slice(0, 14).forEach(function (d) { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) voice[d] = Math.max(0, Math.floor(Number(body.voice[d]) || 0)); });
    var host = String(body.host || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 30) || 'unknown';
    var s = JSON.stringify({ voice: voice, at: new Date().toISOString(), host: host, sessions: (body.sessions || []).slice(0, 30), quota: quota });
    if (s.length > 8500) return json_({ ok: false, error: 'too_large' });
    props.setProperty(SESSIONS_PREFIX + host, s);   // PCごとに置く（2台から送っても上書きし合わない）
    props.deleteProperty(SESSIONS_KEY);
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
          return link_({ t: String(s.t || '').slice(0, 60), d: String(s.d || '').slice(0, 10) }, s);
        }),
        sources: (it.sources || []).slice(0, 12).map(function (x) { return String(x).slice(0, 60); }),
        tasks: (it.tasks || []).slice(0, 60).map(function (t) {
          var o = { t: String(t.t || '').slice(0, 40), s: ['済', '途中', '待ち', '未'].indexOf(t.s) >= 0 ? t.s : '未' };
          if (t.by === '人') o.by = '人';
          if (t.basis) o.basis = String(t.basis).slice(0, 80);
          if (t.hint) o.hint = String(t.hint).slice(0, 80);
          return link_(o, t);
        }),
        at: new Date().toISOString()
      };
      props.setProperty('wish_' + id, JSON.stringify(w));
      n++;
    });
    return json_({ ok: true, updated: n });
  }

  if (String(body.type || '').indexOf('keihi') === 0) return json_(keihiHandle_(body));
  if (String(body.type || '').indexOf('holdings') === 0) return json_(holdingsHandle_(body, props));

  if (!same_(body.key, WEBAPP_TOKEN)) return json_({ ok: false, error: 'key' });

  if (body.type === 'saveMoney') return json_(saveMoneySettings_(props, body));
  if (body.type === 'stockChart') return json_(chart_(String(body.code || ''), String(body.range || '')));   // 株価の欄のチャート（Holdings.js）

  if (body.type === 'get') {
    var out = { ok: true, version: VERSION };
    try { out.events = events_(); } catch (err) { out.eventsError = String(err); }
    try { out.pest = pest_(); } catch (err) { out.pestError = String(err); }
    var links = props.getProperty(LINKS_KEY);
    out.links = links ? JSON.parse(links) : null;
    out.sessions = sessions_(props);
    out.wishes = wishes_(props);
    out.memos = memos_(props).filter(function (m) { return !m.done; });
    out.diary = diary_(props);
    try { out.stocks = stocks_(); } catch (err) { out.stocksError = String(err).slice(0, 120); }
    return json_(out);
  }
  // 研修の作業記録メモ：1件ずつ memo_<日付>_<id>。同じ id で送れば上書き（送り直しても二重にならない）
  if (body.type === 'memoList') return json_({ ok: true, memos: memos_(props) });
  if (body.type === 'memoSave') {
    var mid = String(body.id || ''), mdate = String(body.date || ''), mt = String(body.text || '').trim().slice(0, 2500);
    if (!/^[0-9a-f]{8}$/.test(mid) || !/^\d{4}-\d{2}-\d{2}$/.test(mdate)) return json_({ ok: false, error: 'id' });
    if (!mt) return json_({ ok: false, error: 'text' });
    var ms = memos_(props), was = ms.filter(function (m) { return m.id === mid; })[0];
    if (!was && ms.length >= 300) return json_({ ok: false, error: 'too_many' });
    if (was && was.date !== mdate) props.deleteProperty('memo_' + was.date + '_' + mid);
    props.setProperty('memo_' + mdate + '_' + mid, JSON.stringify({ id: mid, date: mdate, t: mt, at: was ? was.at : new Date().toISOString() }));
    return json_({ ok: true, memos: memos_(props).filter(function (m) { return !m.done; }) });
  }
  // その日の作業記録を作った会話（あとから戻って直せるように）
  if (body.type === 'diarySave') {
    var dd = String(body.date || ''), cli = String(body.cli || ''), host = String(body.host || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dd) || !/^[0-9a-f-]{36}$/.test(cli) || (host && !/^local_[0-9a-f-]{36}$/.test(host))) return json_({ ok: false, error: 'id' });
    if (body.undo) { props.deleteProperty('diary_' + dd); return json_({ ok: true, diary: diary_(props) }); }
    props.setProperty('diary_' + dd, JSON.stringify({ date: dd, cli: cli, host: host, app: host ? 'デスクトップ' : 'VS Code', at: new Date().toISOString() }));
    return json_({ ok: true, diary: diary_(props) });
  }
  // 記録にした（done）・消す（delete）・未記録に戻す（open）
  if (body.type === 'memoMark') {
    var ids = (body.ids || []).map(String), nMark = 0;
    memos_(props).forEach(function (m) {
      if (ids.indexOf(m.id) < 0) return;
      var mk = 'memo_' + m.date + '_' + m.id;
      if (body.to === 'delete') props.deleteProperty(mk);
      else if (body.to === 'done') { m.done = new Date().toISOString(); props.setProperty(mk, JSON.stringify(m)); }
      else if (body.to === 'open') { delete m.done; props.setProperty(mk, JSON.stringify(m)); }
      else return;
      nMark++;
    });
    return json_({ ok: true, marked: nMark, memos: memos_(props).filter(function (m) { return !m.done; }) });
  }
  // セッションだけ（開いている間、1分おきに呼ばれる）
  if (body.type === 'sessions') return json_({ ok: true, sessions: sessions_(props) });
  // この会話は済み。新しいやり取りがあれば（at が進めば）また出る
  if (body.type === 'sessionHide') {
    var sid = String(body.id || ''), sat = Math.floor(Number(body.at) || 0);
    if (!/^[0-9a-f]{8}$/.test(sid)) return json_({ ok: false, error: 'id' });
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var hide = hidden_(props);
      if (body.undo) delete hide[sid]; else hide[sid] = sat;
      props.setProperty(SESSION_HIDE_KEY, JSON.stringify(hide));
    } finally { lock.releaseLock(); }
    return json_({ ok: true, sessions: sessions_(props) });
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

// 記録にしたメモは14日で捨てる（本文は作業記録のファイルに入っている）
function memos_(props) {
  var all = props.getProperties(), list = [], old = new Date(Date.now() - 14 * 86400000).toISOString();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('memo_') !== 0) return;
    var m = JSON.parse(all[k]);
    if (m.done && m.done < old) { props.deleteProperty(k); return; }
    list.push(m);
  });
  list.sort(function (a, b) { return a.date === b.date ? (a.at < b.at ? -1 : 1) : (a.date < b.date ? -1 : 1); });
  return list;
}

// 記録を作った会話は30日分
function diary_(props) {
  var all = props.getProperties(), list = [], old = new Date(Date.now() - 30 * 86400000).toISOString();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('diary_') !== 0) return;
    var d = JSON.parse(all[k]);
    if (d.at < old) { props.deleteProperty(k); return; }
    list.push(d);
  });
  return list.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
}

function hidden_(props) {
  var h = JSON.parse(props.getProperty(SESSION_HIDE_KEY) || '{}');
  var old = Date.now() / 1000 - 72 * 3600;   // 一覧は48時間分なので、古い印は捨てる
  Object.keys(h).forEach(function (k) { if (h[k] < old) delete h[k]; });
  return h;
}

// 全PCの分を合わせて返す。各セッションに host を付け、新しい順で20件まで
function sessions_(props) {
  var all = props.getProperties(), now = Date.now(), pcs = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(SESSIONS_PREFIX) !== 0 && k !== SESSIONS_KEY) return;
    var d;
    try { d = JSON.parse(all[k]); } catch (err) { return; }
    if (now - new Date(d.at).getTime() > SESSION_PC_TTL) { props.deleteProperty(k); return; }
    d.host = String(d.host || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 30) || 'unknown';
    pcs.push(d);
  });
  if (!pcs.length) return null;
  var h = hidden_(props), list = [], quota = {}, voice = {}, voiceAt = '', at = '';
  pcs.forEach(function (d) {
    (d.sessions || []).forEach(function (s) { s.host = d.host; if (h[s.id] >= s.at) s.hide = 1; list.push(s); });
    // 2台の使用量は新しい方。ただし公式の値（est=false）が15分以内にあれば、推定より公式を採る
    Object.keys(d.quota || {}).forEach(function (k) {
      var n = d.quota[k], o = quota[k];
      var good = function (x) { return x && !x.est && Date.now() / 1000 - x.at < 900; };
      if (!o || (good(n) && !good(o)) || (good(n) === good(o) && n.at > o.at)) quota[k] = n;
    });
    if (Object.keys(d.voice || {}).length && d.at > voiceAt) { voice = d.voice; voiceAt = d.at; }   // 音声の数は送ってきたPCの新しい方
    if (d.at > at) at = d.at;
  });
  list.sort(function (a, b) { return b.at - a.at; });
  return {
    at: at, voice: voice, quota: quota, sessions: list.slice(0, 20),
    hosts: pcs.map(function (d) { return { host: d.host, at: d.at }; }).sort(function (a, b) { return a.at < b.at ? 1 : -1; })
  };
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

// 続きを開くための情報（形を確かめたものだけ残す）
function link_(o, src) {
  var app = String(src.app || ''), open = String(src.open || ''), ref = String(src.ref || '');
  var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if ((app === 'VS Code' && uuid.test(open)) || (app === 'デスクトップ' && /^local_/.test(open) && uuid.test(open.slice(6)))) {
    o.app = app; o.open = open;
  }
  if (/^[0-9a-f]{8}$/.test(ref)) o.ref = ref;
  return o;
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
// 許可の画面がチェック式のとき、足りない項目があれば全部まとめて求める
function authorize() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  Logger.log(JSON.stringify({
    events: events_().length,
    pest: pest_() ? 'ok' : 'none',
    gmail: GmailApp.search('from:feedback@moneyforward.com', 0, 1).length,
    drive: DriveApp.getRootFolder().getName(),
    fetch: UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/7203.T?range=1d', { muteHttpExceptions: true }).getResponseCode()
  }));
}
