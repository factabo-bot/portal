'use strict';
// 自分用ポータル。localStorage のキーは他アプリと同じオリジンに同居するので必ず portal- で始める。

const LS = {
  cfg: 'portal-cfg',
  links: 'portal-links',
  remote: 'portal-remote',
  weather: 'portal-weather',
};
const LAT = 35.56, LON = 140.18; // 千葉市緑区あたり

const DEFAULT_LINKS = {
  sections: [
    { title: '自作アプリ', links: [
      { name: 'トマト栽培管理', url: 'https://factabo-bot.github.io/tomato-farm-manager/app/' },
      { name: "Eri's Routine", url: 'https://factabo-bot.github.io/routine-board/' },
      { name: 'ベランダ潅水', url: 'https://factabo-bot.github.io/kansui/' },
      { name: '研修先の作業記録', url: 'https://factabo-bot.github.io/farm-work-log/' },
    ]},
    { title: 'よく使うサイト', links: [
      { name: 'Gmail', url: 'https://mail.google.com/' },
      { name: 'カレンダー', url: 'https://calendar.google.com/' },
      { name: 'ドライブ', url: 'https://drive.google.com/' },
      { name: 'Claude', url: 'https://claude.ai/' },
      { name: 'マネーフォワード 予算', url: 'https://moneyforward.com/spending_summaries' },
      { name: '農薬登録情報', url: 'https://pesticide.maff.go.jp/' },
    ]},
  ],
};

const $ = (s) => document.querySelector(s);
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let cfg = load(LS.cfg, {});
let links = load(LS.links, null) || DEFAULT_LINKS;
let editing = null; // 編集中の下書き

// ---------- 設定用リンク（#setup=URL|合言葉）----------
(function readSetupHash() {
  const m = location.hash.match(/^#setup=(.+)$/);
  if (!m) return;
  const [url, key, keihi] = decodeURIComponent(m[1]).split('|');
  if (url && key) { cfg = { url, key, keihi: keihi || load(LS.cfg, {}).keihi || '' }; save(LS.cfg, cfg); }
  history.replaceState(null, '', location.pathname);
})();

// ---------- 日付 ----------
const WD = ['日', '月', '火', '水', '木', '金', '土'];
function renderDate() {
  const d = new Date();
  $('#date').textContent = `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;
}

// ---------- 天気（Open-Meteo）----------
const WMO = (c) => c === 0 ? '快晴' : c <= 2 ? '晴れ' : c === 3 ? 'くもり' : c <= 48 ? '霧' : c <= 57 ? '霧雨'
  : c <= 67 ? '雨' : c <= 77 ? '雪' : c <= 82 ? 'にわか雨' : c <= 86 ? 'にわか雪' : '雷雨';

async function loadWeather() {
  const cached = load(LS.weather, null);
  if (cached) renderWeather(cached);
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&current=temperature_2m,weather_code&timezone=Asia%2FTokyo&forecast_days=2';
  try {
    const r = await fetch(u);
    const j = await r.json();
    save(LS.weather, j);
    renderWeather(j);
  } catch {
    if (!cached) $('#weather').innerHTML = '<div class="muted">天気を取得できませんでした</div>';
  }
}
function renderWeather(j) {
  const d = j.daily;
  const day = (i, lbl) => `<div class="wday">
    <div class="lbl">${lbl}</div>
    <div class="sky">${WMO(d.weather_code[i])}</div>
    <div class="temp"><span class="hi">${Math.round(d.temperature_2m_max[i])}°</span> / <span class="lo">${Math.round(d.temperature_2m_min[i])}°</span></div>
    <div class="rain">降水 ${d.precipitation_probability_max[i] ?? '–'}%</div>
  </div>`;
  const now = j.current ? `<div class="wnow">いま ${Math.round(j.current.temperature_2m)}° ${WMO(j.current.weather_code)}（${j.current.time.slice(11, 16)}）</div>` : '';
  $('#weather').innerHTML = day(0, '今日') + day(1, '明日') + now;
}

// ---------- 窓口（GAS）----------
async function loadRemote() {
  const cached = load(LS.remote, null);
  if (cached) renderRemote(cached);
  if (!cfg.url) {
    $('#events').innerHTML = $('#pest').innerHTML = $('#sessions').innerHTML = $('#wishes').innerHTML =
      '<div class="muted">窓口が未設定です。<button class="btn small ghost" data-open-setup>設定する</button></div>';
    return;
  }
  setStatus('予定を読み込み中…');
  try {
    const j = await post({ type: 'get' });
    if (!j.ok) throw new Error(j.error || 'ng');
    save(LS.remote, j);
    if (j.links && !editing) {
      const localAt = links.savedAt || '';
      if (!localAt || (j.links.savedAt || '') >= localAt) { links = j.links; save(LS.links, links); renderLinks(); }
    }
    renderRemote(j);
    setStatus('');
  } catch (e) {
    setStatus(cached ? '前回の内容を表示中（読み込みに失敗）' : '読み込みに失敗しました');
    if (!cached) $('#events').innerHTML = $('#pest').innerHTML = $('#sessions').innerHTML = '<div class="muted">読み込めませんでした</div>';
  }
}

// 合言葉はURLに載せず、本文で送る（text/plain なので事前確認の通信が起きない）
async function post(body, key) {
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, key: key || cfg.key }),
    referrerPolicy: 'no-referrer',
  });
  return r.json();
}

function ymd(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function hm(d) { return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }

function renderRemote(j) {
  // 予定
  if (j.eventsError) $('#events').innerHTML = `<div class="muted">予定を読めませんでした：${esc(j.eventsError)}</div>`;
  else if (j.events) {
    const today = new Date(), tmr = new Date(Date.now() + 86400000);
    const groups = [[ymd(today), '今日'], [ymd(tmr), '明日']].map(([key, lbl]) => {
      const evs = j.events.filter((ev) => {
        const s = new Date(ev.start), e = new Date(ev.end);
        if (!ev.allDay) return ymd(s) === key;
        const k = new Date(key.replace(/-/g, '/'));
        return s <= k && k < e;
      });
      const rows = evs.length ? evs.map((ev) => `<div class="ev">
          <span class="t">${ev.allDay ? '終日' : hm(new Date(ev.start))}</span>
          <span class="dot" style="background:${esc(ev.color || '#999')}"></span>
          <span class="ttl">${esc(ev.title)}${ev.location ? ` <span class="loc">${esc(ev.location)}</span>` : ''}</span>
        </div>`).join('') : '<div class="muted">予定なし</div>';
      return `<div class="evday"><div class="evday-h">${lbl}</div>${rows}</div>`;
    });
    $('#events').innerHTML = groups.join('');
  }
  // セッション
  if ('sessions' in j) renderSessions(j.sessions);
  // やりたいこと
  if (Array.isArray(j.wishes)) { wishes = j.wishes; renderWishes(); }
  // 家計・株価
  if (j.stocks || j.stocksError) { stockList = (j.stocks && j.stocks.list) || stockList; renderStocks(j.stocks, j.stocksError); }
  // 予察
  if (j.pestError) $('#pest').innerHTML = `<div class="muted">予察ログを読めませんでした：${esc(j.pestError)}</div>`;
  else if (j.pest === null) $('#pest').innerHTML = '<div class="muted">予察ログが見つかりません</div>';
  else if (j.pest) {
    const p = j.pest;
    const rows = p.rows.slice(0, 8).map((r) => `<div class="prow${r.mark === '★' ? ' star' : ''}">
        <span class="m">${esc(r.mark)}</span><span class="what">${esc(r.pref)} ${esc(r.kind)}：${esc(r.pest)}</span>
        <div class="meta">${esc(r.crop)}・発表 ${esc(r.date)}</div></div>`).join('');
    $('#pest').innerHTML = `<div class="pest-h">${esc(p.heading)}</div>${rows || '<div class="muted">該当なし</div>'}`
      + (p.rows.length > 8 ? `<div class="muted">ほか${p.rows.length - 8}件</div>` : '');
  }
}

// Claude のセッション（PCの見回り役が送ったもの）
const ST = {
  ask: '質問あり',
  stuck: '止まっている',
  work: '作業中',
  done: '返事済み',
};
function ago(sec) {
  const m = Math.round((Date.now() / 1000 - sec) / 60);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}時間前` : `${Math.round(h / 24)}日前`;
}
// 飛び先。IDは形を確かめてから使う（窓口から来た値をそのままURLにしない）
const PHONE = matchMedia('(pointer: coarse)').matches;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RE_LOCAL = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RE_RC = /^[A-Za-z0-9]{10,40}$/;
function sessionLinks(s) {
  let app = '';
  if (s.app === 'VS Code' && RE_UUID.test(s.open || '')) app = `vscode://anthropic.claude-code/open?session=${s.open}`;
  if (s.app === 'デスクトップ' && RE_LOCAL.test(s.open || '')) app = `claude://code/continue?session=${s.open}`;
  const web = RE_RC.test(s.rc || '') ? `https://claude.ai/code/session_${s.rc}` : '';
  return { app, web };
}

function renderSessions(data) {
  const el = $('#sessions');
  if (!data) { el.innerHTML = '<div class="muted">まだ届いていません（PCの見回り役が未起動）</div>'; return; }
  const list = data.sessions || [];
  const row = (s) => {
    const { app: appUrl, web } = sessionLinks(s);
    const main = PHONE ? (web || appUrl) : (appUrl || web);
    const sub = !PHONE && appUrl && web ? `<a class="slink" href="${esc(web)}" target="_blank" rel="noopener noreferrer">ブラウザで</a>` : '';
    const body = `<div class="sline"><span class="badge">${ST[s.state] || ''}</span><span class="stitle">${esc(s.title)}</span></div>
      ${s.q ? `<div class="sq">${esc(s.q)}</div>` : ''}`;
    return `<div class="srow st-${esc(s.state)}">
      ${main ? `<a class="sbody" href="${esc(main)}"${main.startsWith('https:') ? ' target="_blank" rel="noopener noreferrer"' : ''}>${body}</a>` : body}
      <div class="meta">${s.acct ? esc(s.acct) + '・' : ''}${esc(s.app)}${s.folder ? '・' + esc(s.folder) : ''}・${ago(s.at)} ${sub}</div></div>`;
  };
  // 新しい順に1本で並べる。多いときは10件目以降を折りたたむ
  const sorted = [...list].sort((a, b) => b.at - a.at);
  const head = sorted.slice(0, 10), rest = sorted.slice(10);
  const at = new Date(data.at);
  const stale = Date.now() - at.getTime() > 90 * 60000;
  el.innerHTML = (head.length ? head.map(row).join('') : '<div class="muted">48時間以内のセッションはありません</div>')
    + (rest.length ? `<details class="sdone"><summary>ほか ${rest.length}件（48時間以内）</summary>${rest.map(row).join('')}</details>` : '')
    + `<div class="supd${stale ? ' stale' : ''}">PCから ${at.getMonth() + 1}/${at.getDate()} ${hm(at)} に更新${stale ? '（PCが止まっているかもしれません）' : ''}</div>`;
}

// ---------- やりたいこと ----------
let wishes = [];
let wishTab = 'open';
let wishDropping = null; // 「やめた」の理由を入力中のID
const md = (s) => { const m = String(s || '').match(/^\d{4}-(\d{2})-(\d{2})/); return m ? `${+m[1]}/${+m[2]}` : ''; };
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

// Claude による見立て（1日1回PCが更新）。段階は5つ
const STAGE_N = { '未着手': 0, '考え中': 1, '進んでいる': 2, 'ほぼできた': 3, 'かなったかも': 4 };
// 続きを開くリンク。VS Code は会話を開いて入力欄に一言入れる、デスクトップはその会話を開く
function continueUrl(x, prompt) {
  if (!x) return '';
  if (x.app === 'VS Code' && RE_UUID.test(x.open || '')) return `vscode://anthropic.claude-code/open?session=${x.open}&prompt=${encodeURIComponent(prompt)}`;
  if (x.app === 'デスクトップ' && RE_LOCAL.test(x.open || '')) return `claude://code/continue?session=${x.open}`;
  return '';
}
function companionUrl(w, task) {
  const prompt = `【やりたいこと伴走】「${w.text}」（やりたいことID ${w.id}・${md(w.at)}に思った）
`
    + (task ? `作業「${task}」を進めたい。関係する記憶と記録を確かめて、この作業の次の一歩を短く示してください。`
      : 'これをかなえるまで伴走してください。関係する記憶と記録を確かめて、今どこまで来ているか・かなえるまでの作業の分け方・次の一歩を短く示してください。');
  return `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`;
}
function wishLink(w) {   // やりたいこと全体：いちばん最近の関係セッションの続き、無ければ新しい伴走
  const ses = ((w.progress && w.progress.sessions) || []).filter((x) => continueUrl(x, '')).sort((a, b) => (a.d < b.d ? 1 : -1));
  return continueUrl(ses[0], `続き：やりたいこと「${w.text}」を進めよう`) || companionUrl(w);
}
function taskLink(w, t) {
  return continueUrl(t, `続き：やりたいこと「${w.text}」の作業「${t.t}」を進めよう`) || companionUrl(w, t.t);
}

function progressHtml(p, w) {
  if (!p || !(p.stage in STAGE_N)) return '';
  const n = STAGE_N[p.stage];
  const dots = [0, 1, 2, 3].map((i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  const ses = (p.sessions || []).length
    ? `<details class="wses"><summary>関係するセッション ${p.sessions.length}件</summary>${p.sessions.map((s) => `<div>${esc(s.t)} <span class="meta">${md(s.d)}</span></div>`).join('')}</details>` : '';
  const tasks = p.tasks || [];
  const doneN = tasks.filter((t) => t.s === '済').length;
  const MARK = { '済': '✓', '途中': '◐', '未': '○' };
  const trow = (t) => {
    const inner = `<span class="tm">${MARK[t.s] || '○'}</span>${esc(t.t)}${!PHONE && t.s !== '済' ? `<span class="tgo">${continueUrl(t, '') ? '続き' : '始める'}</span>` : ''}`;
    const cls = `wtask ts-${t.s === '済' ? 'done' : t.s === '途中' ? 'doing' : 'todo'}`;
    return !PHONE && w ? `<a class="${cls}" href="${esc(taskLink(w, t))}">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
  };
  // 作業の数に上限はない。多いとき（10個超）は済んだ分だけ折りたたむ
  const fold = tasks.length > 10 && doneN > 0;
  const tasksHtml = !tasks.length ? '' : fold
    ? `<details class="wses"><summary>済み ${doneN}件</summary><div class="wtasks">${tasks.filter((t) => t.s === '済').map(trow).join('')}</div></details>
       <div class="wtasks">${tasks.filter((t) => t.s !== '済').map(trow).join('')}</div>`
    : `<div class="wtasks">${tasks.map(trow).join('')}</div>`;
  return `<div class="wprog${n === 4 ? ' maybe' : ''}">
      <span class="wstage"><span class="wdots">${dots}</span>${esc(p.stage)}${tasks.length ? `<span class="meta">　${doneN}/${tasks.length}済み</span>` : ''}</span>
      ${p.line ? `<span class="wline">${esc(p.line)}</span>` : ''}
      ${tasksHtml}
      ${n === 4 ? '<span class="wask">かなっていたら「やった」を押してください</span>' : ''}
      ${ses}<div class="meta">Claudeの見立て・${md(p.at)}</div></div>`;
}

// VS Code の Claude を、このやりたいことの伴走として開く（頼みごとは入力欄に入った状態。送るのは本人）
function openCompanion(w) {
  if (!w || !/^[0-9a-f]{8}$/.test(w.id)) return;
  location.href = companionUrl(w);
}

function renderWishes() {
  const n = wishes.filter((w) => w.state === 'open').length;
  $('#wish-count').textContent = n ? `${n}件` : '';
  document.querySelectorAll('[data-wt]').forEach((b) => b.classList.toggle('on', b.dataset.wt === wishTab));
  const list = wishes.filter((w) => w.state === wishTab);
  if (!list.length) {
    $('#wishes').innerHTML = `<div class="muted">${wishTab === 'open' ? 'まだありません。思いついたら上に一言どうぞ' : 'まだありません'}</div>`;
    return;
  }
  $('#wishes').innerHTML = list.map((w) => {
    const id = esc(w.id);
    if (wishTab === 'open') {
      const drop = wishDropping === w.id ? `<div class="wdrop">
          <input data-note="${id}" maxlength="300" placeholder="やめた理由（なくてもよい）">
          <button class="btn small" data-wa="drop-ok" data-id="${id}">やめた</button>
          <button class="btn small ghost" data-wa="drop-cancel">戻る</button></div>` : '';
      const title = PHONE ? `<span class="wtext">${esc(w.text)}</span>` : `<a class="wtext wlink" href="${esc(wishLink(w))}" title="続きを開く">${esc(w.text)}</a>`;
      return `<div class="wrow"><div class="wmain">${title}
          <span class="wops">${PHONE ? '' : `<button class="btn small ghost" data-wa="buddy" data-id="${id}" title="VS CodeでClaudeと進める">伴走</button>`}<button class="btn small ghost" data-wa="done" data-id="${id}">やった</button>
          <button class="btn small ghost" data-wa="drop" data-id="${id}">やめた</button></span></div>
          <div class="meta">${md(w.at)}に思った</div>${progressHtml(w.progress, w)}${drop}</div>`;
    }
    return `<div class="wrow"><div class="wmain"><span class="wtext">${esc(w.text)}</span>
        <span class="wops"><button class="btn small ghost" data-wa="open" data-id="${id}">やりたいに戻す</button></span></div>
        <div class="meta">${md(w.at)}に思った → ${md(w.closedAt)}に${w.state === 'done' ? 'やった' : 'やめた'}</div>
        ${w.note ? `<div class="wnote">${esc(w.note)}</div>` : ''}</div>`;
  }).join('');
}

document.querySelector('.wtabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-wt]');
  if (!b) return;
  wishTab = b.dataset.wt; wishDropping = null; renderWishes();
});

$('#wish-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#wish-input').value.trim();
  if (!text) return;
  if (!cfg.url) { setStatus('窓口が未設定です'); return; }
  const tmp = { id: 'tmp' + Date.now(), text, at: today(), state: 'open' };
  wishes.unshift(tmp); wishTab = 'open'; renderWishes();
  $('#wish-input').value = '';
  try {
    const j = await post({ type: 'wishAdd', text, at: today() });
    if (!j.ok) throw new Error(j.error);
    wishes = wishes.map((w) => (w === tmp ? j.wish : w));
    setStatus('');
    if (!PHONE) openCompanion(j.wish);
  } catch {
    wishes = wishes.filter((w) => w !== tmp);
    $('#wish-input').value = text;
    setStatus('追加できませんでした。もう一度押してください');
  }
  renderWishes();
});

$('#wishes').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-wa]');
  if (!b) return;
  const act = b.dataset.wa, id = b.dataset.id;
  if (act === 'drop') { wishDropping = id; renderWishes(); document.querySelector(`[data-note="${id}"]`)?.focus(); return; }
  if (act === 'drop-cancel') { wishDropping = null; renderWishes(); return; }
  if (act === 'buddy') { const w0 = wishes.find((x) => x.id === id); if (w0) openCompanion(w0); return; }
  const state = act === 'drop-ok' ? 'drop' : act;
  const body = { type: 'wishUpdate', id, state };
  if (act === 'drop-ok') body.note = document.querySelector(`[data-note="${id}"]`)?.value || '';
  const w = wishes.find((x) => x.id === id);
  if (!w) return;
  const before = { ...w };
  Object.assign(w, { state, closedAt: state === 'open' ? '' : today() }, body.note !== undefined ? { note: body.note } : {});
  wishDropping = null; renderWishes();
  try {
    const j = await post(body);
    if (!j.ok) throw new Error(j.error);
    Object.assign(w, j.wish);
    setStatus(state === 'done' ? 'やった！に移しました' : state === 'drop' ? 'やめた、に移しました' : 'やりたい、に戻しました');
  } catch {
    Object.assign(w, before);
    setStatus('保存できませんでした。もう一度押してください');
  }
  renderWishes();
});

// ---------- 家計（マネーフォワードの週メールから） ----------
const yen = (n) => `${Math.round(n).toLocaleString('ja-JP')}円`;
let budgetShown = false;
function renderMf(mf, err) {
  if (budgetShown) return;
  const el = $('#mf');
  if (!el) return;   // 今月の支出の欄は 11/24 に廃止（手動のCSVは不要と本人）
  if (err) { el.innerHTML = `<div class="muted">読めませんでした（Gmailの許可が要るかもしれません）</div>`; return; }
  const now = new Date();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const pace = now.getDate() / dim;                 // 月のどこまで来たか
  const b = mf.budget || 0, e = mf.estimate || 0;
  const pct = b ? Math.min(100, (e / b) * 100) : 0;
  const over = b && e > b * pace;
  const bar = b ? `<div class="mbar"><div class="mfill${over ? ' over' : ''}" style="width:${pct.toFixed(1)}%"></div><div class="mpace" style="left:${(pace * 100).toFixed(1)}%" title="今日の位置"></div></div>` : '';
  el.innerHTML = `<div class="mrow"><span class="mbig">${yen(e)}</span>${b ? `<span class="muted">／ 予算 ${yen(b)}（${Math.round((e / b) * 100)}%）</span>` : ''}</div>
    ${bar}
    <div class="meta">${mf.through ? `${md(mf.through)}までの週メール ${mf.weeks.length}通分` : '今月の週メールはまだ届いていません'}。${b ? (over ? '月の進み具合より使っています' : '月の進み具合の内です') : ''}</div>
    <div class="mbud"><button type="button" class="btn small ghost" id="mf-budget">${b ? '予算を変える' : '予算を入れる'}</button>
    <span id="mf-budget-edit" hidden><input id="mf-budget-in" inputmode="numeric" value="${b || ''}" placeholder="例 250000"> <button type="button" class="btn small" id="mf-budget-save">保存</button></span></div>`;
}
document.addEventListener('click', async (e) => {
  if (e.target.id === 'mf-budget') { $('#mf-budget-edit').hidden = false; $('#mf-budget-in').focus(); }
  if (e.target.id === 'mf-budget-save') {
    const v = Number(String($('#mf-budget-in').value).replace(/[^\d]/g, ''));
    try { const j = await post({ type: 'saveMoney', budget: v }); if (!j.ok) throw 0; setStatus('予算を保存しました'); loadRemote(); }
    catch { setStatus('予算を保存できませんでした'); }
  }
});

// ---------- 株価 ----------
let stockList = [];
let stockEditing = false;
let lastStocks = null, lastStocksErr = null, lastHoldings = null;
function renderStocks(st, err) {
  const el = $('#stocks');
  if (!el) return;   // 株価の欄は 11/24 に保有資産へまとめて廃止
  if (st !== undefined) { lastStocks = st; lastStocksErr = err; }
  st = lastStocks; err = lastStocksErr;
  if (stockEditing) return renderStockEditor();
  // 保有資産がある端末では、持っている株を先に並べる（同じ銘柄は1行に）
  const held = [];
  if (lastHoldings) {
    const seen = new Set();
    lastHoldings.stocks.forEach((h) => {
      if (seen.has(h.code)) return; seen.add(h.code);
      const same = lastHoldings.stocks.filter((x) => x.code === h.code);
      const value = same.reduce((a, x) => a + x.value, 0), day = same.reduce((a, x) => a + x.day, 0);
      held.push({ code: h.code, name: h.name, price: h.price, cur: h.cur, pct: value - day ? (day / (value - day)) * 100 : 0 });
    });
  }
  const qs = ((st && st.quotes) || []).filter((q) => !held.some((h) => h.code.replace(/\s+/g, '-') === q.code || h.code + '.T' === q.code));
  if (!qs.length && !held.length) {
    el.innerHTML = err ? '<div class="muted">株価を読めませんでした</div>' : '<div class="muted">銘柄がまだありません。「銘柄」から足してください（例：7203、AAPL）</div>';
    return;
  }
  const fmtP = (n, cur) => n.toLocaleString('ja-JP', { maximumFractionDigits: cur === 'JPY' ? 1 : 2 });
  const heldHtml = held.map((h) => `<div class="qrow"><span class="qn">${esc(h.name)} <span class="meta">${esc(h.code)}・保有</span></span>
      <span class="qp">${fmtP(h.price, h.cur)}${h.cur === 'USD' ? ' ドル' : ''}</span><span class="qc ${h.pct > 0 ? 'up' : h.pct < 0 ? 'down' : ''}">${h.pct >= 0 ? '+' : ''}${h.pct.toFixed(2)}%</span></div>`).join('');
  let latest = lastHoldings && lastHoldings.quoteTime ? lastHoldings.quoteTime : 0;
  el.innerHTML = heldHtml + qs.map((q) => {
    if (q.error || q.price == null) return `<div class="qrow"><span class="qn">${esc(q.name)}</span><span class="muted">取得できず</span></div>`;
    latest = Math.max(latest, q.time || 0);
    const ch = q.prev ? q.price - q.prev : 0, pc = q.prev ? (ch / q.prev) * 100 : 0;
    const cls = ch > 0 ? 'up' : ch < 0 ? 'down' : '';
    const fmt = (n) => n.toLocaleString('ja-JP', { maximumFractionDigits: q.currency === 'JPY' ? 1 : 2 });
    return `<div class="qrow"><span class="qn">${esc(q.name)} <span class="meta">${esc(q.code)}</span></span>
      <span class="qp">${fmt(q.price)}</span><span class="qc ${cls}">${ch >= 0 ? '+' : ''}${fmt(ch)}（${pc >= 0 ? '+' : ''}${pc.toFixed(2)}%）</span></div>`;
  }).join('');
  $('#stocks-at').textContent = latest ? `${hm(new Date(latest * 1000))}時点` : '';
}
function renderStockEditor() {
  $('#stocks').innerHTML = stockList.map((s, i) => `<div class="edit-row">
      <input class="sk-code" data-i="${i}" value="${esc(s.code)}" placeholder="7203 や AAPL">
      <input class="sk-name" data-i="${i}" value="${esc(s.name)}" placeholder="名前">
      <span class="ops"><button class="btn small ghost" data-sk="del" data-i="${i}">×</button></span></div>`).join('')
    + `<div class="muted">日本株は4けたのコード（例 7203）、米国株は記号（例 AAPL・BRK B）。持っている株は保有資産から自動で出ます</div>
    <div class="edit-bar"><button class="btn small ghost" data-sk="add">＋ 銘柄</button>
    <button class="btn small ghost" data-sk="cancel">やめる</button><button class="btn small" data-sk="save">保存</button></div>`;
}
$('#stocks-edit')?.addEventListener('click', () => { stockEditing = !stockEditing; stockList = JSON.parse(JSON.stringify(stockList)); stockEditing ? renderStockEditor() : loadRemote(); });
$('#stocks')?.addEventListener('input', (e) => {
  const i = +e.target.dataset.i; if (Number.isNaN(i)) return;
  if (e.target.classList.contains('sk-code')) stockList[i].code = e.target.value.trim().toUpperCase();
  if (e.target.classList.contains('sk-name')) stockList[i].name = e.target.value.trim();
});
$('#stocks')?.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-sk]'); if (!b) return;
  const a = b.dataset.sk;
  if (a === 'add') { stockList.push({ code: '', name: '' }); renderStockEditor(); }
  if (a === 'del') { stockList.splice(+b.dataset.i, 1); renderStockEditor(); }
  if (a === 'cancel') { stockEditing = false; loadRemote(); }
  if (a === 'save') {
    const list = stockList.filter((s) => s.code);
    try {
      const j = await post({ type: 'saveMoney', stocks: list }); if (!j.ok) throw 0;
      stockEditing = false;
      setStatus(`銘柄を${j.saved}件保存しました${j.dropped && j.dropped.length ? `。読めなかったもの：${j.dropped.join('、')}` : ''}`);
      loadRemote();
    }
    catch { setStatus('銘柄を保存できませんでした'); }
  }
});

// ---------- 経費の振り分け（経費の合言葉がある端末だけ） ----------
let keihiItems = [];
const KIND = { biz: '事業', personal: '私用', none: '対象外' };
function renderKeihiCard() {
  const on = !!(cfg.url && cfg.keihi);
  $('#keihi-card').hidden = !on;
  $('#hold-card').hidden = !on;
  if (on) loadHoldings();
}

// ---------- 家計の分類別（マネーフォワードの CSV。お金の合言葉がある端末だけ） ----------
async function loadBudget() {
  try {
    const j = await post({ type: 'budgetGet' }, cfg.keihi);
    if (!j.ok || !j.budget) return;
    budgetShown = true;
    renderBudget(j.budget);
  } catch { /* 週メールの目安のまま */ }
}
function renderBudget(b) {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [y, m] = b.month.split('-').map(Number);
  const dim = new Date(y, m, 0).getDate();
  const dayOf = b.month === thisMonth ? Math.min(dim, Number((b.through || '').slice(8, 10)) || now.getDate()) : dim;
  const pace = dayOf / dim;
  const bar = (v, t) => {
    if (!t) return '';
    const pct = Math.min(100, (v / t) * 100), over = v > t * pace;
    return `<div class="mbar"><div class="mfill${over ? ' over' : ''}" style="width:${pct.toFixed(1)}%"></div>${pace < 1 ? `<div class="mpace" style="left:${(pace * 100).toFixed(1)}%"></div>` : ''}</div>`;
  };
  const own = b.cats.filter((c) => c.own), other = b.cats.filter((c) => !c.own && c.actual);
  const crow = (c) => `<div class="brow"><div class="r1"><span>${esc(c.name)}</span><span><b>${yen(c.actual)}</b> <span class="meta">／ 目標 ${yen(c.own)}${c.mf ? `・MF予算 ${yen(c.mf)}` : ''}</span></span></div>${bar(c.actual, c.own)}</div>`;
  const stale = b.month !== thisMonth;
  $('#mf').innerHTML = `${stale ? `<div class="bwarn">今月のCSVはまだありません。表示は${m}月分です（マネーフォワードで今月の「収入・支出詳細」を落として 00_Inbox へ）</div>` : ''}
    <div class="mrow"><span class="mbig">${yen(b.living)}</span><span class="muted">純生活費 ／ 目標 ${yen(b.livingTarget)}（${Math.round((b.living / b.livingTarget) * 100)}%）</span></div>
    ${bar(b.living, b.livingTarget)}
    <div class="meta">${m}月・${md(b.through)}までの明細。目標は「18_生活費_月額予算目標」、縦線は月の進み具合</div>
    <div class="blist">${own.map(crow).join('')}</div>
    ${other.length ? `<details class="hgrp"><summary><span>目標のない分類</span><span>${yen(other.reduce((a, c) => a + c.actual, 0))}</span></summary>${other.map((c) => `<div class="brow"><div class="r1"><span>${esc(c.name)}</span><span>${yen(c.actual)}${c.mf ? ` <span class="meta">MF予算 ${yen(c.mf)}</span>` : ''}</span></div></div>`).join('')}</details>` : ''}`;
  document.querySelector('#mf').closest('.card').querySelector('h2 .sub').textContent = 'マネーフォワードのCSVから・分類別';
}

// ---------- 保有資産（お金の合言葉がある端末だけ） ----------
const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('ja-JP');
const pnlCls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
async function loadHoldings() {
  try {
    const j = await post({ type: 'holdingsGet' }, cfg.keihi);
    if (!j.ok) throw new Error(j.error);
    renderHoldings(j.holdings);
  } catch (e) {
    $('#hold').innerHTML = `<div class="muted">読めませんでした${e.message === 'key' ? '（お金の合言葉が違います）' : ''}</div>`;
  }
}
function renderHoldings(h) {
  lastHoldings = h || null;
  renderStocks();
  if (!h) { $('#hold').innerHTML = '<div class="muted">まだありません。「貼り付けて更新」から保有一覧を貼ってください</div>'; return; }
  $('#hold-at').textContent = `株は${h.quoteTime ? hm(new Date(h.quoteTime * 1000)) : '—'}時点・投信は${md(h.at)}時点`;
  const total = h.stockTotal + h.fundTotal, pnl = h.stockPnl + h.fundPnl;
  const jp = h.stocks.filter((s) => s.cur === 'JPY'), us = h.stocks.filter((s) => s.cur !== 'JPY');
  const fmtP = (n, cur) => (n == null ? '—' : n.toLocaleString('ja-JP', { maximumFractionDigits: cur === 'JPY' ? 1 : 2 }) + (cur === 'USD' ? 'ドル' : '円'));
  const dpct = (s) => (s.value - s.day ? (s.day / (s.value - s.day)) * 100 : 0);
  const srow = (s) => `<div class="hrow2"><div class="r1"><span class="hn">${esc(s.name)} <span class="meta">${esc(s.code)}・${esc(s.inst)}</span></span><span class="hv">${yen(s.value)}</span></div>
      <div class="r2"><span>${fmtP(s.price, s.cur)} <span class="${pnlCls(s.day)}">${dpct(s) >= 0 ? '+' : ''}${dpct(s).toFixed(2)}%</span></span>
      <span>前日比 <span class="${pnlCls(s.day)}">${sign(s.day)}円</span></span>
      <span>損益 <span class="${pnlCls(s.pnl)}">${sign(s.pnl)}円（${s.pnlPct >= 0 ? '+' : ''}${s.pnlPct.toFixed(1)}%）</span></span></div></div>`;
  const frow = (f) => `<div class="hrow2"><div class="r1"><span class="hn">${esc(f.name)} <span class="meta">${esc(f.inst)}</span></span><span class="hv">${yen(f.value)}</span></div>
      <div class="r2"><span>損益 <span class="${pnlCls(f.pnl)}">${sign(f.pnl)}円（${f.pnlPct >= 0 ? '+' : ''}${f.pnlPct.toFixed(1)}%）</span></span></div></div>`;
  const sum = (a, k) => a.reduce((x, y) => x + y[k], 0);
  const grp = (title, list, row, extra, open, stock) => list.length ? `<details class="hgrp"${open ? ' open' : ''}><summary><span>${title}</span><span>${yen(sum(list, 'value'))}</span>${extra || ''}</summary>
      ${list.map(row).join('')}</details>` : '';
  const tile = (label, v, p, extra) => `<div class="htile"><div class="meta">${label}</div><div class="hbig">${yen(v)}</div>
      <div class="${pnlCls(p)}">評価損益 ${sign(p)}円</div>${extra || ''}</div>`;
  $('#hold').innerHTML = `<div class="mrow"><span class="mbig">${yen(total)}</span>
      <span class="${pnlCls(pnl)}">評価損益 ${sign(pnl)}円</span></div>
    <div class="htiles">${tile('個別株（日本株＋米国株）', h.stockTotal, h.stockPnl, `<div class="meta ${pnlCls(h.stockDay)}">前日比 ${sign(h.stockDay)}円</div>`)}
      ${tile(`投資信託（${md(h.at)}時点）`, h.fundTotal, h.fundPnl)}</div>
    ${grp('日本株', jp, srow, '', true, true)}${grp('米国株', us, srow, `<span class="meta">1ドル${h.fx ? h.fx.toFixed(2) : '—'}円</span>`, true, true)}${grp('投資信託', h.funds, frow)}
    <div class="meta">投資信託の基準価額は貼り付けた日のまま。売買したら貼り直してください</div>`;
}
$('#hold-paste').addEventListener('click', () => { $('#hold-import').hidden = !$('#hold-import').hidden; $('#hold-text').focus(); });
$('#hold-cancel').addEventListener('click', () => { $('#hold-import').hidden = true; $('#hold-text').value = ''; });
$('#hold-go').addEventListener('click', async () => {
  const text = $('#hold-text').value;
  if (!text.trim()) return;
  setStatus('取り込み中…');
  try {
    const j = await post({ type: 'holdingsImport', text }, cfg.keihi);
    if (!j.ok) throw new Error(j.error);
    $('#hold-text').value = ''; $('#hold-import').hidden = true;
    setStatus(`取り込みました（株${j.stocks}件・投信${j.funds}件）`);
    loadHoldings();
  } catch (e) {
    setStatus(e.message === 'parse' ? '表を読み取れませんでした。見出し（株式(現物)・投資信託）ごと貼ってください' : '取り込めませんでした');
  }
});
$('#keihi-load').addEventListener('click', loadKeihi);
async function loadKeihi() {
  $('#keihi').innerHTML = '<div class="muted">読み込み中…（数十秒かかることがあります）</div>';
  try {
    const j = await post({ type: 'keihiList' }, cfg.keihi);
    if (!j.ok) throw new Error(j.error);
    keihiItems = j.items;
    renderKeihi();
  } catch (e) {
    $('#keihi').innerHTML = `<div class="muted">読み込めませんでした${e.message === 'key' ? '（経費の合言葉が違います）' : ''}</div>`;
  }
}
function renderKeihi() {
  $('#keihi-count').textContent = keihiItems.length ? `未仕分け ${keihiItems.length}件` : '';
  if (!keihiItems.length) { $('#keihi').innerHTML = '<div class="muted">未仕分けはありません</div>'; return; }
  $('#keihi').innerHTML = keihiItems.map((k) => `<div class="krow" data-kid="${esc(k.id)}">
      <div class="kmain"><span class="kshop">${esc(k.shop)}</span><span class="kamt">${k.amount ? yen(Number(k.amount)) : '金額不明'}</span></div>
      <div class="kitem">${esc(k.item)}${k.more ? ` ほか${k.more}点` : ''}</div>
      <div class="kops"><span class="meta">${md(k.date)}</span>
        <button class="btn small" data-kk="biz">事業</button><button class="btn small ghost" data-kk="personal">私用</button><button class="btn small ghost" data-kk="none">対象外</button></div></div>`).join('')
    + '<div class="meta">取り消しは元の仕訳アプリで（ポータルからはできません）</div>';
}
$('#keihi').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-kk]'); if (!b) return;
  const row = b.closest('[data-kid]'); const id = row.dataset.kid; const kind = b.dataset.kk;
  row.querySelectorAll('button').forEach((x) => { x.disabled = true; });
  row.classList.add('busy');
  try {
    const j = await post({ type: 'keihiClassify', id, kind }, cfg.keihi);
    if (!j.ok) throw new Error(j.error);
    keihiItems = keihiItems.filter((k) => k.id !== id);
    setStatus(`${KIND[kind]}に分けました${kind === 'biz' ? '（領収書をドライブに保存）' : ''}`);
    renderKeihi();
  } catch (err) {
    row.classList.remove('busy');
    row.querySelectorAll('button').forEach((x) => { x.disabled = false; });
    setStatus(err.message === 'rate' ? '1時間の上限（60件）に達しました' : err.message === 'not_pending' ? '一覧が古いので読み込み直してください' : '振り分けできませんでした');
  }
});

function setStatus(t) { $('#status').textContent = t; }

// ---------- リンク ----------
const COLORS = ['#b5462f', '#3c7a5a', '#2e6fb5', '#8a5a9e', '#c07a1f', '#4b6b7a', '#9e4a6e'];
function colorOf(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
function iconHtml(l) {
  let host = '';
  try { host = new URL(l.url).hostname; } catch {}
  const letter = esc((l.name || '?').trim().charAt(0));
  if (host && !host.endsWith('github.io')) {
    return `<span class="ic" style="background:var(--card)"><img src="https://www.google.com/s2/favicons?domain=${esc(host)}&sz=64" alt="" loading="lazy" referrerpolicy="no-referrer" data-fb="${letter}" data-bg="${colorOf(l.name)}"></span>`;
  }
  return `<span class="ic" style="background:${colorOf(l.name)}">${letter}</span>`;
}

function renderLinks() {
  const root = $('#links');
  if (editing) { renderEditor(); return; }
  root.innerHTML = links.sections.map((s) => `<div class="card sec">
      <h2>${esc(s.title)}</h2>
      <div class="tiles">${s.links.map((l) => `<a class="tile" href="${esc(l.url)}">${iconHtml(l)}<span class="nm">${esc(l.name)}</span></a>`).join('')}</div>
    </div>`).join('');
  root.querySelectorAll('img[data-fb]').forEach((img) => img.addEventListener('error', () => {
    img.parentNode.style.background = img.dataset.bg;
    img.replaceWith(img.dataset.fb);
  }, { once: true }));
}

function renderEditor() {
  const root = $('#links');
  root.innerHTML = editing.sections.map((s, si) => `<div class="card sec">
      <h2><input class="sec-title-input" data-si="${si}" value="${esc(s.title)}">
        <button class="btn small ghost" data-act="sec-up" data-si="${si}" title="上へ">↑</button>
        <button class="btn small ghost" data-act="sec-del" data-si="${si}">枠を削除</button></h2>
      ${s.links.map((l, li) => `<div class="edit-row">
          <input class="name" data-si="${si}" data-li="${li}" value="${esc(l.name)}" placeholder="名前">
          <input class="url" data-si="${si}" data-li="${li}" value="${esc(l.url)}" placeholder="https://">
          <span class="ops">
            <button class="btn small ghost" data-act="up" data-si="${si}" data-li="${li}" title="上へ">↑</button>
            <button class="btn small ghost" data-act="down" data-si="${si}" data-li="${li}" title="下へ">↓</button>
            <button class="btn small ghost" data-act="del" data-si="${si}" data-li="${li}" title="削除">×</button>
          </span></div>`).join('')}
      <button class="btn small ghost" data-act="add" data-si="${si}">＋ リンクを追加</button>
    </div>`).join('') + `<div class="edit-bar">
      <button class="btn ghost" data-act="sec-add">＋ 枠を追加</button>
      <button class="btn ghost" data-open-setup>窓口の設定</button>
      <button class="btn ghost" data-act="cancel">やめる</button>
      <button class="btn" data-act="save">保存</button></div>`;
}

$('#links').addEventListener('input', (e) => {
  const t = e.target, si = +t.dataset.si, li = +t.dataset.li;
  if (!editing || Number.isNaN(si)) return;
  if (t.classList.contains('sec-title-input')) editing.sections[si].title = t.value;
  else if (t.classList.contains('name')) editing.sections[si].links[li].name = t.value;
  else if (t.classList.contains('url')) editing.sections[si].links[li].url = t.value.trim();
});

$('#links').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !editing) return;
  const si = +b.dataset.si, li = +b.dataset.li, S = editing.sections;
  const swap = (a, i, j) => { if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; };
  switch (b.dataset.act) {
    case 'up': swap(S[si].links, li, li - 1); break;
    case 'down': swap(S[si].links, li, li + 1); break;
    case 'del': S[si].links.splice(li, 1); break;
    case 'add': S[si].links.push({ name: '', url: '' }); break;
    case 'sec-up': swap(S, si, si - 1); break;
    case 'sec-del': if (b.dataset.armed) S.splice(si, 1); else { b.dataset.armed = '1'; b.textContent = 'もう一度押すと削除'; return; } break;
    case 'sec-add': S.push({ title: '新しい枠', links: [] }); break;
    case 'cancel': editing = null; $('#edit').textContent = '編集'; break;
    case 'save': await saveLinks(); return;
  }
  renderLinks();
});

async function saveLinks() {
  editing.sections.forEach((s) => { s.links = s.links.filter((l) => l.name.trim() && l.url.trim()); });
  editing.savedAt = new Date().toISOString();
  links = editing; editing = null;
  save(LS.links, links);
  $('#edit').textContent = '編集';
  renderLinks();
  if (!cfg.url) { setStatus('この端末にだけ保存しました（窓口が未設定）'); return; }
  setStatus('保存中…');
  try {
    const j = await post({ type: 'saveLinks', links });
    if (!j.ok) throw new Error(j.error);
    links.savedAt = j.savedAt; save(LS.links, links);
    setStatus('保存しました（ほかの端末にも反映されます）');
  } catch {
    setStatus('この端末には保存しました。窓口への保存は失敗したので、あとで編集→保存をやり直してください');
  }
}

$('#edit').addEventListener('click', () => {
  if (editing) { editing = null; $('#edit').textContent = '編集'; }
  else { editing = JSON.parse(JSON.stringify(links)); $('#edit').textContent = '編集をやめる'; }
  renderLinks();
});

// ---------- 窓口の設定ダイアログ ----------
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-open-setup]')) return;
  $('#setup-url').value = cfg.url || '';
  $('#setup-key').value = cfg.key || '';
  $('#setup-keihi').value = cfg.keihi || '';
  $('#qr-keihi').checked = false;
  $('#setup').showModal();
});
// スマホへ設定を渡すQR（読み取り用の合言葉入り。押したときだけ作り、閉じたら消す）
const QR_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const QR_SRI = 'sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1';
function loadQrLib() {
  if (window.qrcode) return Promise.resolve();
  return new Promise((ok, ng) => {
    const s = document.createElement('script');
    s.src = QR_SRC; s.integrity = QR_SRI; s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer';
    s.onload = ok; s.onerror = ng;
    document.head.appendChild(s);
  });
}
$('#qr-btn').addEventListener('click', async () => {
  const box = $('#qr');
  if (!box.hidden) { box.hidden = true; box.innerHTML = ''; return; }
  const url = $('#setup-url').value.trim(), key = $('#setup-key').value.trim();
  if (!url || !key) { box.hidden = false; box.textContent = '先にURLと合言葉を入れてください'; return; }
  try { await loadQrLib(); } catch { box.hidden = false; box.textContent = 'QRの部品を読み込めませんでした'; return; }
  const kk = $('#qr-keihi').checked ? $('#setup-keihi').value.trim() : '';
  const link = `${location.origin}${location.pathname}#setup=${encodeURIComponent(url + '|' + key + (kk ? '|' + kk : ''))}`;
  const q = window.qrcode(0, 'M'); q.addData(link); q.make();
  box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
    + '<div class="muted">スマホのカメラで読み取ってください。人に見せないでください。</div>';
  box.hidden = false;
});
$('#setup').addEventListener('close', () => { $('#qr').hidden = true; $('#qr').innerHTML = ''; });

$('#setup-form').addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'save') {
    cfg = { url: $('#setup-url').value.trim(), key: $('#setup-key').value.trim(), keihi: $('#setup-keihi').value.trim() };
    renderKeihiCard();
    save(LS.cfg, cfg);
    loadRemote();
  }
});

$('#reload').addEventListener('click', () => { renderDate(); loadWeather(); loadRemote(); });

// ---------- インストール（同じオリジンの他アプリがあるので、メニューでなくこのボタンから入れる）----------
let deferredPrompt = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!standalone) $('#install').hidden = false;
});
$('#install').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('#install').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#install').hidden = true; });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- 起動 ----------
renderDate();
renderLinks();
renderKeihiCard();
loadWeather();
loadRemote();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  renderDate();
  const w = load(LS.weather, null);
  if (!w || Date.now() - new Date(w.current?.time || 0).getTime() > 30 * 60000) loadWeather();
  loadRemote();
});
