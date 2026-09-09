import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, type Me } from './api';
import { boot, getMode, setMode, type Mode } from './config';
import { groupOperations, serverUrls, type Doc, type Operation, type TagGroup } from './openapi';
import { Brand } from './Brand';
import { OperationView } from './Operation';
import { Admin } from './Admin';
import { Readme } from './Readme';
import { Overview } from './Overview';
import { Palette } from './Palette';
import { LOCALES, getLang, setLang, t } from './i18n';

type Route =
  | { kind: 'overview' }
  | { kind: 'op'; id: string }
  | { kind: 'admin' }
  | { kind: 'readme' }
  | { kind: 'schema'; name: string };

function parseHash(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h === 'admin') return { kind: 'admin' };
  if (h === 'readme') return { kind: 'readme' };
  if (h.startsWith('op/')) return { kind: 'op', id: h.slice(3) };
  if (h.startsWith('schema/')) return { kind: 'schema', name: h.slice(7) };
  return { kind: 'overview' };
}

export function Docs({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [specs, setSpecs] = useState<Array<{ name: string }>>([]);
  const [specName, setSpecName] = useState<string>(() => {
    try {
      return localStorage.getItem('ludin.spec') || '';
    } catch {
      return '';
    }
  });
  const [doc, setDoc] = useState<Doc | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(parseHash());
  const [q, setQ] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [mode, setModeState] = useState<Mode>(getMode());
  const [palette, setPalette] = useState(false);
  // Deliberately not persisted: every visit starts with summaries, URL mode is a session choice.
  const [navLabel, setNavLabel] = useState<'summary' | 'path'>('summary');
  const [sortMethod, setSortMethod] = useState(false);
  const [pins, setPins] = useState<string[]>([]);
  useEffect(() => {
    try { setPins(JSON.parse(localStorage.getItem(`ludin.pins:${specName}`) ?? '[]')); } catch { setPins([]); }
  }, [specName]);
  function togglePin(id: string) {
    const next = pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
    setPins(next);
    try { localStorage.setItem(`ludin.pins:${specName}`, JSON.stringify(next)); } catch { /* ignore */ }
  }
  const [sideW, setSideW] = useState(() => {
    try {
      const n = parseInt(localStorage.getItem('ludin.sidebar-w') ?? '', 10);
      return n >= 220 && n <= 560 ? n : 300;
    } catch { return 300; }
  });
  const [server, setServerState] = useState('');
  const readme = me.readme && boot.readme ? { label: me.readme.label, url: boot.readme.url } : null;

  const servers = useMemo(() => (doc ? serverUrls(doc) : []), [doc]);
  useEffect(() => {
    if (!servers.length) return;
    let saved = '';
    try { saved = localStorage.getItem(`ludin.server:${specName}`) ?? ''; } catch { /* ignore */ }
    setServerState(servers.includes(saved) ? saved : servers[0]);
  }, [servers, specName]);

  function setServer(v: string) {
    setServerState(v);
    try { localStorage.setItem(`ludin.server:${specName}`, v); } catch { /* ignore */ }
  }

  function toggleNavLabel() {
    setNavLabel(navLabel === 'summary' ? 'path' : 'summary');
  }

  function startResize(down: PointerEvent) {
    down.preventDefault();
    const move = (e: PointerEvent) => setSideW(Math.min(560, Math.max(220, e.clientX)));
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem('ludin.sidebar-w', String(Math.min(560, Math.max(220, e.clientX)))); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  useEffect(() => {
    api.specs().then((r) => {
      setSpecs(r.specs);
      if (!r.specs.some((s) => s.name === specName)) setSpecName(r.specs[0]?.name ?? '');
    });
  }, []);

  useEffect(() => {
    if (!specName) return;
    setDoc(null);
    setLoadErr(null);
    api
      .spec(specName)
      .then(setDoc)
      .catch((e) => setLoadErr(e.message));
    try {
      localStorage.setItem('ludin.spec', specName);
    } catch {
      /* ignore */
    }
  }, [specName]);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      setNavOpen(false);
      setMenu(false);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (e.key === 'Escape') setMenu(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.menu')) setMenu(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, []);

  const groups: TagGroup[] = useMemo(() => (doc ? groupOperations(doc) : []), [doc]);
  const allOps = useMemo(() => groups.flatMap((g) => g.operations), [groups]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => ({
        ...g,
        operations: g.operations.filter(
          (o) =>
            o.path.toLowerCase().includes(needle) ||
            o.summary.toLowerCase().includes(needle) ||
            o.id.toLowerCase().includes(needle) ||
            o.method.includes(needle) ||
            g.name.toLowerCase().includes(needle),
        ),
      }))
      .filter((g) => g.operations.length);
  }, [groups, q]);

  const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'];
  const sorted = useMemo(() => {
    if (!sortMethod) return filtered;
    const rank = (m: string) => { const i = METHOD_ORDER.indexOf(m); return i === -1 ? METHOD_ORDER.length : i; };
    return filtered.map((g) => ({
      ...g,
      operations: [...g.operations].sort((a, b) => rank(a.method) - rank(b.method) || a.path.localeCompare(b.path)),
    }));
  }, [filtered, sortMethod]);

  const pinnedOps = useMemo(() => pins.map((id) => allOps.find((o) => o.id === id)).filter(Boolean) as Operation[], [pins, allOps]);

  const current: Operation | undefined = route.kind === 'op' ? allOps.find((o) => o.id === route.id) : undefined;
  const can = (p: string) => me.permissions.includes(p);
  const schemas = doc?.components?.schemas ?? {};

  function changeMode(m: Mode) {
    setMode(m);
    setModeState(m);
  }

  function navItem(o: Operation) {
    const pinned = pins.includes(o.id);
    return (
      <a
        href={`#/op/${encodeURIComponent(o.id)}`}
        class={`nav-item ${current?.id === o.id ? 'active' : ''} ${o.deprecated ? 'deprecated' : ''}`}
        title={`${o.method.toUpperCase()} ${o.path}${o.summary && o.summary !== o.path ? ` — ${o.summary}` : ''}`}
      >
        <span class={`method ${o.method}`}>{o.method}</span>
        <span class="path">
          {navLabel === 'path' || !o.summary || o.summary === `${o.method.toUpperCase()} ${o.path}` ? o.path : o.summary}
        </span>
        <span
          class={`pin ${pinned ? 'on' : ''}`}
          title={pinned ? t('unpin') : t('pin')}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePin(o.id); }}
        >
          {pinned ? '★' : '☆'}
        </span>
      </a>
    );
  }

  return (
    <div class="shell" style={`--sidebar-w:${sideW}px`}>
      <header class="topbar">
        <button class="btn btn-ghost btn-icon menu-btn" onClick={() => setNavOpen(!navOpen)} aria-label="Menu">
          ☰
        </button>
        <a href="#/" style="color:inherit;min-width:0">
          <Brand />
        </a>
        {doc?.info?.version && <span class="chip">v{doc.info.version}</span>}
        {specs.length > 1 && (
          <select style="width:auto" value={specName} onChange={(e) => setSpecName((e.target as HTMLSelectElement).value)}>
            {specs.map((s) => (
              <option value={s.name}>{s.name}</option>
            ))}
          </select>
        )}
        {servers.length > 1 && (
          <select
            class="server-select"
            style="width:auto;max-width:260px;font-family:var(--mono);font-size:12px"
            title={t('serverField')}
            value={server}
            onChange={(e) => setServer((e.target as HTMLSelectElement).value)}
          >
            {servers.map((u) => (
              <option value={u}>{u || '(relative)'}</option>
            ))}
          </select>
        )}
        <span class="spacer" />
        {readme && (
          <a href="#/readme" class={`btn btn-sm ${route.kind === 'readme' ? 'btn-primary' : 'btn-ghost'}`}>
            {readme.label}
          </a>
        )}
        {can('admin:read') && (
          <a href="#/admin" class={`btn btn-sm ${route.kind === 'admin' ? 'btn-primary' : 'btn-ghost'}`}>
            {t('admin')}
          </a>
        )}
        <div class="menu">
          <button class="btn btn-sm" onClick={() => setMenu(!menu)}>
            <span class="chip" style="padding:0 6px;border:0;background:none">
              <span class="dot" />
              {me.anonymous ? t('ipAccess') : me.user?.name || me.user?.email}
            </span>
            <span class="role-badge">{me.user?.role}</span>
          </button>
          {menu && (
            <div class="menu-pop">
              <div class="who">
                <b>{me.user?.name || me.user?.email}</b>
                <span>
                  {me.user?.email} · {me.user?.role}
                </span>
              </div>
              <div style="padding:6px 10px;display:flex;justify-content:space-between;align-items:center;font-size:12.5px">
                {t('theme')}
                <span class="seg">
                  {(['light', 'system', 'dark'] as Mode[]).map((m) => (
                    <button class={mode === m ? 'on' : ''} onClick={() => changeMode(m)}>
                      {m === 'light' ? t('themeLight') : m === 'dark' ? t('themeDark') : t('themeSystem')}
                    </button>
                  ))}
                </span>
              </div>
              <div style="padding:6px 10px;display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px">
                {t('language')}
                <select style="width:auto;padding:3px 8px;font-size:12px" value={getLang()} onChange={(e) => setLang((e.target as HTMLSelectElement).value)}>
                  {LOCALES.map(([code, name]) => (
                    <option value={code}>{name}</option>
                  ))}
                </select>
              </div>
              {me.authEnabled && !me.anonymous && <button onClick={onLogout}>{t('signOut')}</button>}
            </div>
          )}
        </div>
      </header>

      <aside class={`sidebar ${navOpen ? 'open' : ''}`}>
        <div class="search">
          <input id="search" placeholder={t('filterEndpoints')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          <button class="btn btn-sm btn-ghost" onClick={() => setPalette(true)} title={t('searchTooltip')}>
            ⌘K
          </button>
          <button
            class={`btn btn-sm btn-ghost nav-label-toggle ${navLabel === 'path' ? 'on' : ''}`}
            onClick={toggleNavLabel}
            title={navLabel === 'path' ? t('showSummaries') : t('showUrls')}
          >
            URL
          </button>
          <button
            class={`btn btn-sm btn-ghost nav-label-toggle ${sortMethod ? 'on' : ''}`}
            onClick={() => setSortMethod(!sortMethod)}
            title={sortMethod ? t('sortOriginal') : t('sortByMethod')}
          >
            ⇅
          </button>
        </div>
        <nav class="nav">
          {loadErr && <div class="notice err">{loadErr}</div>}
          {!doc && !loadErr && (
            <div style="padding:20px;text-align:center">
              <span class="spin" />
            </div>
          )}
          {pinnedOps.length > 0 && (
            <details class="nav-group" open>
              <summary>
                <span class="caret">▸</span>★ {t('pinned')}
                <span class="count">{pinnedOps.length}</span>
              </summary>
              {pinnedOps.map(navItem)}
            </details>
          )}
          {sorted.map((g) => (
            <details class="nav-group" open>
              <summary>
                <span class="caret">▸</span>
                {g.name}
                <span class="count">{g.operations.length}</span>
              </summary>
              {g.operations.map(navItem)}
            </details>
          ))}
          {doc && Object.keys(schemas).length > 0 && (
            <details class="nav-group">
              <summary>
                <span class="caret">▸</span>{t('schemasGroup')}<span class="count">{Object.keys(schemas).length}</span>
              </summary>
              {Object.keys(schemas)
                .filter((n) => !q || n.toLowerCase().includes(q.toLowerCase()))
                .map((n) => (
                  <a href={`#/schema/${encodeURIComponent(n)}`} class={`nav-item ${route.kind === 'schema' && route.name === n ? 'active' : ''}`}>
                    <span class="path">{n}</span>
                  </a>
                ))}
            </details>
          )}
        </nav>
        <div class="sidebar-foot">
          <span>
            {t('endpointsCount', { n: allOps.length })}
          </span>
          <span>ludin {boot.version ?? ''}</span>
        </div>
        <div class="sidebar-resize" onPointerDown={startResize} title="Drag to resize" />
      </aside>

      <main class="main">
        {route.kind === 'readme' && readme ? (
          <Readme label={readme.label} url={readme.url} />
        ) : (
        <div class="content">
          {route.kind === 'admin' && can('admin:read') ? (
            <Admin />
          ) : route.kind === 'op' ? (
            doc && current ? (
              <OperationView key={current.id} doc={doc} op={current} canTry={can('docs:try')} specName={specName} server={server} />
            ) : doc ? (
              <div class="empty">
                <h2>{t('endpointNotFound')}</h2>
                <p>{t('endpointNotFoundHint')}</p>
              </div>
            ) : null
          ) : route.kind === 'schema' ? (
            doc ? <Overview doc={doc} groups={groups} schemaName={route.name} specName={specName} /> : null
          ) : doc ? (
            <Overview doc={doc} groups={groups} specName={specName} />
          ) : null}
        </div>
        )}
      </main>
      {palette && specName && <Palette specName={specName} onClose={() => setPalette(false)} />}
    </div>
  );
}
