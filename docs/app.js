'use strict';
// 自分用ポータル。localStorage のキーは他アプリと同じオリジンに同居するので必ず portal- で始める。

const LS = {
  cfg: 'portal-cfg',
  links: 'portal-links',
  remote: 'portal-remote',
  weather: 'portal-weather',
};
const LAT = 35.56, LON = 140.18; // 千葉市緑区あたり

// 使っていない試作アプリ（farm-work-log）の説明ページに飛んでいたので、このページの作業記録の欄へ向ける（本人 11/25）
const MEMO_URL = 'https://factabo-bot.github.io/portal/#memo-card';
const fixLinks = (x) => { for (const g of x.sections) for (const l of g.links) if (/^https:\/\/factabo-bot\.github\.io\/farm-work-log\/?$/.test(l.url)) { l.url = MEMO_URL; l.name = '研修の作業記録'; } return x; };
const DEFAULT_LINKS = {
  sections: [
    { title: '自作アプリ', links: [
      { name: 'トマト栽培管理', url: 'https://factabo-bot.github.io/tomato-farm-manager/app/' },
      { name: "Eri's Routine", url: 'https://factabo-bot.github.io/routine-board/' },
      { name: 'ベランダ潅水', url: 'https://factabo-bot.github.io/kansui/' },
      { name: '研修の作業記録', url: MEMO_URL },
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
let links = fixLinks(load(LS.links, null) || DEFAULT_LINKS);
let editing = null; // 編集中の下書き

// ---------- 設定用リンク（#setup=URL|合言葉）----------
(function readSetupHash() {
  const m = location.hash.match(/^#setup=(.+)$/);
  if (!m) return;
  const [url, key, keihi] = decodeURIComponent(m[1]).split('|');
  if (url && key) { const old = load(LS.cfg, {}); cfg = { url, key, keihi: keihi || old.keihi || '', pc: old.pc || '' }; save(LS.cfg, cfg); }
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
    sesAt = Date.now();
    const j = await post({ type: 'get' });
    if (!j.ok) throw new Error(j.error || 'ng');
    save(LS.remote, j);
    if (j.links && !editing) {
      const localAt = links.savedAt || '';
      if (!localAt || (j.links.savedAt || '') >= localAt) { links = fixLinks(j.links); save(LS.links, links); renderLinks(); }
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
  // セッション（と、新しく開く先を決める使用量）
  if ('sessions' in j) { lastQuota = (j.sessions && j.sessions.quota) || null; renderSessions(j.sessions); }
  // 研修の作業記録メモ
  if (Array.isArray(j.diary)) diary = j.diary;
  if (Array.isArray(j.memos)) { memos = j.memos; renderMemos(); }
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
// 見回り役を置いたPC（PC名 → 画面での呼び名）。家のPC以外のセッションには呼び名を小さく出す
const HOME_PC = 'Ben';
const PC_NAMES = { Ben: '家のPC', 'DESKTOP-MUU2JN2': 'ノートPC' };
const pcName = (h) => PC_NAMES[h] || h || '';
// この端末がどのPCか（窓口の設定で端末ごとに保存。スマホ・未設定は家のPCとみなす）
const myPc = () => (PHONE ? '' : cfg.pc || HOME_PC);
// ほかのPCの会話か
const elsewhere = (s) => !PHONE && !!s.host && s.host !== myPc();
// ほかのPCの会話で、このPCでは開けないもの。sy＝2台で記録を写し合っている会話（見回り役の session_sync.py）は開ける。
// ただし向こうで作業中のあいだは、両方で書くと枝分かれするので開かない
const otherPc = (s) => elsewhere(s) && (!s.sy || s.state === 'work');
function sessionLinks(s) {
  let app = '';
  if (s.app === 'VS Code' && RE_UUID.test(s.open || '')) app = `vscode://anthropic.claude-code/open?session=${s.open}`;
  if (s.app === 'デスクトップ' && RE_LOCAL.test(s.open || '')) app = `claude://code/continue?session=${s.open}`;
  // ほかのPCのデスクトップの会話：アプリ内のIDはPCごとなので、写した記録を取り込んで開く
  if (s.app === 'デスクトップ' && elsewhere(s)) app = RE_UUID.test(s.cli || '') ? `claude://resume?session=${s.cli}` : '';
  const web = RE_RC.test(s.rc || '') ? `https://claude.ai/code/session_${s.rc}` : '';
  return { app, web };
}

// もう片方のアプリで開く（会話の記録は同じファイルなので、続きからそのまま話せる）。作業中は両方で書き合うので出さない
function switchTo(s) {
  if (PHONE || s.state === 'work' || otherPc(s)) return null;
  if (s.app === 'VS Code' && RE_UUID.test(s.open || '')) return { app: 'デスクトップ', url: `claude://resume?session=${s.open}` };
  if (s.app === 'デスクトップ' && RE_UUID.test(s.cli || '')) return { app: 'VS Code', url: `vscode://anthropic.claude-code/open?session=${s.cli}` };
  return null;
}
function switchHtml(s) {
  const sw = switchTo(s);
  if (!sw) return '';
  const to = acctName(Object.keys(ACCT_APP).find((k) => ACCT_APP[k] === sw.app) || '') || sw.app;
  return sw ? `<a class="slink sicon" href="${esc(sw.url)}" title="${esc(`${to}（${sw.app}）に切り替えて続きを開く。${quotaText(sw.app)}。開いたら、元のアプリの方では送らない`)}">${IC.swap}${esc(to)}へ${quotaTight(sw.app) ? '（枠わずか）' : ''}</a>` : '';
}

// スマホ：Claudeアプリは1つのアカウントでしか開けない（別のアカウントの会話は「利用できません」になる。11/25 実機）。
// アプリと同じアカウントの会話はアプリで、違う会話は Chrome（そのアカウントで claude.ai にログインしておく）で開く
const ACCT_KEY = 'portal-phone-acct';
let phoneAcct = load(ACCT_KEY, 'アカウントA');
function phoneLink(rc, acct) {
  if (!RE_RC.test(rc || '')) return null;
  if (!acct || acct === phoneAcct) return { url: `https://claude.ai/code/session_${rc}`, attr: ' target="_blank" rel="noopener noreferrer"', via: '' };
  return { url: `intent://claude.ai/code/session_${rc}#Intent;scheme=https;package=com.android.chrome;end`, attr: '', via: 'Chromeで開く' };
}

// 会話そのものを開けないとき：新しい会話に前の会話を読ませて続ける（PCの handoff.py が要約と最後のやり取りを出す）
function handoffPrompt(id, title) {
  return `前の会話「${title}」の続きをしたい。まず python C:/Users/facta/projects/portal/watcher/handoff.py ${id} を実行して前の会話の要約と最後のやり取りを読み、関係する記憶も確かめて、どこまで来ているかと次の一歩を短く示してください。`;
}
function copyAndOpenClaude(text) {
  navigator.clipboard.writeText(text).then(() => { setStatus('文をコピーしました。「obsidian」を選び、貼って送ってください'); location.href = 'https://claude.ai/code'; }, () => setStatus('コピーできませんでした'));
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-hand]');
  if (b) copyAndOpenClaude(handoffPrompt(b.dataset.hand, b.dataset.title));
});

// アカウントの呼び名（窓口のデータは「アカウントA/B」のまま。画面だけ main/sub と出す）
const ACCT_NAME = { アカウントA: 'main', アカウントB: 'sub' };
const acctName = (a) => ACCT_NAME[a] || a || '';
const acctCls = (a) => (ACCT_NAME[a] ? 'a-' + ACCT_NAME[a] : '');   // main・sub の色分け
// 今のログイン：main＝VS Code（CLI）、sub＝デスクトップ。行のアプリがこれと違うときだけアプリ名を出す
const ACCT_APP = { アカウントA: 'VS Code', アカウントB: 'デスクトップ' };
const svg = (d) => `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
  folder: svg('<path d="M1.5 4.5v8h13v-6.5h-6.5l-1.5-1.5z"/>'),
  pc: svg('<rect x="3" y="3.5" width="10" height="7"/><path d="M1.5 12.5h13"/>'),
  code: svg('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
  app: svg('<rect x="2" y="2.5" width="12" height="11"/><path d="M2 5.5h12"/>'),
  web: svg('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>'),
  swap: svg('<path d="M2.5 5.5h10l-2.5-2.5M13.5 10.5h-10l2.5 2.5"/>'),
};
// main・sub の使用量（5時間枠・7日枠）。main＝VS Code（CLIのログイン・公式の値）、sub＝デスクトップ（推定）
function usageHtml() {
  const WD = '日月火水木金土';
  const t = (sec) => { const d = new Date(Math.round(sec / 60) * 60000); return d; };
  const day = (d) => `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  const one = (acct, key) => {
    const q = lastQuota && lastQuota[key];
    const name = `<span class="stag ${acctCls(acct)}">${acctName(acct)}</span>`;
    if (!q) return `${name}<span class="unone muted">使用量は不明</span>`;
    const est = q.est ? '（推定）' : '';
    const live = (x) => x && x * 1000 > Date.now();
    // 日付と時刻は別の幅で右にそろえる（11/29(日) 17:00 と 12/3(木) 5:00 の位置がずれないように）
    const dt = (d, tm) => `<span class="ud">${d}</span><span class="ut">${tm}</span>`;
    const fhR = live(q.fhReset) ? dt('', hm(t(q.fhReset))) + (q.est ? 'ごろ' : '') : '';
    let sdR = '';
    if (live(q.sdReset) || live(q.sdResetEnd)) {
      const a = t(q.sdReset), b = q.sdResetEnd ? t(q.sdResetEnd) : null;
      sdR = !b ? dt(day(a), hm(a))
        : a.toDateString() === b.toDateString() ? `${day(a)} ${a.getHours()}〜${b.getHours() + (b.getMinutes() ? 1 : 0)}時ごろ`
        : `${day(a)} ${hm(a)}〜${day(b)} ${hm(b)}`;
    }
    const bar = (v, lab, reset, cls) => `<span class="ubar ${cls}" title="${lab}の枠 ${+v || 0}%${reset ? '・' + reset.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() + 'に戻る' : ''}${est}"><span class="ulab">${lab}</span><span class="utrack"><span class="ufill ${acctCls(acct)}" style="width:${Math.min(100, Math.max(0, +v || 0))}%"></span></span><span class="upct${v >= 80 ? ' hot' : ''}">${+v || 0}%</span><span class="ureset">${reset}</span></span>`;
    return name + bar(q.fh, '5時間', fhR, 'w5') + bar(q.sd, '7日', sdR, 'w7');
  };
  return `<div class="usage">${one('アカウントA', 'vscode')}${one('アカウントB', 'desktop')}</div>`;
}

function renderSessions(data) {
  const el = $('#sessions');
  if (!data) { el.innerHTML = '<div class="muted">まだ届いていません（PCの見回り役が未起動）</div>'; return; }
  // 2台で写し合う会話は、両方のPCから届くことがある（取り込んだ直後など）。新しい方だけ残す
  const byId = {};
  for (const x of data.sessions || []) if (!byId[x.id] || x.at > byId[x.id].at) byId[x.id] = x;
  const list = Object.values(byId);
  const waiting = (x) => (x.state === 'ask' || x.state === 'stuck') && !x.hide;
  const row = (s) => {
    const { app: appUrl0, web } = sessionLinks(s);
    const away = otherPc(s);
    const appUrl = away ? '' : appUrl0;   // ほかのPCの会話は、このPCのアプリでは開けない
    const ph = PHONE ? phoneLink(s.rc, s.acct) : null;
    const main = PHONE ? (ph ? ph.url : '') : (appUrl || web);
    const sub = PHONE ? (ph ? (ph.via ? `<span>${esc(ph.via)}</span>` : '') : '') : appUrl && web ? `<a class="slink sicon" href="${esc(web)}" target="_blank" rel="noopener noreferrer" title="ブラウザで開く" aria-label="ブラウザで開く">${IC.web}</a>` : '';
    // スマホで会話を開けない・別アカウントのときは、新しい会話で続ける（作業中は同じ物を2つで触らないよう出さない）
    const hand = PHONE && s.state !== 'work' && (!ph || ph.via) && (!s.host || s.host === HOME_PC) ? `<button type="button" class="btn small ghost shide" data-hand="${esc(s.id)}" data-title="${esc(s.title)}">新しい会話で続ける</button>` : '';
    const label = s.hide ? '済み' : s.state === 'ask' && s.seen ? '見た・返事まだ' : ST[s.state] || '';
    const body = `<div class="sline"><span class="badge">${label}</span><span class="stitle">${esc(s.title)}</span></div>
      ${s.q ? `<div class="sq">${esc(s.q)}</div>` : ''}`;
    const btn = waiting(s) ? `<button class="btn small ghost shide" data-shide="${esc(s.id)}" title="もう返事がいらない会話を下げる（新しいやり取りがあればまた出ます）">済みにする</button>`
      : s.hide ? `<button class="btn small ghost shide" data-shide="${esc(s.id)}" data-undo="1">戻す</button>` : '';
    const acctApp = s.acct && ACCT_APP[s.acct];
    const tags = [
      s.acct ? `<span class="stag ${acctCls(s.acct)}">${esc(acctName(s.acct))}</span>` : '',
      !acctApp || acctApp !== s.app ? `<span class="sic" title="アプリ">${s.app === 'VS Code' ? IC.code : IC.app}${esc(s.app)}</span>` : '',
      s.host && s.host !== HOME_PC ? `<span class="sic" title="PC">${IC.pc}${esc(pcName(s.host))}</span>` : '',
      s.folder && s.folder !== 'obsidian' ? `<span class="sic" title="フォルダ">${IC.folder}${esc(s.folder)}</span>` : '',
    ].join('');
    return `<div class="srow st-${s.hide ? 'done' : s.state === 'ask' && s.seen ? 'seen' : esc(s.state)}">
      ${main ? `<a class="sbody" href="${esc(main)}"${ph ? ph.attr : main.startsWith('https:') ? ' target="_blank" rel="noopener noreferrer"' : ''}>${body}</a>` : body}
      <div class="sfoot">${tags}<span class="sago">${ago(s.at)}</span><span class="sact">${sub}${switchHtml(s)}${away ? `<span class="sic">${esc(pcName(s.host))}${s.sy ? 'で作業中' : 'で開いてください'}</span>` : ''}${hand}${btn}</span></div></div>`;
  };
  // 新しい順に1本で並べる。多いときは10件目以降を折りたたむ
  const sorted = [...list].sort((a, b) => b.at - a.at);
  const urgent = (x) => x.state === 'work' || waiting(x);   // 質問あり・止まっている・作業中は全部出す
  const head = [], rest = [];
  for (const x of sorted) (urgent(x) || (!x.hide && head.filter((y) => !urgent(y)).length < 5) ? head : rest).push(x);
  // 最終更新はPCごと（1台だけなら今までどおりの1行）
  const pcs = data.hosts && data.hosts.length ? data.hosts : [{ host: data.host || '', at: data.at }];
  const upd = pcs.map((p) => {
    const t = new Date(p.at), old = Date.now() - t.getTime() > 90 * 60000;
    return `<span class="${old ? 'stale' : ''}">${pcs.length > 1 ? esc(pcName(p.host)) + ' ' : 'PCから '}${t.getMonth() + 1}/${t.getDate()} ${hm(t)}${old ? '（止まっているかもしれません）' : ''}</span>`;
  }).join('・');
  el.innerHTML = usageHtml() + (head.length ? head.map(row).join('') : '<div class="muted">48時間以内のセッションはありません</div>')
    + (rest.length ? `<details class="sdone"><summary>ほか ${rest.length}件（返事済み・済み、48時間以内）</summary>${rest.map(row).join('')}</details>` : '')
    + `<div class="supd">${upd} に更新</div>`
    + (PHONE ? `<div class="supd">このスマホのClaudeアプリ：${esc(acctName(phoneAcct))} <button type="button" class="btn small ghost" data-acct>変える</button></div>` : '');
}

// セッションだけ読み直す（開いている間は1分おき）
let sesAt = 0;
function putSessions(data) {
  if (!data) return;
  const cached = load(LS.remote, null);
  if (cached) save(LS.remote, { ...cached, sessions: data });
  lastQuota = data.quota || null;
  renderDest();
  renderMemos();
  const open = !!$('#sessions .sdone')?.open;
  renderSessions(data);
  if (open) { const d = $('#sessions .sdone'); if (d) d.open = true; }
}
async function loadSessions() {
  if (!cfg.url || document.visibilityState !== 'visible' || Date.now() - sesAt < 20000) return;
  sesAt = Date.now();
  try { const j = await post({ type: 'sessions' }); if (j.ok) putSessions(j.sessions); } catch { /* 次の回に */ }
}
setInterval(loadSessions, 60000);
window.addEventListener('focus', loadSessions);
$('#sessions').addEventListener('click', async (ev) => {
  if (ev.target.closest('[data-acct]')) {
    const d = load(LS.remote, {}).sessions;
    const all = [...new Set([...((d && d.sessions) || []).map((x) => x.acct).filter(Boolean), 'アカウントA', 'アカウントB'])].sort();
    phoneAcct = all[(all.indexOf(phoneAcct) + 1) % all.length];
    save(ACCT_KEY, phoneAcct);
    renderSessions(d); renderWishes();
    return;
  }
  const b = ev.target.closest('[data-shide]');
  if (!b) return;
  const s = ((load(LS.remote, {}).sessions || {}).sessions || []).find((x) => x.id === b.dataset.shide);
  if (!s) return;
  b.disabled = true;
  try {
    const j = await post({ type: 'sessionHide', id: s.id, at: s.at, undo: !!b.dataset.undo });
    if (!j.ok) throw new Error(j.error || 'ng');
    sesAt = Date.now();
    putSessions(j.sessions);
  } catch { b.disabled = false; setStatus('済みの印を保存できませんでした'); }
});

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
// 新しく開く先：使用量に余裕がある方（VS Code＝CLIのログイン、デスクトップ＝アプリのログイン）
let lastQuota = null;
function chooseApp() {
  const v = lastQuota && lastQuota.vscode, d = lastQuota && lastQuota.desktop;
  if (!v && !d) return { app: 'VS Code', why: '使用量が分からないのでVS Code' };
  if (!d) return { app: 'VS Code', why: 'デスクトップの使用量が分からない' };
  if (!v) return { app: 'デスクトップ', why: 'VS Codeの使用量が分からない' };
  const label = (q, n) => `${n} 5時間${q.fh}%・7日${q.sd}%${q.est ? '（推定）' : ''}`;
  const both = `${label(v, 'VS Code')}／${label(d, 'デスクトップ')}`;
  if (v.sd >= 95 && d.sd < 95) return { app: 'デスクトップ', why: `VS Codeの7日枠が残り少ない。${both}` };
  if (d.sd >= 95 && v.sd < 95) return { app: 'VS Code', why: `デスクトップの7日枠が残り少ない。${both}` };
  if (v.fh < 80 && d.fh < 80) return v.sd <= d.sd ? { app: 'VS Code', why: `7日枠に余裕。${both}` } : { app: 'デスクトップ', why: `7日枠に余裕。${both}` };
  return v.fh <= d.fh ? { app: 'VS Code', why: `5時間枠に余裕。${both}` } : { app: 'デスクトップ', why: `5時間枠に余裕。${both}` };
}
function companionPrompt(w, task) {
  return `【やりたいこと伴走】「${w.text}」（やりたいことID ${w.id}・${md(w.at)}に思った）
`
    + (task ? `作業「${task}」を進めたい。関係する記憶と記録を確かめて、この作業の次の一歩を短く示してください。`
      : 'これをかなえるまで伴走してください。関係する記憶と記録を確かめて、今どこまで来ているか・かなえるまでの作業の分け方・次の一歩を短く示してください。');
}
function newUrl(app, prompt) {
  return app === 'デスクトップ'
    ? `claude://code/new?q=${encodeURIComponent(prompt)}`
    : `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`;
}
function companionUrl(w, task) { return newUrl(chooseApp().app, companionPrompt(w, task)); }

// ---------- 続きか新規かを選ぶ欄（作業・やりたいことの名前を押すと、その下に開く）----------
function quotaText(app) {
  const q = lastQuota && lastQuota[app === 'デスクトップ' ? 'desktop' : 'vscode'];
  if (!q) return '使用量は不明';
  const reset = q.fhReset && q.fhReset * 1000 > Date.now() ? `・${hm(new Date(Math.round(q.fhReset / 60) * 60000))}に回復` : '';
  return `5時間枠 ${q.fh}%・7日枠 ${q.sd}%${reset}${q.est ? '（推定）' : ''}`;
}
function quotaTight(app) {
  const q = lastQuota && lastQuota[app === 'デスクトップ' ? 'desktop' : 'vscode'];
  return !!q && (q.fh >= 90 || q.sd >= 95);
}
// 続きの候補：その作業の会話を先頭に、やりたいこと全体の関係する会話を新しい順で（3件まで）
function continueList(w, t) {
  const ses = [...((w.progress && w.progress.sessions) || [])].sort((a, b) => (a.d < b.d ? 1 : -1));
  const live = ((load(LS.remote, {}).sessions || {}).sessions || []);
  const own = t && t.open ? [{ ...t, t: (ses.find((x) => x.open === t.open) || {}).t || '', d: (ses.find((x) => x.open === t.open) || {}).d || '' }] : [];
  const seen = new Set();
  return [...own, ...ses].filter((x) => continueUrl(x, '') && !seen.has(x.open) && seen.add(x.open)).slice(0, 3).map((x) => {
    const l = live.find((y) => y.open === x.open);
    return { ...x, cli: l && l.cli, state: l && l.state, acct: l && l.acct, t: (l && l.title) || x.t || 'この作業の会話', rc: l && RE_RC.test(l.rc || '') ? l.rc : '' };
  });
}
function pickHtml(w, t) {
  const task = t ? t.t : '';
  const cont = continueList(w, t).map((x) => {
    const ph = PHONE ? phoneLink(x.rc, x.acct) : null;
    const url = PHONE ? (ph ? ph.url : '') : continueUrl(x, `続き：やりたいこと「${w.text}」${task ? `の作業「${task}」` : ''}を進めよう`);
    const tight = quotaTight(x.app) ? '・<span class="ptight">枠が残りわずか</span>' : '';
    const inner = `<span class="pn">${esc(x.t)}</span><span class="meta">${esc(x.app)}${x.d ? '・' + md(x.d) : ''}${tight}${url ? (ph && ph.via ? '・' + esc(ph.via) : '') : '・新しい会話で続ける（文をコピー）'}</span>`;
    return (url ? `<a class="pbtn" href="${esc(url)}"${ph ? ph.attr : ''}>${inner}</a>` : `<button type="button" class="pbtn" data-hand="${esc(x.cli || x.open)}" data-title="${esc(x.t)}">${inner}</button>`) + (switchTo(x) ? `<div class="meta psw">${switchHtml(x)}</div>` : '');
  }).join('');
  let fresh;
  if (PHONE) {
    fresh = `<button type="button" class="pbtn" data-pcopy><span class="pn">文をコピーしてClaudeを開く</span><span class="meta">「obsidian」を選び、貼って送る。VS Code側：${quotaText('VS Code')}／デスクトップ側：${quotaText('デスクトップ')}</span></button>`;
  } else {
    const ch = chooseApp();
    const apps = ch.app === 'VS Code' ? ['VS Code', 'デスクトップ'] : ['デスクトップ', 'VS Code'];
    fresh = apps.map((a, i) => `<a class="pbtn${i ? '' : ' rec'}" href="${esc(newUrl(a, companionPrompt(w, task)))}"><span class="pn">${a}${i ? '' : '（余裕がある方）'}</span><span class="meta">${quotaText(a)}${quotaTight(a) ? '・<span class="ptight">枠が残りわずか</span>' : ''}</span></a>`).join('');
  }
  return `<div class="pick"><div class="ph">続きから</div>${cont || '<div class="meta">関係する会話はまだありません</div>'}<div class="ph">新しい会話で</div>${fresh}</div>`;
}
$('#wishes').addEventListener('click', (e) => {
  const pw = e.target.closest('[data-pickw]');
  const row = pw ? pw.closest('.wmain') : e.target.closest('[data-pick]');
  if (row) {
    const next = row.nextElementSibling;
    const was = next && next.classList.contains('pick');
    document.querySelectorAll('#wishes .pick').forEach((x) => x.remove());
    document.querySelectorAll('#wishes [data-pick]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
    if (was) return;
    const [id, i] = pw ? [pw.dataset.pickw, ''] : row.dataset.pick.split(':');
    const w = wishes.find((x) => x.id === id);
    if (!w) return;
    const t = i === '' ? null : ((w.progress && w.progress.tasks) || [])[+i];
    row.insertAdjacentHTML('afterend', pickHtml(w, t));
    row.nextElementSibling._pick = { w, t };
    if (!pw) row.setAttribute('aria-expanded', 'true');
    return;
  }
  const copy = e.target.closest('[data-pcopy]');
  if (copy) {
    const { w, t } = copy.closest('.pick')._pick;
    copyAndOpenClaude(companionPrompt(w, t ? t.t : ''));
  }
});

function progressHtml(p, w) {
  if (!p || !(p.stage in STAGE_N)) return '';
  const n = STAGE_N[p.stage];
  const dots = [0, 1, 2, 3].map((i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  const ses = (p.sessions || []).length
    ? `<details class="wses"><summary>関係するセッション ${p.sessions.length}件</summary>${p.sessions.map((s) => `<div>${esc(s.t)} <span class="meta">${md(s.d)}</span></div>`).join('')}</details>` : '';
  const tasks = p.tasks || [];
  const doneN = tasks.filter((t) => t.s === '済').length;
  const MARK = { '済': '✓', '途中': '◐', '待ち': '⏸', '未': '○' };
  const trow = (t) => {
    const go = continueUrl(t, '') ? '続き・新規' : '始める';
    const inner = `<span class="tm">${MARK[t.s] || '○'}</span><span class="tt">${esc(t.t)}${t.by === '人' ? '<span class="tby" title="本人・伴走で決めた（見立て役は変えない）">✎</span>' : ''}${t.hint ? `<span class="thint">見立て：${esc(t.hint)}</span>` : ''}</span>${t.s !== '済' ? `<span class="tgo">${go}</span>` : ''}`;
    const cls = `wtask ts-${t.s === '済' ? 'done' : t.s === '途中' ? 'doing' : t.s === '待ち' ? 'wait' : 'todo'}`;
    const tip = t.basis ? ` title="${esc((t.s === '待ち' ? '待っているもの：' : '根拠：') + t.basis)}"` : '';
    return w && /^[0-9a-f]{8}$/.test(w.id) ? `<button type="button" class="${cls}" data-pick="${esc(w.id)}:${tasks.indexOf(t)}" aria-expanded="false"${tip}>${inner}</button>` : `<div class="${cls}"${tip}>${inner}</div>`;
  };
  // 作業の数に上限はない。出すのは「途中」と次の「未」1つだけ、全部は畳む（原則2）
  const doing = tasks.filter((t) => t.s === '途中');
  const next = tasks.find((t) => t.s === '未');
  const shown = [...doing, ...(next ? [next] : [])];
  const tasksHtml = !tasks.length ? '' : `<div class="wtasks">${shown.map(trow).join('')}</div>`
    + (tasks.length > shown.length ? `<details class="wses"><summary>全部の作業（${tasks.length}）</summary><div class="wtasks">${tasks.map(trow).join('')}</div></details>` : '');
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

function renderDest() {
  const ch = chooseApp();
  const dest = $('#wish-dest');
  if (dest) { dest.textContent = PHONE ? '' : `新しく開く先：${ch.app}`; dest.title = ch.why; }
}
function renderWishes() {
  const n = wishes.filter((w) => w.state === 'open').length;
  $('#wish-count').textContent = n ? `${n}件` : '';
  renderDest();
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
      // 名前を押すと、続きか新規かを選ぶ欄が下に開く（伴走ボタンの役目もここへ移した）
      return `<div class="wrow"><div class="wmain"><button type="button" class="wtext wlink" data-pickw="${id}" title="続きか新規かを選ぶ">${esc(w.text)}</button>
          <span class="wops"><button class="btn small ghost" data-pickw="${id}" title="続きか新規かを選ぶ">伴走</button><button class="btn small ghost" data-wa="done" data-id="${id}">やった</button>
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
  if (!el) return;
  if (el.querySelector('.chpanel')) closeChart();
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
  const heldHtml = held.map((h) => `<div class="qrow hchart" data-chart="${esc(h.code)}" role="button" tabindex="0" title="押すとチャート"><span class="qn">${esc(h.name)} <span class="meta">${esc(h.code)}・保有</span></span>
      <span class="qp">${fmtP(h.price, h.cur)}${h.cur === 'USD' ? ' ドル' : ''}</span><span class="qc ${h.pct > 0 ? 'up' : h.pct < 0 ? 'down' : ''}">${h.pct >= 0 ? '+' : ''}${h.pct.toFixed(2)}%</span></div>`).join('');
  let latest = lastHoldings && lastHoldings.quoteTime ? lastHoldings.quoteTime : 0;
  el.innerHTML = heldHtml + qs.map((q) => {
    if (q.error || q.price == null) return `<div class="qrow"><span class="qn">${esc(q.name)}</span><span class="muted">取得できず</span></div>`;
    latest = Math.max(latest, q.time || 0);
    const ch = q.prev ? q.price - q.prev : 0, pc = q.prev ? (ch / q.prev) * 100 : 0;
    const cls = ch > 0 ? 'up' : ch < 0 ? 'down' : '';
    const fmt = (n) => n.toLocaleString('ja-JP', { maximumFractionDigits: q.currency === 'JPY' ? 1 : 2 });
    return `<div class="qrow hchart" data-chart="${esc(q.code)}" role="button" tabindex="0" title="押すとチャート"><span class="qn">${esc(q.name)} <span class="meta">${esc(q.code)}</span></span>
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
  closeChart();
  renderStocks();
  if (!h) { $('#hold').innerHTML = '<div class="muted">まだありません。「貼り付けて更新」から保有一覧を貼ってください</div>'; return; }
  $('#hold-at').textContent = `株は${h.quoteTime ? hm(new Date(h.quoteTime * 1000)) : '—'}時点・投信は${md(h.at)}時点`;
  const total = h.stockTotal + h.fundTotal, pnl = h.stockPnl + h.fundPnl;
  const jp = h.stocks.filter((s) => s.cur === 'JPY'), us = h.stocks.filter((s) => s.cur !== 'JPY');
  const fmtP = (n, cur) => (n == null ? '—' : n.toLocaleString('ja-JP', { maximumFractionDigits: cur === 'JPY' ? 1 : 2 }) + (cur === 'USD' ? 'ドル' : '円'));
  const dpct = (s) => (s.value - s.day ? (s.day / (s.value - s.day)) * 100 : 0);
  const srow = (s) => `<div class="hrow2 hchart" data-chart="${esc(s.code)}" data-name="${esc(s.name)}" role="button" tabindex="0" title="押すとチャート"><div class="r1"><span class="hn">${esc(s.name)} <span class="meta">${esc(s.code)}・${esc(s.inst)}</span></span><span class="hv">${yen(s.value)}</span></div>
      <div class="r2"><span>${fmtP(s.price, s.cur)} <span class="${pnlCls(s.day)}">${dpct(s) >= 0 ? '+' : ''}${dpct(s).toFixed(2)}%</span></span>
      <span>前日比 <span class="${pnlCls(s.day)}">${sign(s.day)}円</span></span>
      <span class="pl">損益 ${sign(s.pnl)}円（${s.pnlPct >= 0 ? '+' : ''}${s.pnlPct.toFixed(1)}%）</span></div></div>`;
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
    ${grp(`日本株 <span class="meta">${jp.length}銘柄</span>`, jp, srow)}${grp(`米国株 <span class="meta">${us.length}銘柄</span>`, us, srow, `<span class="meta">1ドル${h.fx ? h.fx.toFixed(2) : '—'}円</span>`)}${grp(`投資信託 <span class="meta">${h.funds.length}本</span>`, h.funds, frow)}
    <div class="meta">投資信託の基準価額は貼り付けた日のまま。売買したら貼り直してください</div>`;
}
// ---------- 保有株のチャート（銘柄を押すと下に開く） ----------
const CH_RANGES = [['1d', '1日', '5分足'], ['1mo', '1か月', '日足'], ['1y', '1年', '日足'], ['5y', '5年', '週足'], ['15y', '15年', '月足']];
const LWC_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/lightweight-charts/5.0.8/lightweight-charts.standalone.production.js';
let lwcLoading = null, chartObj = null, chartCode = '', chartReq = 0;
function loadLwc() {
  if (window.LightweightCharts) return Promise.resolve();
  if (!lwcLoading) lwcLoading = new Promise((ok, ng) => {
    const s = document.createElement('script'); s.src = LWC_SRC; s.onload = ok; s.onerror = () => { lwcLoading = null; ng(new Error('lib')); };
    document.head.appendChild(s);
  });
  return lwcLoading;
}
function closeChart() {
  if (chartObj) { chartObj.remove(); chartObj = null; }
  document.querySelectorAll('.chpanel').forEach((p) => p.remove());
  document.querySelectorAll('.hchart.open').forEach((r) => r.classList.remove('open'));
  chartCode = '';
}
function openChart(row) {
  const code = row.dataset.chart;
  const same = chartCode === code;
  closeChart();
  if (same) return;
  chartCode = code;
  row.classList.add('open');
  const p = document.createElement('div');
  p.className = 'chpanel';
  p.innerHTML = `<div class="chtabs">${CH_RANGES.map(([k, l]) => `<button type="button" data-chr="${k}">${l}</button>`).join('')}</div>
    <div class="chinfo meta"></div><div class="chbox"></div>`;
  row.after(p);
  drawChart(p, code, load('portal-chart-range', '1y'));
}
async function drawChart(p, code, range) {
  const req = ++chartReq;
  save('portal-chart-range', range);
  p.querySelectorAll('[data-chr]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.chr === range));
  const info = p.querySelector('.chinfo'), box = p.querySelector('.chbox');
  info.textContent = '読み込み中…';
  try {
    const [j] = await Promise.all([post({ type: 'stockChart', code, range }), loadLwc()]);
    if (req !== chartReq || !p.isConnected) return;
    if (!j.ok) throw new Error(j.error);
    if (!j.bars.length) { info.textContent = 'この期間の値がありません'; return; }
    renderChart(p, j);
  } catch (e) {
    if (req !== chartReq) return;
    info.textContent = e.message === 'lib' ? 'グラフの部品を読めませんでした（通信を確かめてください）' : `チャートを読めませんでした（${e.message}）`;
  }
}
function renderChart(p, j) {
  const LW = window.LightweightCharts;
  const box = p.querySelector('.chbox');
  if (chartObj) { chartObj.remove(); chartObj = null; }
  const css = getComputedStyle(document.documentElement);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const up = dark ? '#ff8a73' : '#c0392b', down = dark ? '#7fb2ff' : '#2e6fb5';
  const intraday = j.range === '1d';
  // 時刻は取引所の現地時間で見せる（グラフ部品はUTCで描くので、その分ずらして渡す）
  const off = j.gmtoffset || 0;
  const pad = (n) => String(n).padStart(2, '0');
  const fmtT = (t) => { const d = new Date(t * 1000);
    return intraday ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : j.range === '15y' ? `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}` : `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
  chartObj = LW.createChart(box, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: css.getPropertyValue('--muted').trim(), fontSize: 11, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: css.getPropertyValue('--line').trim() } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: intraday, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
    localization: { locale: 'ja-JP', timeFormatter: fmtT },
    handleScroll: { vertTouchDrag: false },
  });
  const s = chartObj.addSeries(LW.CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down,
    priceFormat: { type: 'price', precision: j.currency === 'JPY' ? 0 : 2, minMove: j.currency === 'JPY' ? 1 : 0.01 } });
  const rows = [];
  j.bars.forEach(([t, o, h, l, c]) => {   // 週足・月足は最後の足が同じ時刻で重なることがある＝後の値で置き換える
    const r = { time: t + off, open: o, high: h, low: l, close: c };
    if (rows.length && rows[rows.length - 1].time >= r.time) rows[rows.length - 1] = { ...r, time: rows[rows.length - 1].time };
    else rows.push(r);
  });
  s.setData(rows);
  if (intraday && j.prev) s.createPriceLine({ price: j.prev, color: css.getPropertyValue('--muted').trim(), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '前日終値' });
  chartObj.timeScale().fitContent();
  // 期間の始めから今までの動き。指でなぞった足の値も同じ行に出す
  const first = intraday && j.prev ? j.prev : j.bars[0][1], last = j.bars[j.bars.length - 1][4];
  const cur = j.currency === 'JPY' ? '円' : 'ドル';
  const fmtP = (n) => n.toLocaleString('ja-JP', { maximumFractionDigits: j.currency === 'JPY' ? 1 : 2 });
  const chg = last - first, pct = first ? (chg / first) * 100 : 0;
  const unit = CH_RANGES.find((r) => r[0] === j.range);
  const base = `${unit[1]}で <span class="${pnlCls(chg)}">${chg >= 0 ? '+' : '−'}${fmtP(Math.abs(chg))}${cur}（${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）</span>・1本＝${unit[2]}`;
  const info = p.querySelector('.chinfo');
  info.innerHTML = base;
  chartObj.subscribeCrosshairMove((m) => {
    const d = m && m.time != null ? m.seriesData.get(s) : null;
    info.innerHTML = d ? `${fmtT(m.time)}　始${fmtP(d.open)} 高${fmtP(d.high)} 安${fmtP(d.low)} 終<b>${fmtP(d.close)}</b>` : base;
  });
}
['#hold', '#stocks'].forEach((sel) => {
  $(sel).addEventListener('click', (e) => {
    const t = e.target.closest('[data-chr]');
    if (t) { const p = t.closest('.chpanel'); drawChart(p, chartCode, t.dataset.chr); return; }
    if (e.target.closest('.chpanel')) return;
    const row = e.target.closest('.hchart');
    if (row) openChart(row);
  });
  $(sel).addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.hchart');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openChart(row); }
  });
});
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
const GICON = {
  'mail.google.com': 'https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico',
  'calendar.google.com': 'https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_24_2x.png',
  'drive.google.com': 'https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_32dp.png',
};
function iconHtml(l) {
  let host = '';
  try { host = new URL(l.url).hostname; } catch {}
  const letter = esc((l.name || '?').trim().charAt(0));
  if (host && !host.endsWith('github.io')) {
    // Google の各サービスは汎用の「G」になって見分けられないので、製品ごとのアイコンを使う
    const src = GICON[host] || `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
    return `<span class="ic" style="background:var(--card)"><img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fb="${letter}" data-bg="${colorOf(l.name)}"></span>`;
  }
  return `<span class="ic" style="background:${colorOf(l.name)}">${letter}</span>`;
}

function renderLinks() {
  const root = $('#links');
  root.classList.toggle('editing', !!editing);
  if (editing) { renderEditor(); return; }
  root.innerHTML = links.sections.map((s) => `<div class="card sec">
      <h2>${esc(s.title)}</h2>
      <div class="tiles">${s.links.map((l) => `<a class="tile" href="${esc(l.url)}" title="${esc(l.name)}" aria-label="${esc(l.name)}">${iconHtml(l)}<span class="nm">${esc(l.name)}</span></a>`).join('')}</div>
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
  $('#setup-pc').value = cfg.pc || '';
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
    cfg = { url: $('#setup-url').value.trim(), key: $('#setup-key').value.trim(), keihi: $('#setup-keihi').value.trim(), pc: $('#setup-pc').value };
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

// ---------- 研修の作業記録（メモをためて、Claude が1日分の記録にまとめる）----------
let memos = [];
let memoEdit = null;   // 直しているメモのID
let memoNewId = null;  // 送り直しても二重にならないよう、保存できるまで同じIDを使う
const MEMO_DRAFT = 'portal-memo-draft';
const hexId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
let diary = [];        // 記録にした日と、その会話
const voiceOf = () => ((load(LS.remote, {}) || {}).sessions || {}).voice || {};
function memoPrompt(date, n, v) {
  const src = [n ? `ポータルの作業記録メモ${n}件` : '', v ? `音声${v}件` : '', 'アプリのその日の記録'].filter(Boolean).join('・');
  return `研修の作業記録を作ってください（farm-diary スキル、対象日 ${date}）。${src}を読んで始めてください。`;
}
// 記録を作った会話へ戻る
function diaryLink(d) {
  if (!PHONE) return continueUrl({ app: d.app, open: d.host || d.cli }, `${d.date} の作業記録を直したい：`);
  const l = ((load(LS.remote, {}).sessions || {}).sessions || []).find((y) => y.open === (d.host || d.cli) || y.cli === d.cli);
  const ph = l && phoneLink(l.rc, l.acct);
  return ph && !ph.via ? ph.url : '';
}
function renderMemos() {
  $('#memo-count').textContent = memos.length ? `まだ記録にしていないメモ ${memos.length}件` : '';
  const voice = voiceOf();
  const days = [...new Set([...memos.map((m) => m.date), ...Object.keys(voice).filter((d) => voice[d])])].sort().reverse();
  const wasOpen = !!$('#memos .mdone')?.open;
  $('#memos').innerHTML = days.map((d) => {
    const list = memos.filter((m) => m.date === d);
    const wd = WD[new Date(d.replace(/-/g, '/')).getDay()];
    const prompt = memoPrompt(d, list.length, voice[d]);
    let go;
    if (PHONE) go = `<button type="button" class="btn small" data-mcopy="${esc(d)}">文をコピーしてClaudeを開く</button>`;
    else {
      const a = chooseApp().app, b = a === 'VS Code' ? 'デスクトップ' : 'VS Code';
      go = `<a class="btn small" href="${esc(newUrl(a, prompt))}" title="${esc(quotaText(a))}">Claudeで記録にする（${a}）</a><a class="slink" href="${esc(newUrl(b, prompt))}" title="${esc(quotaText(b))}">${b}で</a>`;
    }
    return `<div class="mday"><div class="mday-h"><b>${md(d)}（${wd}）${voice[d] ? `<span class="meta">　音声 ${voice[d]}件</span>` : ''}</b>${go}</div>${list.map((m) => `<div class="mitem"><div class="mtext">${esc(m.t)}</div>
      <span class="mops"><button type="button" class="btn small ghost" data-medit="${esc(m.id)}">直す</button><button type="button" class="btn small ghost" data-mdel="${esc(m.id)}">消す</button></span></div>`).join('')}</div>`;
  }).join('') + (diary.length ? `<details class="mdone wses"${wasOpen ? ' open' : ''}><summary>記録にした日（${diary.length}）</summary>${diary.map((d) => {
    const u = diaryLink(d), wd = WD[new Date(d.date.replace(/-/g, '/')).getDay()];
    return `<div class="mrec"><span>${md(d.date)}（${wd}）</span>${u ? `<a class="slink" href="${esc(u)}"${PHONE ? ' target="_blank" rel="noopener noreferrer"' : ''}>会話を開いて直す</a>`
      : `<button type="button" class="btn small ghost" data-hand="${esc(d.cli)}" data-title="${esc(d.date)} の作業記録">新しい会話で直す</button>`}</div>`;
  }).join('')}</details>` : '');
}
function putMemos(list) {
  memos = list;
  const cached = load(LS.remote, null);
  if (cached) save(LS.remote, { ...cached, memos: list });
  renderMemos();
}
function memoReset() {
  memoEdit = null; memoNewId = null;
  $('#memo-text').value = ''; $('#memo-date').value = today();
  $('#memo-add').textContent = 'メモに足す'; $('#memo-cancel').hidden = true;
  save(MEMO_DRAFT, null);
}
$('#memo-date').value = today();
$('#memo-text').value = (load(MEMO_DRAFT, null) || {}).t || '';
if ((load(MEMO_DRAFT, null) || {}).d) $('#memo-date').value = load(MEMO_DRAFT, null).d;
// 書きかけは端末に残す（電波がなくても消えない）
$('#memo-form').addEventListener('input', () => { if (!memoEdit) save(MEMO_DRAFT, $('#memo-text').value ? { t: $('#memo-text').value, d: $('#memo-date').value } : null); });
$('#memo-cancel').addEventListener('click', memoReset);
$('#memo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#memo-text').value.trim(), date = $('#memo-date').value || today();
  if (!text) return;
  if (!cfg.url) { setStatus('窓口が未設定です'); return; }
  const id = memoEdit || memoNewId || (memoNewId = hexId());
  $('#memo-add').disabled = true;
  setStatus('メモを保存中…');
  try {
    const j = await post({ type: 'memoSave', id, date, text });
    if (!j.ok) throw new Error(j.error);
    putMemos(j.memos); memoReset(); setStatus('');
  } catch { setStatus('メモを保存できませんでした。書いた文は残っています。もう一度押してください'); }
  $('#memo-add').disabled = false;
});
$('#memos').addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-medit]'), del = e.target.closest('[data-mdel]'), copy = e.target.closest('[data-mcopy]');
  if (ed) {
    const m = memos.find((x) => x.id === ed.dataset.medit);
    if (!m) return;
    memoEdit = m.id;
    $('#memo-text').value = m.t; $('#memo-date').value = m.date;
    $('#memo-add').textContent = '直して保存'; $('#memo-cancel').hidden = false;
    $('#memo-text').focus();
    return;
  }
  if (del) {
    if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = '本当に消す'; return; }
    del.disabled = true;
    try {
      const j = await post({ type: 'memoMark', ids: [del.dataset.mdel], to: 'delete' });
      if (!j.ok) throw new Error(j.error);
      if (memoEdit === del.dataset.mdel) memoReset();
      putMemos(j.memos);
    } catch { del.disabled = false; setStatus('消せませんでした'); }
    return;
  }
  if (copy) {
    const n = memos.filter((m) => m.date === copy.dataset.mcopy).length;
    copyAndOpenClaude(memoPrompt(copy.dataset.mcopy, n, voiceOf()[copy.dataset.mcopy]));
  }
});

// 「研修の作業記録」のアイコン：欄まで動いて、すぐ書ける状態にする
function goMemo() {
  $('#memo-card').scrollIntoView({ block: 'start' });
  $('#memo-text').focus({ preventScroll: true });
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a && a.href === MEMO_URL && !e.ctrlKey && !e.metaKey) { e.preventDefault(); goMemo(); }
});
if (location.hash === '#memo-card') setTimeout(goMemo, 300);

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
