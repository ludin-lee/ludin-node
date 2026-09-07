import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, type Me } from './api';
import { boot, getMode, setMode, type Mode } from './config';
import { groupOperations, type Doc, type Operation, type TagGroup } from './openapi';
import { Brand } from './Brand';
import { OperationView } from './Operation';
import { Admin } from './Admin';
import { Readme } from './Readme';
import { Overview } from './Overview';

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
  const readme = me.readme && boot.readme ? { label: me.readme.label, url: boot.readme.url } : null;

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
        (document.getElementById('search') as HTMLInputElement | null)?.focus();
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

  const current: Operation | undefined = route.kind === 'op' ? allOps.find((o) => o.id === route.id) : undefined;
  const can = (p: string) => me.permissions.includes(p);
  const schemas = doc?.components?.schemas ?? {};

  function changeMode(m: Mode) {
    setMode(m);
    setModeState(m);
  }

  return (
    <div class="shell">
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
        <span class="spacer" />
        {readme && (
          <a href="#/readme" class={`btn btn-sm ${route.kind === 'readme' ? 'btn-primary' : 'btn-ghost'}`}>
            {readme.label}
          </a>
        )}
        {can('admin:read') && (
          <a href="#/admin" class={`btn btn-sm ${route.kind === 'admin' ? 'btn-primary' : 'btn-ghost'}`}>
            Admin
          </a>
        )}
        <div class="menu">
          <button class="btn btn-sm" onClick={() => setMenu(!menu)}>
            <span class="chip" style="padding:0 6px;border:0;background:none">
              <span class="dot" />
              {me.anonymous ? 'IP access' : me.user?.name || me.user?.email}
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
                Theme
                <span class="seg">
                  {(['light', 'system', 'dark'] as Mode[]).map((m) => (
                    <button class={mode === m ? 'on' : ''} onClick={() => changeMode(m)}>
                      {m}
                    </button>
                  ))}
                </span>
              </div>
              {me.authEnabled && !me.anonymous && <button onClick={onLogout}>Sign out</button>}
            </div>
          )}
        </div>
      </header>

      <aside class={`sidebar ${navOpen ? 'open' : ''}`}>
        <div class="search">
          <input id="search" placeholder="Search endpoints…   ⌘K" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        <nav class="nav">
          {loadErr && <div class="notice err">{loadErr}</div>}
          {!doc && !loadErr && (
            <div style="padding:20px;text-align:center">
              <span class="spin" />
            </div>
          )}
          {filtered.map((g) => (
            <details class="nav-group" open>
              <summary>
                <span class="caret">▸</span>
                {g.name}
                <span class="count">{g.operations.length}</span>
              </summary>
              {g.operations.map((o) => (
                <a
                  href={`#/op/${encodeURIComponent(o.id)}`}
                  class={`nav-item ${current?.id === o.id ? 'active' : ''} ${o.deprecated ? 'deprecated' : ''}`}
                  title={o.summary}
                >
                  <span class={`method ${o.method}`}>{o.method}</span>
                  <span class="path">{o.path}</span>
                </a>
              ))}
            </details>
          ))}
          {doc && Object.keys(schemas).length > 0 && (
            <details class="nav-group">
              <summary>
                <span class="caret">▸</span>Schemas<span class="count">{Object.keys(schemas).length}</span>
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
            {allOps.length} endpoints
          </span>
          <span>ludin {boot.version ?? ''}</span>
        </div>
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
              <OperationView key={current.id} doc={doc} op={current} canTry={can('docs:try')} specName={specName} />
            ) : doc ? (
              <div class="empty">
                <h2>Endpoint not found</h2>
                <p>It may be hidden for your role or removed from the spec.</p>
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
    </div>
  );
}
