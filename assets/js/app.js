const $app = document.getElementById('app');
const $crumbs = document.getElementById('crumbs');

const PAGE_SIZE = 100;
const SEARCH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

let config = null;
let renderToken = 0;
let leaveView = null;
const vtableCache = new WeakMap();

history.scrollRestoration = 'manual';

const Esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const Enc = encodeURIComponent;
const Basename = (path) => path.slice(path.lastIndexOf('/') + 1);
const Mb = (n) => (n / 1048576).toFixed(1);

function Hue(text)
{
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

// "A::B<x>::Func(int) const" -> { q: "A::B<x>::", n: "Func", a: "(int) const" }
function SplitSignature(sig)
{
  let end = sig.length;
  let i = sig.lastIndexOf(')');
  if (i !== -1) {
    for (let depth = 0; i >= 0; --i) {
      if (sig[i] === ')') depth++;
      else if (sig[i] === '(' && --depth === 0) break;
    }
    end = Math.max(i, 0);
  }

  const base = sig.slice(0, end);
  let j = base.length - 1;
  for (let depth = 0; j > 0; --j) {
    const c = base[j];
    if (c === '>') depth++;
    else if (c === '<') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ':' && base[j - 1] === ':') break;
  }
  const split = j > 0 ? j + 1 : 0;
  return { q: base.slice(0, split), n: base.slice(split), a: sig.slice(end) };
}

/* ---------- Data loading ---------- */

function Ingest(file, out)
{
  for (const cls of out.classes) {
    cls.file = file;
    cls.key = cls.name.toLowerCase();
    cls.nameKey = cls.key;
    cls.short = cls.key;
  }

  for (const fn of out.functions) {
    fn.classes = fn.classes.map((i) => out.classes[i]);
    fn.file = file;
    fn.sig = SplitSignature(fn.name);
    fn.nameKey = (fn.sig.q + fn.sig.n).toLowerCase();
    fn.key = fn.nameKey + fn.sig.a.toLowerCase();
    fn.short = fn.sig.n.toLowerCase();
    const ownerName = fn.sig.q.slice(0, -2);
    fn.owner = fn.classes.find((c) => c.name === ownerName)
      || fn.classes.reduce((a, b) => (b.name.length < a.name.length ? b : a));
  }

  file.classes = out.classes;
  file.functions = out.functions;
  file.classByName = new Map(out.classes.map((c) => [c.name, c]));
}

function LoadFile(game, file)
{
  return new Promise((resolve) => {
    const worker = new Worker('assets/js/worker.js');
    worker.onmessage = ({ data }) => {
      if (data.phase) {
        file.progress = data;
        UpdateLoadingRow(game, file);
        return;
      }
      if (data.error) file.error = data.error;
      else Ingest(file, data);
      file.done = true;
      worker.terminate();
      UpdateLoadingRow(game, file);
      resolve();
    };
    worker.postMessage(new URL(config.base + file.path, location.href).href);
  });
}

function LoadGame(game)
{
  if (!game.data) {
    const files = game.bins.map((path) => ({ path, name: Basename(path), progress: null, error: null, classes: [], functions: [] }));
    game.data = { files, done: false, search: { q: '', limit: PAGE_SIZE, scroll: 0 } };
    game.data.ready = Promise.all(files.map((f) => LoadFile(game, f))).then(() => { game.data.done = true; });
  }
  return game.data;
}

/* ---------- VTable layout (Linux / Windows index) ---------- */

function ShouldSkipWindowsFunction(cls, vtableIndex, functionIndex, fn)
{
  const functions = cls.vtables[vtableIndex].functions;
  if (fn.name.includes('::~')) {
    return functionIndex > 0 && fn.name === functions[functionIndex - 1].name;
  }
  return cls.vtables.some((vt, n) => n > vtableIndex && vt.functions.some((f) => f.isThunk && f.name === fn.name));
}

function VTableRows(cls)
{
  let rows = vtableCache.get(cls);
  if (rows) return rows;

  rows = [];
  const functions = cls.vtables[0].functions;
  const skip = functions.map((fn, i) => ShouldSkipWindowsFunction(cls, 0, i, fn));
  const sameOverload = (i, fn) => !skip[i] && fn.shortName === functions[i].shortName;

  let windowsIndex = 0;
  for (let i = 0; i < functions.length; ++i) {
    const fn = functions[i];
    let display = null;
    if (!skip[i]) {
      display = windowsIndex++;
      // MSVC groups overloads in reverse declaration order.
      if (fn.symbol) {
        let prev = 0;
        let next = 0;
        while (i - prev - 1 >= 0 && sameOverload(i - prev - 1, fn)) prev++;
        while (i + next + 1 < functions.length && sameOverload(i + next + 1, fn)) next++;
        display += next - prev;
      }
    }
    rows.push({ fn, linux: i, windows: display });
  }

  vtableCache.set(cls, rows);
  return rows;
}

/* ---------- Routing ---------- */

function ParseRoute()
{
  const [path, query = ''] = location.hash.slice(1).split('?');
  const [game, file, cls] = path.split('/').slice(1).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  return { game, file, cls, q: params.get('q') || '', f: params.get('f') };
}

const GameHref = (game, q) => `#/${Enc(game.name)}${q ? '?q=' + Enc(q) : ''}`;
const ClassHref = (game, cls, fn) => `#/${Enc(game.name)}/${Enc(cls.file.path)}/${Enc(cls.name)}${fn ? '?f=' + fn.id : ''}`;

async function Render()
{
  const token = ++renderToken;
  leaveView?.();
  leaveView = null;

  const route = ParseRoute();
  if (!route.game) return RenderHome();

  const game = config.games.find((g) => g.name === route.game);
  if (!game) return RenderMessage('找不到游戏：' + route.game);

  const data = LoadGame(game);
  if (!data.done) {
    RenderLoading(game);
    await data.ready;
    if (token !== renderToken) return;
  }

  if (route.cls) RenderDetail(game, route);
  else RenderSearch(game, route);
}

function SetCrumbs(html)
{
  $crumbs.innerHTML = html;
}

function RenderMessage(text)
{
  SetCrumbs('');
  $app.innerHTML = `<div class="empty">${Esc(text)}</div>`;
}

/* ---------- Home ---------- */

function RenderHome()
{
  SetCrumbs('');
  document.title = 'VTable';
  $app.innerHTML = `
    <h1 class="page-title">选择游戏</h1>
    <p class="page-sub">搜索类或虚函数，查看 Linux / Windows 虚表索引。</p>
    <div class="games">
      ${config.games.map((g) => `
        <a class="game" href="${GameHref(g)}">
          <div class="cover" style="--h:${Hue(g.name)}">${Esc(g.name)}</div>
        </a>`).join('')}
    </div>`;
  window.scrollTo(0, 0);
}

/* ---------- Loading ---------- */

function RenderLoading(game)
{
  SetCrumbs(`<span>${Esc(game.name)}</span>`);
  document.title = `${game.name} · VTable`;
  $app.innerHTML = `
    <div class="loading" data-game="${Esc(game.name)}">
      <h2>正在加载 ${Esc(game.name)}</h2>
      ${game.data.files.map((f, i) => `
        <div class="file-row" data-idx="${i}">
          <span class="name">${Esc(f.name)}</span><span class="state">等待中</span>
          <div class="bar"><i></i></div>
        </div>`).join('')}
    </div>`;
  game.data.files.forEach((f) => UpdateLoadingRow(game, f));
}

function UpdateLoadingRow(game, file)
{
  const root = $app.querySelector('.loading');
  if (!root || root.dataset.game !== game.name) return;

  const row = root.querySelector(`[data-idx="${game.data.files.indexOf(file)}"]`);
  const p = file.progress;
  let state = '等待中';
  let ratio = 0;
  if (file.error) {
    row.classList.add('error');
    state = '失败：' + file.error;
  } else if (file.done) {
    state = '完成';
    ratio = 1;
  } else if (p?.phase === 'download') {
    const frac = p.total ? Math.min(p.loaded / p.total, 1) : 0;
    state = `下载 ${Mb(p.loaded)}${p.total ? ' / ' + Mb(p.total) : ''} MB`;
    ratio = frac * 0.6;
  } else if (p?.phase === 'parse') {
    const frac = p.total ? p.loaded / p.total : 0;
    state = `解析 ${Math.round(frac * 100)}%`;
    ratio = 0.6 + frac * 0.4;
  }
  row.querySelector('.state').textContent = state;
  row.querySelector('.bar > i').style.width = `${ratio * 100}%`;
}

/* ---------- Search ---------- */

function MatchRanges(lower, tokens)
{
  const ranges = [];
  for (const t of tokens) {
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) ranges.push([i, i + t.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

// Render text that starts at absolute position `start`, wrapping parts covered by `ranges` in <mark>.
function Highlight(text, start, ranges)
{
  const end = start + text.length;
  let pos = start;
  let out = '';
  for (let [a, b] of ranges) {
    a = Math.max(a, pos);
    b = Math.min(b, end);
    if (a >= b) continue;
    out += Esc(text.slice(pos - start, a - start)) + '<mark>' + Esc(text.slice(a - start, b - start)) + '</mark>';
    pos = b;
  }
  return out + Esc(text.slice(pos - start));
}

function Search(game, query)
{
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];

  const whole = tokens.join(' ');
  const items = [];
  for (const file of game.data.files) {
    for (const list of [file.classes, file.functions]) {
      for (const item of list) {
        if (!tokens.every((t) => item.key.includes(t))) continue;
        // Matches only found in the arguments rank last.
        const rank = !tokens.every((t) => item.nameKey.includes(t)) ? 4
          : (item.short === whole || item.nameKey === whole) ? 0
          : item.short.startsWith(whole) ? 1
          : item.nameKey.startsWith(whole) ? 2 : 3;
        items.push({ item, rank });
      }
    }
  }

  items.sort((a, b) => a.rank - b.rank
    || (b.item.vtables ? 1 : 0) - (a.item.vtables ? 1 : 0)
    || a.item.nameKey.length - b.item.nameKey.length
    || (a.item.key < b.item.key ? -1 : 1));
  return items.map((x) => x.item);
}

function ResultHtml(game, item, tokens)
{
  const ranges = MatchRanges(item.key, tokens);
  if (item.vtables) {
    return `
      <a class="result" href="${ClassHref(game, item)}">
        <span class="tag cls">类</span>
        <span class="sym"><span class="n">${Highlight(item.name, 0, ranges)}</span></span>
        <span class="side"><span>${item.vtables[0].functions.length} 个虚函数</span><span class="file">${Esc(item.file.name)}</span></span>
      </a>`;
  }

  const { q, n, a } = item.sig;
  const row = VTableRows(item.owner).find((r) => r.fn === item);
  return `
    <a class="result" href="${ClassHref(game, item.owner, item)}">
      <span class="tag">函数</span>
      <span class="sym"><span class="q">${Highlight(q, 0, ranges)}</span><span class="n">${Highlight(n, q.length, ranges)}</span><span class="a">${Highlight(a, q.length + n.length, ranges)}</span></span>
      <span class="side">
        ${row ? `<span class="idx"><b>L</b>${row.linux}</span><span class="idx"><b>W</b>${row.windows ?? '-'}</span>` : ''}
        <span class="file">${Esc(item.file.name)}</span>
      </span>
    </a>`;
}

function RenderSearch(game, route)
{
  const state = game.data.search;
  if (route.q !== state.q) {
    state.q = route.q;
    state.limit = PAGE_SIZE;
    state.scroll = 0;
  }

  const files = game.data.files;
  const classCount = files.reduce((n, f) => n + f.classes.length, 0);
  const funcCount = files.reduce((n, f) => n + f.functions.length, 0);
  const failed = files.filter((f) => f.error);

  SetCrumbs(`<span>${Esc(game.name)}</span>`);
  document.title = `${game.name} · VTable`;
  $app.innerHTML = `
    <div class="search-box">${SEARCH_ICON}<input class="input" type="search" placeholder="搜索类或函数，空格分隔多个关键词" autocomplete="off" spellcheck="false"></div>
    <p class="hint"></p>
    <div class="results"></div>`;

  const $input = $app.querySelector('input');
  const $hint = $app.querySelector('.hint');
  const $results = $app.querySelector('.results');
  const failedHtml = failed.length ? ` · <span class="err">${failed.map((f) => Esc(`${f.name} 加载失败：${f.error}`)).join('，')}</span>` : '';
  let results = [];
  let tokens = [];
  let observer = null;

  const renderMore = () => {
    observer?.disconnect();
    $results.querySelector('.more')?.remove();
    const start = $results.children.length;
    $results.insertAdjacentHTML('beforeend', results.slice(start, state.limit).map((it) => ResultHtml(game, it, tokens)).join(''));
    if (results.length > state.limit) {
      $results.insertAdjacentHTML('beforeend', `<div class="more">已显示 ${state.limit} / ${results.length}，滚动加载更多</div>`);
      observer = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        state.limit += PAGE_SIZE;
        renderMore();
      }, { rootMargin: '400px' });
      observer.observe($results.querySelector('.more'));
    }
  };

  const run = () => {
    tokens = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    results = Search(game, state.q);
    $results.innerHTML = '';
    $hint.innerHTML = (tokens.length
      ? `找到 ${results.length} 条结果`
      : `${files.length} 个文件 · ${classCount} 个类 · ${funcCount} 个虚函数 · 按 <kbd>/</kbd> 聚焦搜索框`) + failedHtml;
    if (tokens.length && !results.length) $results.innerHTML = '<div class="empty">没有匹配的结果</div>';
    else renderMore();
  };

  let timer = 0;
  $input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = $input.value.trim();
      state.limit = PAGE_SIZE;
      history.replaceState(null, '', GameHref(game, state.q));
      run();
      window.scrollTo(0, 0);
    }, 80);
  });

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      $results.querySelector('.result')?.focus();
    } else if (e.key === 'Enter') {
      $results.querySelector('.result')?.click();
    }
  });

  $results.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const target = e.key === 'ArrowDown' ? document.activeElement.nextElementSibling : document.activeElement.previousElementSibling;
    if (target?.classList.contains('result')) target.focus();
    else if (e.key === 'ArrowUp') $input.focus();
  });

  $input.value = state.q;
  run();
  window.scrollTo(0, state.scroll);
  if (!state.scroll) $input.focus();

  leaveView = () => {
    observer?.disconnect();
    clearTimeout(timer);
    state.scroll = window.scrollY;
  };
}

/* ---------- Detail ---------- */

function RenderDetail(game, route)
{
  const file = game.data.files.find((f) => f.path === route.file);
  const cls = file?.classByName.get(route.cls);
  if (!cls) return RenderMessage('找不到类：' + route.cls);

  const rows = VTableRows(cls);
  const prefix = cls.name + '::';
  const searchHref = GameHref(game, game.data.search.q);

  SetCrumbs(`<a href="${searchHref}">${Esc(game.name)}</a><span class="mono">${Esc(cls.name)}</span>`);
  document.title = `${cls.name} · ${game.name} · VTable`;
  $app.innerHTML = `
    <div class="detail-head">
      <div>
        <h1>${Esc(cls.name)}</h1>
        <div class="meta"><span class="file">${Esc(file.name)}</span><span>${rows.length} 个虚函数</span></div>
      </div>
      <div class="search-box small">${SEARCH_ICON}<input class="input small" type="search" placeholder="过滤函数" autocomplete="off" spellcheck="false"></div>
    </div>
    ${(cls.hasMissingFunctions || cls.vtables.length > 1) ? '<div class="warn"><b>部分 Windows 索引可能不准确</b>：该类使用了本工具无法完全推算的 C++ 特性（纯虚函数或多重继承）。</div>' : ''}
    <table class="vtable">
      <tr><th class="num">Linux</th><th class="num">Windows</th><th>函数</th></tr>
      ${rows.map(({ fn, linux, windows }) => {
        const pure = fn.id === null;
        const sig = pure ? null : (fn.sig || SplitSignature(fn.name));
        const cssClass = [pure && 'pure', !pure && sig.q !== prefix && 'inherited', route.f && fn.id === route.f && 'hit'].filter(Boolean).join(' ');
        return `
          <tr class="${cssClass}" data-key="${Esc(fn.name.toLowerCase())}">
            <td class="num">${linux}</td>
            <td class="num">${windows ?? '<span class="none">-</span>'}</td>
            <td><span class="sym">${pure ? Esc(fn.name) : `<span class="q">${Esc(sig.q)}</span><span class="n">${Esc(sig.n)}</span><span class="a">${Esc(sig.a)}</span>`}</span></td>
          </tr>`;
      }).join('')}
    </table>`;

  const $filter = $app.querySelector('input');
  const $rows = [...$app.querySelectorAll('tr[data-key]')];
  $filter.addEventListener('input', () => {
    const tokens = $filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const tr of $rows) tr.hidden = !tokens.every((t) => tr.dataset.key.includes(t));
  });

  const hit = $app.querySelector('tr.hit');
  if (hit) hit.scrollIntoView({ block: 'center' });
  else window.scrollTo(0, 0);
}

/* ---------- Boot ---------- */

document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.target.matches('input, textarea')) return;
  const input = $app.querySelector('input');
  if (!input) return;
  e.preventDefault();
  input.focus();
  input.select();
});

window.addEventListener('hashchange', Render);

config = await (await fetch('games.json', { cache: 'no-cache' })).json();
Render();
