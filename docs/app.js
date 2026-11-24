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
  const [url, key] = decodeURIComponent(m[1]).split('|');
  if (url && key) { cfg = { url, key }; save(LS.cfg, cfg); }
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
    $('#events').innerHTML = $('#pest').innerHTML = $('#sessions').innerHTML =
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
async function post(body) {
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, key: cfg.key }),
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
function renderSessions(data) {
  const el = $('#sessions');
  if (!data) { el.innerHTML = '<div class="muted">まだ届いていません（PCの見回り役が未起動）</div>'; return; }
  const list = data.sessions || [];
  const row = (s) => `<div class="srow st-${esc(s.state)}">
      <div class="sline"><span class="badge">${ST[s.state] || ''}</span><span class="stitle">${esc(s.title)}</span></div>
      ${s.q ? `<div class="sq">${esc(s.q)}</div>` : ''}
      <div class="meta">${esc(s.app)}${s.folder ? '・' + esc(s.folder) : ''}・${ago(s.at)}</div></div>`;
  const pick = (st) => list.filter((s) => s.state === st);
  const urgent = [...pick('ask'), ...pick('stuck')];
  const work = pick('work');
  const done = pick('done');
  const at = new Date(data.at);
  const stale = Date.now() - at.getTime() > 90 * 60000;
  el.innerHTML = (urgent.length ? urgent.map(row).join('') : '<div class="muted">あなたの番のセッションはありません</div>')
    + (work.length ? `<div class="sgroup">作業中</div>${work.map(row).join('')}` : '')
    + (done.length ? `<details class="sdone"><summary>返事済み ${done.length}件（48時間以内）</summary>${done.map(row).join('')}</details>` : '')
    + `<div class="supd${stale ? ' stale' : ''}">PCから ${at.getMonth() + 1}/${at.getDate()} ${hm(at)} に更新${stale ? '（PCが止まっているかもしれません）' : ''}</div>`;
}

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
  const link = `${location.origin}${location.pathname}#setup=${encodeURIComponent(url + '|' + key)}`;
  const q = window.qrcode(0, 'M'); q.addData(link); q.make();
  box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
    + '<div class="muted">スマホのカメラで読み取ってください。人に見せないでください。</div>';
  box.hidden = false;
});
$('#setup').addEventListener('close', () => { $('#qr').hidden = true; $('#qr').innerHTML = ''; });

$('#setup-form').addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'save') {
    cfg = { url: $('#setup-url').value.trim(), key: $('#setup-key').value.trim() };
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
loadWeather();
loadRemote();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  renderDate();
  const w = load(LS.weather, null);
  if (!w || Date.now() - new Date(w.current?.time || 0).getTime() > 30 * 60000) loadWeather();
  loadRemote();
});
