import { useEffect, useMemo, useState } from 'preact/hooks';
import { Markdown } from './Markdown';
import { JsonView, parseForTree } from './Json';
import { api, type TryResult } from './api';
import { buildUrl, deref, exampleFor, securityRequirements, serverUrls, toCurl, type Doc, type Operation } from './openapi';
import { Schema } from './Schema';
import { t } from './i18n';

export function OperationView({ doc, op, canTry, specName, server }: { doc: Doc; op: Operation; canTry: boolean; specName: string; server?: string }) {
  const body = op.op.requestBody ? deref(doc, op.op.requestBody) : null;
  const contentTypes = Object.keys(body?.content ?? {});
  const responses = Object.entries<any>(op.op.responses ?? {});
  const security = securityRequirements(doc, op.op);
  const byIn = (kind: string) => op.parameters.filter((p) => p.in === kind);

  return (
    <div>
      <div class="op-head">
        <h1>
          {op.summary} {op.webhook && <span class="webhook-badge">{t('webhook')}</span>}
          {op.deprecated && <span class="deprecated-badge">{t('deprecated')}</span>}
        </h1>
        <div class="op-path">
          <span class={`method lg ${op.method}`}>{op.method}</span>
          <span class="p">{op.path}</span>
          {op.op.operationId && <span class="tag">{op.op.operationId}</span>}
          {security.map((s) => (
            <span class="tag" title={JSON.stringify(s.scheme)}>
              🔒 {s.name}
            </span>
          ))}
        </div>
        {op.op.description && op.op.description !== op.summary && (
          <Markdown text={op.op.description} class="op-desc md" />
        )}
      </div>

      <div class="split">
        <div>
          {(['path', 'query', 'header', 'cookie'] as const).map((kind) =>
            byIn(kind).length ? (
              <>
                <h3 class="sec">{t(kind === 'path' ? 'paramsPath' : kind === 'query' ? 'paramsQuery' : kind === 'header' ? 'paramsHeader' : 'paramsCookie')}</h3>
                <div class="card">
                  <div class="card-b" style="padding:4px 14px">
                    {byIn(kind).map((p) => (
                      <div class="param">
                        <div class="name">
                          {p.name}
                          {p.required && <span class="req">*</span>}
                          <span class="meta">
                            <span class="type">{p.schema ? schemaLabel(doc, p.schema) : p.type ?? 'string'}</span>
                            {p.deprecated && ' · deprecated'}
                          </span>
                        </div>
                        <div class="desc">
                          {p.description}
                          {p.schema?.enum && <div class="mono" style="color:var(--text-3);font-size:11.5px">enum: {p.schema.enum.join(', ')}</div>}
                          {p.example !== undefined && <div class="mono" style="color:var(--text-3);font-size:11.5px">e.g. {JSON.stringify(p.example)}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null,
          )}

          {body && (
            <>
              <h3 class="sec">
                {op.webhook ? t('webhookPayload') : t('requestBody')} {body.required && <span class="tag req">{t('required')}</span>}
              </h3>
              <div class="card">
                <div class="card-b">
                  {body.description && (
                    <div style="margin-bottom:10px">
                      <Markdown text={body.description} />
                    </div>
                  )}
                  <BodyTabs doc={doc} content={body.content ?? {}} />
                </div>
              </div>
            </>
          )}

          <h3 class="sec">{t('responses')}</h3>
          <div class="card">
            <div class="card-b" style="padding:4px 14px">
              {responses.length === 0 && <div class="param">{t('noResponses')}</div>}
              {responses.map(([code, r]) => {
                const res = deref(doc, r);
                const content = res.content ?? {};
                const has = Object.keys(content).length > 0;
                return (
                  <div class="param" style="grid-template-columns:70px 1fr">
                    <div>
                      <span class={`status-pill s${code[0]}`}>{code}</span>
                    </div>
                    <div>
                      <div class="desc">{res.description}</div>
                      {res.headers && (
                        <div style="margin-top:6px;font-size:12px;color:var(--text-3)">
                          {t('responseHeaders')}: {Object.keys(res.headers).join(', ')}
                        </div>
                      )}
                      {has && (
                        <div style="margin-top:8px">
                          <BodyTabs doc={doc} content={content} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <CodeSamples specName={specName} op={op} />
        </div>

        <div class="sticky">
          {op.webhook ? (
            <div class="card">
              <div class="card-h">{t('webhook')}</div>
              <div class="card-b">
                <div class="notice info">{t('webhookNotice')}</div>
              </div>
            </div>
          ) : (
            <TryIt doc={doc} op={op} canTry={canTry} specName={specName} contentTypes={contentTypes} security={security} server={server} />
          )}
        </div>
      </div>
    </div>
  );
}

function schemaLabel(doc: Doc, s: any): string {
  const r = deref(doc, s);
  if (Array.isArray(r.type)) return r.type.join(' | ');
  if (r.type === 'array') return `${schemaLabel(doc, r.items)}[]`;
  return r.__refName ?? r.type ?? 'any';
}

function BodyTabs({ doc, content }: { doc: Doc; content: Record<string, any> }) {
  const types = Object.keys(content);
  const [ct, setCt] = useState(types[0]);
  const [view, setView] = useState<'schema' | 'example'>('schema');
  const media = content[ct] ?? {};
  const example = useMemo(() => {
    if (media.example !== undefined) return media.example;
    if (media.examples) {
      const first = deref(doc, Object.values<any>(media.examples)[0]);
      return first?.value;
    }
    return exampleFor(doc, media.schema);
  }, [ct, media]);

  return (
    <div>
      <div class="tabs">
        <button class={view === 'schema' ? 'active' : ''} onClick={() => setView('schema')}>
          {t('schemaTab')}
        </button>
        <button class={view === 'example' ? 'active' : ''} onClick={() => setView('example')}>
          {t('exampleTab')}
        </button>
        <span class="spacer" />
        {types.length > 1 ? (
          <select style="width:auto;padding:3px 8px;font-size:12px" value={ct} onChange={(e) => setCt((e.target as HTMLSelectElement).value)}>
            {types.map((t) => (
              <option value={t}>{t}</option>
            ))}
          </select>
        ) : (
          <span class="tag" style="align-self:center">
            {ct}
          </span>
        )}
      </div>
      {view === 'schema' ? (
        media.schema ? <Schema doc={doc} schema={media.schema} open /> : <div style="color:var(--text-3)">{t('noSchema')}</div>
      ) : typeof example === 'object' && example !== null ? (
        <JsonView value={example} />
      ) : (
        <pre>{typeof example === 'string' ? example : JSON.stringify(example, null, 2)}</pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Code samples
const SAMPLE_TABS: Array<[string, string]> = [
  ['curl', 'cURL'], ['fetch', 'fetch'], ['axios', 'axios'], ['python', 'Python'], ['go', 'Go'], ['http', '.http'],
];

/** Ready-to-paste snippets, generated by the core from the filtered spec. */
function CodeSamples({ specName, op }: { specName: string; op: Operation }) {
  const [samples, setSamples] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lang, setLang] = useState<string>(() => {
    try { return localStorage.getItem('ludin.sample-lang') || 'curl'; } catch { return 'curl'; }
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setSamples(null);
    setErr(null);
    api.samples(specName, op.method.toUpperCase(), op.path).then((r) => setSamples(r.samples)).catch((e) => setErr(e.message));
  }, [specName, op.method, op.path]);

  function pick(l: string) {
    setLang(l);
    try { localStorage.setItem('ludin.sample-lang', l); } catch { /* ignore */ }
  }
  function copy() {
    if (!samples) return;
    navigator.clipboard?.writeText(samples[lang] ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  if (err) return null; // samples are a convenience – never block the reference
  return (
    <>
      <h3 class="sec">{t('codeSamples')}</h3>
      <div class="card">
        <div class="card-b">
          <div class="tabs">
            {SAMPLE_TABS.map(([key, label]) => (
              <button class={lang === key ? 'active' : ''} onClick={() => pick(key)}>{label}</button>
            ))}
            <span class="spacer" />
            <button class="btn btn-sm btn-ghost" style="align-self:center" onClick={copy}>{copied ? t('copied') : t('copy')}</button>
          </div>
          {samples ? <pre>{samples[lang]}</pre> : <div style="padding:14px;text-align:center"><span class="spin" /></div>}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------- Copy a report
/** Header values worth hiding in something the user is about to paste elsewhere. */
const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key|x-auth-token)$/i;

function headerLines(headers: Record<string, string>): string {
  const entries = Object.entries(headers);
  if (!entries.length) return '  (none)';
  return entries.map(([k, v]) => `  ${k}: ${SENSITIVE_HEADER.test(k) ? '***' : v}`).join('\n');
}

/**
 * A self-contained account of one call — endpoint, request, response — for
 * pasting into a ticket or a chat with whoever runs the API. Credentials are
 * masked: this text is meant to leave the browser.
 */
function buildReport(args: {
  op: Operation;
  specName: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  result: TryResult;
}): string {
  const { op, specName, url, headers, body, result } = args;
  const res = result.body ?? (result.bodyBase64 ? `<binary, ${result.size ?? 0} bytes>` : '');
  return [
    `# ${op.method.toUpperCase()} ${op.path}${op.summary && op.summary !== op.path ? ` — ${op.summary}` : ''}`,
    `spec: ${specName}`,
    `time: ${new Date().toISOString()}`,
    '',
    '## Request',
    `${op.method.toUpperCase()} ${url}`,
    'headers:',
    headerLines(headers),
    ...(body ? ['body:', body] : []),
    '',
    '## Response',
    `${result.status || 'ERR'}${result.statusText ? ` ${result.statusText}` : ''} · ${result.ms} ms${result.size != null ? ` · ${result.size} B` : ''}`,
    ...(result.error ? ['error:', result.error] : []),
    'headers:',
    headerLines(result.headers ?? {}),
    ...(res ? ['body:', res] : []),
    ...(result.validation?.checked && result.validation.issues?.length
      ? ['', '## Schema mismatch', ...result.validation.issues.map((i) => `- ${i.path} ${i.message}`)]
      : []),
    '',
    '_Credentials are masked. Generated by ludin._',
  ].join('\n');
}

// --------------------------------------------------------------- Auth chaining
/**
 * Auth chaining: pull the token out of a login response and reuse it on every
 * later request. The value never leaves the browser — it goes to sessionStorage
 * under the security scheme's name, exactly where a hand-typed token would go.
 */
const TOKEN_KEYS = ['accesstoken', 'access_token', 'token', 'idtoken', 'id_token', 'jwt', 'authtoken', 'apikey', 'api_key'];

function findToken(v: unknown, depth = 0): { key: string; value: string } | null {
  if (!v || typeof v !== 'object' || depth > 4) return null;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && val && TOKEN_KEYS.includes(k.toLowerCase().replace(/-/g, '_'))) {
      return { key: k, value: val };
    }
  }
  for (const val of Object.values(v as Record<string, unknown>)) {
    const found = findToken(val, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Document security schemes that carry a token we can inject. */
function tokenSchemes(doc: Doc): string[] {
  return Object.entries<any>(doc.components?.securitySchemes ?? {})
    .filter(([, raw]) => {
      const sc = deref(doc, raw);
      return (
        (sc?.type === 'http' && sc.scheme === 'bearer') ||
        sc?.type === 'oauth2' ||
        sc?.type === 'openIdConnect' ||
        (sc?.type === 'apiKey' && sc.in === 'header')
      );
    })
    .map(([name]) => name);
}

const AUTO_CAPTURE_KEY = 'ludin.auth-capture';
const autoCaptureOn = () => {
  try { return localStorage.getItem(AUTO_CAPTURE_KEY) !== 'off'; } catch { return true; }
};
// ----------------------------------------------------------------- Try it out
interface TryDraft {
  values: Record<string, string>;
  bodyText: string;
  ct: string;
  extra: Array<[string, string]>;
}

interface HistoryEntry extends TryDraft {
  status: number;
  ms: number;
  at: number;
}

const draftKey = (spec: string, op: Operation) => `ludin.try:${spec}:${op.method} ${op.path}`;
const historyKey = (spec: string, op: Operation) => `ludin.history:${spec}:${op.method} ${op.path}`;

function loadJson<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; }
}
function saveJson(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
}

function TryIt({
  doc,
  op,
  canTry,
  specName,
  contentTypes,
  security,
  server: globalServer,
}: {
  doc: Doc;
  op: Operation;
  canTry: boolean;
  specName: string;
  contentTypes: string[];
  security: Array<{ name: string; scheme: any }>;
  server?: string;
}) {
  // The base URL is picked once, in the top bar, and applies to every operation.
  const server = globalServer ?? serverUrls(doc)[0];
  // Inputs survive navigation: the last draft for this operation wins over spec examples.
  const draft = loadJson<TryDraft>(draftKey(specName, op));
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (draft?.values) return draft.values;
    const v: Record<string, string> = {};
    for (const p of op.parameters) {
      const ex = p.example ?? p.schema?.example ?? p.schema?.default;
      if (ex !== undefined) v[`${p.in}:${p.name}`] = String(ex);
    }
    return v;
  });
  const [ct, setCt] = useState(draft?.ct ?? contentTypes[0] ?? 'application/json');
  const [bodyText, setBodyText] = useState(() => {
    if (draft?.bodyText !== undefined && draft.bodyText !== '') return draft.bodyText;
    const body = op.op.requestBody ? deref(doc, op.op.requestBody) : null;
    const media = body?.content?.[contentTypes[0]];
    if (!media) return '';
    const ex = media.example ?? (media.examples ? deref(doc, Object.values<any>(media.examples)[0])?.value : undefined) ?? exampleFor(doc, media.schema);
    return ex === undefined ? '' : typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2);
  });
  const [auth, setAuth] = useState<Record<string, string>>(() => loadAuth());
  const [extra, setExtra] = useState<Array<[string, string]>>(draft?.extra ?? []);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadJson<HistoryEntry[]>(historyKey(specName, op)) ?? []);
  const [autoCapture, setAutoCapture] = useState(autoCaptureOn);
  const [captured, setCaptured] = useState<{ key: string; value: string; applied: boolean } | null>(null);
  const schemeNames = useMemo(() => tokenSchemes(doc), [doc]);
  // The cookie jar for wherever this operation is sent; reloaded when the server changes.
  const targetOrigin = originOf(buildUrl(server, op.path, op.parameters, {}));
  const [jar, setJar] = useState<Record<string, string>>(() => loadJar(targetOrigin));
  useEffect(() => { setJar(loadJar(targetOrigin)); }, [targetOrigin]);
  const [cookiesGot, setCookiesGot] = useState<Array<{ name: string; value: string; expired: boolean }> | null>(null);
  const [pinned, setPinnedState] = useState<Pinned>(loadPinned);
  const [pinOpen, setPinOpen] = useState(false);
  function setPinned(next: Pinned) {
    setPinnedState(next);
    savePinned(next);
  }
  const pinnedCount = pinned.headers.filter(([k]) => k.trim()).length;
  const [envs, setEnvsState] = useState<Envs>(loadEnvs);
  const [varsOpen, setVarsOpen] = useState(false);
  function setEnvs(next: Envs) {
    setEnvsState(next);
    saveEnvs(next);
  }
  const activeVars = envs.envs[envs.active] ?? [];
  const vars = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of activeVars) if (k.trim()) out[k.trim()] = v;
    return out;
  }, [activeVars]);
  const varCount = Object.keys(vars).length;
  const r = (s: string) => substitute(s, vars);
  function setActiveVars(rows: Array<[string, string]>) {
    setEnvs({ ...envs, envs: { ...envs.envs, [envs.active]: rows } });
  }
  function addEnv() {
    const name = (prompt(t('varsEnvName')) ?? '').trim();
    if (!name || envs.envs[name]) return;
    setEnvs({ active: name, envs: { ...envs.envs, [name]: [] } });
  }
  function deleteEnv() {
    const names = Object.keys(envs.envs);
    if (names.length < 2) return;
    const rest = { ...envs.envs };
    delete rest[envs.active];
    setEnvs({ active: Object.keys(rest)[0], envs: rest });
  }

  function applyCookies(list: Array<{ name: string; value: string; expired: boolean }>) {
    const next = { ...jar };
    for (const c of list) {
      if (c.expired) delete next[c.name];
      else next[c.name] = c.value;
    }
    setJar(next);
    saveJar(targetOrigin, next);
    setCookiesGot(null);
  }

  function clearJar() {
    setJar({});
    saveJar(targetOrigin, {});
    setCookiesGot(null);
  }

  /** Store a captured token under every token-bearing scheme, so any operation picks it up. */
  function applyToken(value: string) {
    const next = { ...auth };
    for (const n of schemeNames) next[n] = value;
    setAuth(next);
    saveAuth(next);
    setCaptured((c) => (c ? { ...c, applied: true } : c));
  }

  function clearToken() {
    const next = { ...auth };
    for (const n of schemeNames) delete next[n];
    setAuth(next);
    saveAuth(next);
    setCaptured(null);
  }

  function toggleAutoCapture() {
    const next = !autoCapture;
    setAutoCapture(next);
    try { localStorage.setItem(AUTO_CAPTURE_KEY, next ? 'on' : 'off'); } catch { /* ignore */ }
  }

  useEffect(() => {
    saveJson(draftKey(specName, op), { values, bodyText, ct, extra } satisfies TryDraft);
  }, [values, bodyText, ct, extra]);

  function restore(h: HistoryEntry) {
    setValues(h.values);
    setBodyText(h.bodyText);
    setCt(h.ct);
    setExtra(h.extra);
  }
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [tab, setTab] = useState<'body' | 'headers' | 'curl'>('body');
  const [copied, setCopied] = useState<'body' | 'report' | null>(null);

  function copy(what: 'body' | 'report') {
    if (!result) return;
    const text = what === 'body'
      ? prettyBody(result)
      : buildReport({ op, specName, url: finalUrl, headers, body: resolvedBody, result });
    navigator.clipboard?.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1400);
  }

  // Everything below works on the request with `{{variables}}` already resolved.
  const rValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) out[k] = r(v);
    return out;
  }, [values, vars]);
  const url = buildUrl(r(server), op.path, op.parameters, rValues);
  const headers = useMemo(() => {
    const h: Record<string, string> = {};
    for (const p of op.parameters) {
      if (p.in === 'header' && rValues[`header:${p.name}`]) h[p.name] = rValues[`header:${p.name}`];
    }
    if (op.op.requestBody && bodyText) h['content-type'] = ct;
    for (const s of security) {
      const v = auth[s.name] ? r(auth[s.name]) : '';
      if (!v) continue;
      const sc = s.scheme;
      if (sc.type === 'http' && sc.scheme === 'bearer') h['authorization'] = `Bearer ${v}`;
      else if (sc.type === 'http' && sc.scheme === 'basic') h['authorization'] = `Basic ${btoa(v)}`;
      else if (sc.type === 'apiKey' && sc.in === 'header') h[sc.name] = v;
      else if (sc.type === 'oauth2' || sc.type === 'openIdConnect') h['authorization'] = `Bearer ${v}`;
    }
    // Pinned headers apply everywhere; an operation's own extra header still wins on a clash.
    if (pinned.on) for (const [k, v] of pinned.headers) if (k.trim()) h[k.trim()] = r(v);
    for (const [k, v] of extra) if (k) h[k] = r(v);
    return h;
  }, [op, rValues, bodyText, ct, security, auth, extra, pinned, vars]);

  const finalUrl = useMemo(() => {
    let u = url;
    for (const s of security) {
      const v = auth[s.name] ? r(auth[s.name]) : '';
      if (v && s.scheme.type === 'apiKey' && s.scheme.in === 'query') {
        u += (u.includes('?') ? '&' : '?') + `${encodeURIComponent(s.scheme.name)}=${encodeURIComponent(v)}`;
      }
    }
    return u;
  }, [url, security, auth, vars]);

  const hasBody = op.method !== 'get' && op.method !== 'head' && bodyText;
  const resolvedBody = hasBody ? r(bodyText) : null;

  async function send() {
    setBusy(true);
    setResult(null);
    setCaptured(null);
    setCookiesGot(null);
    try {
      // The jar for this origin, plus any apiKey-in-cookie scheme the person typed a value for.
      const cookies: Record<string, string> = { ...jar };
      for (const s of security) {
        const v = auth[s.name];
        if (v && s.scheme.type === 'apiKey' && s.scheme.in === 'cookie') cookies[s.scheme.name] = v;
      }
      const r = await api.try({
        method: op.method,
        url: finalUrl,
        headers,
        body: resolvedBody,
        spec: specName,
        op: { method: op.method, path: op.path },
        ...(Object.keys(cookies).length ? { cookies } : {}),
      });
      setResult(r);
      setTab('body');
      // Auth chaining: harvest a token from the response for later requests.
      const token = r.status >= 200 && r.status < 300 && schemeNames.length ? findToken(parseForTree(r.body)) : null;
      if (token) {
        setCaptured({ ...token, applied: false });
        if (autoCapture) applyToken(token.value);
      }
      // Cookie chaining: keep what the target set, drop what it expired.
      if (r.cookies?.length) {
        if (autoCapture) applyCookies(r.cookies);
        else setCookiesGot(r.cookies);
      }
      const entry: HistoryEntry = { values, bodyText, ct, extra, status: r.status, ms: r.ms, at: Date.now() };
      const next = [entry, ...history].slice(0, 20);
      setHistory(next);
      saveJson(historyKey(specName, op), next);
    } catch (e: any) {
      setResult({ status: 0, ms: 0, error: e.message });
    } finally {
      setBusy(false);
    }
  }

  function setVal(k: string, v: string) {
    setValues({ ...values, [k]: v });
  }
  function setAuthVal(k: string, v: string) {
    const next = { ...auth, [k]: v };
    setAuth(next);
    saveAuth(next);
  }

  const missing = op.parameters.filter((p) => p.required && !values[`${p.in}:${p.name}`]);

  return (
    <div class="card try">
      <div class="card-h">
        {t('tryItOut')}
        <span class="spacer" />
        {!canTry && <span class="tag">{t('readOnlyRole')}</span>}
      </div>
      <div class="card-b">
        <label class="auto-capture" title={t('autoCaptureHint')}>
          <input type="checkbox" checked={autoCapture} onChange={toggleAutoCapture} />
          {t('autoCapture')}
        </label>
        <label class="auto-capture" title={t('pinnedHeadersHint')}>
          <input type="checkbox" checked={pinned.on} onChange={() => setPinned({ ...pinned, on: !pinned.on })} />
          {t('pinnedHeaders')}{pinnedCount ? ` (${pinnedCount})` : ''}{' '}
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            style="height:20px;padding:0 6px"
            onClick={(e) => { e.preventDefault(); setPinOpen(!pinOpen); if (!pinOpen && !pinned.headers.length) setPinned({ ...pinned, headers: [['', '']] }); }}
          >
            {pinOpen ? t('pinnedDone') : t('pinnedEdit')}
          </button>
        </label>
        {pinOpen && (
          <div class="field pinned" style={pinned.on ? '' : 'opacity:.55'}>
            {pinned.headers.map(([k, v], i) => (
              <div class="kv">
                <input placeholder="X-Api-Key" value={k} onInput={(e) => setPinned({ ...pinned, headers: pinned.headers.map((x, j) => (j === i ? [(e.target as HTMLInputElement).value, x[1]] : x)) })} />
                <input placeholder="Value" value={v} onInput={(e) => setPinned({ ...pinned, headers: pinned.headers.map((x, j) => (j === i ? [x[0], (e.target as HTMLInputElement).value] : x)) })} />
                <button class="btn btn-sm btn-ghost" onClick={() => setPinned({ ...pinned, headers: pinned.headers.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
            <button class="btn btn-sm btn-ghost" style="height:20px;padding:0 6px" onClick={() => setPinned({ ...pinned, headers: [...pinned.headers, ['', '']] })}>
              {t('addHeader')}
            </button>
          </div>
        )}
        <div class="auto-capture" title={t('varsHint')}>
          <span>{t('vars')}</span>
          <select
            class="env-select"
            value={envs.active}
            onChange={(e) => {
              const name = (e.target as HTMLSelectElement).value;
              if (name === '__new__') { (e.target as HTMLSelectElement).value = envs.active; addEnv(); }
              else setEnvs({ ...envs, active: name });
            }}
          >
            {Object.keys(envs.envs).map((n) => <option value={n}>{n}</option>)}
            <option value="__new__">{t('varsEnvNew')}</option>
          </select>
          {varCount ? `(${varCount})` : ''}{' '}
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            style="height:20px;padding:0 6px"
            onClick={() => { setVarsOpen(!varsOpen); if (!varsOpen && !activeVars.length) setActiveVars([['', '']]); }}
          >
            {varsOpen ? t('pinnedDone') : t('pinnedEdit')}
          </button>
        </div>
        {varsOpen && (
          <div class="field vars">
            {activeVars.map(([k, v], i) => (
              <div class="kv">
                <input placeholder="baseUrl" value={k} onInput={(e) => setActiveVars(activeVars.map((x, j) => (j === i ? [(e.target as HTMLInputElement).value, x[1]] : x)))} />
                <input placeholder="Value" value={v} onInput={(e) => setActiveVars(activeVars.map((x, j) => (j === i ? [x[0], (e.target as HTMLInputElement).value] : x)))} />
                <button class="btn btn-sm btn-ghost" onClick={() => setActiveVars(activeVars.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <button class="btn btn-sm btn-ghost" style="height:20px;padding:0 6px" onClick={() => setActiveVars([...activeVars, ['', '']])}>
              {t('addHeader')}
            </button>
            {Object.keys(envs.envs).length > 1 && (
              <button class="btn btn-sm btn-ghost" style="height:20px;padding:0 6px;margin-left:6px" onClick={deleteEnv}>
                {t('varsEnvDelete', { name: envs.active })}
              </button>
            )}
          </div>
        )}
        {cookiesGot && cookiesGot.some((c) => !c.expired) ? (
          <div class="notice info" style="margin-bottom:8px">
            {t('cookiesFound', { n: cookiesGot.filter((c) => !c.expired).length, host: targetOrigin.replace(/^https?:\/\//, '') })}{' '}
            <button class="btn btn-sm" style="height:22px;padding:0 8px" onClick={() => applyCookies(cookiesGot)}>{t('tokenUse')}</button>
          </div>
        ) : Object.keys(jar).length > 0 ? (
          <div class="notice ok" style="margin-bottom:8px">
            {t('cookiesStored', { n: Object.keys(jar).length, host: targetOrigin.replace(/^https?:\/\//, '') })}{' '}
            <button class="btn btn-sm btn-ghost" style="height:20px;padding:0 6px" onClick={clearJar}>{t('tokenClear')}</button>
          </div>
        ) : null}
        {security.map((s) => (
          <div class="field">
            <label>
              🔒 {s.name}{' '}
              <span style="color:var(--text-3)">
                ({s.scheme.type}
                {s.scheme.scheme ? ` ${s.scheme.scheme}` : ''}
                {s.scheme.in ? ` ${s.scheme.in}:${s.scheme.name}` : ''})
              </span>
            </label>
            <input
              type="password"
              placeholder={s.scheme.scheme === 'basic' ? 'user:password' : 'token / key'}
              value={auth[s.name] ?? ''}
              onInput={(e) => setAuthVal(s.name, (e.target as HTMLInputElement).value)}
            />
          </div>
        ))}
        {op.parameters.map((p) => (
          <div class="field">
            <label>
              {p.name}
              {p.required && <span class="req">*</span>} <span style="color:var(--text-3)">{p.in}</span>
            </label>
            {p.schema?.enum ? (
              <select value={values[`${p.in}:${p.name}`] ?? ''} onChange={(e) => setVal(`${p.in}:${p.name}`, (e.target as HTMLSelectElement).value)}>
                <option value="">—</option>
                {p.schema.enum.map((v: any) => (
                  <option value={String(v)}>{String(v)}</option>
                ))}
              </select>
            ) : (
              <input
                placeholder={p.description ?? ''}
                value={values[`${p.in}:${p.name}`] ?? ''}
                onInput={(e) => setVal(`${p.in}:${p.name}`, (e.target as HTMLInputElement).value)}
              />
            )}
          </div>
        ))}
        {op.op.requestBody && (
          <div class="field">
            <label>
              {t('bodyField')}{' '}
              {contentTypes.length > 1 ? (
                <select style="width:auto;display:inline-block;padding:1px 6px;font-size:11px" value={ct} onChange={(e) => setCt((e.target as HTMLSelectElement).value)}>
                  {contentTypes.map((t) => (
                    <option value={t}>{t}</option>
                  ))}
                </select>
              ) : (
                <span style="color:var(--text-3)">{ct}</span>
              )}
            </label>
            <textarea value={bodyText} onInput={(e) => setBodyText((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
          </div>
        )}
        <div class="field">
          <label>
            {t('extraHeaders')}{' '}
            <button class="btn btn-sm btn-ghost" style="height:20px;padding:0 6px" onClick={() => setExtra([...extra, ['', '']])}>
              {t('addHeader')}
            </button>
          </label>
          {extra.map(([k, v], i) => (
            <div class="kv">
              <input placeholder="Header" value={k} onInput={(e) => setExtra(extra.map((x, j) => (j === i ? [(e.target as HTMLInputElement).value, x[1]] : x)))} />
              <input placeholder="Value" value={v} onInput={(e) => setExtra(extra.map((x, j) => (j === i ? [x[0], (e.target as HTMLInputElement).value] : x)))} />
              <button class="btn btn-sm btn-ghost" onClick={() => setExtra(extra.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
        </div>
        <div class="url">
          <b style="color:var(--text)">{op.method.toUpperCase()}</b> {finalUrl}
        </div>
        <div class="row2" style="margin-top:10px">
          <button class="btn btn-primary" disabled={!canTry || busy || missing.length > 0} onClick={send} title={missing.length ? t('missingFields', { names: missing.map((m) => m.name).join(', ') }) : ''}>
            {busy ? <span class="spin" style="border-top-color:#fff" /> : t('sendRequest')}
          </button>
          <button class="btn" onClick={() => navigator.clipboard?.writeText(toCurl(op.method, finalUrl, headers, resolvedBody))}>
            {t('copyCurl')}
          </button>
          {missing.length > 0 && <span style="font-size:12px;color:var(--text-3)">{t('fillFields', { names: missing.map((m) => m.name).join(', ') })}</span>}
        </div>
        {!canTry && <div class="notice info" style="margin-top:10px">{t('roleCannotTry')}</div>}

        {history.length > 0 && (
          <details class="try-history">
            <summary>{t('history')} <span class="count">{history.length}</span></summary>
            {history.map((h) => (
              <button class="try-history-item" title={t('historyRestore')} onClick={() => restore(h)}>
                <span class={`status-pill s${String(h.status)[0] || '0'}`}>{h.status || 'ERR'}</span>
                <span class="mono" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  {Object.values(h.values).join(' · ') || h.bodyText.slice(0, 40) || '—'}
                </span>
                <span style="margin-left:auto;color:var(--text-3);font-size:11px">{new Date(h.at).toLocaleTimeString()}</span>
              </button>
            ))}
          </details>
        )}
        {result && (
          <div>
            <div class="result-h">
              <span class={`status-pill s${String(result.status)[0]}`}>{result.status || 'ERR'}</span>
              {result.statusText}
              <span class="spacer" />
              {result.size != null && <span>{fmtBytes(result.size)}</span>}
              <span>{result.ms} ms</span>
              <button class="btn btn-sm btn-ghost" style="height:22px;padding:0 7px" onClick={() => copy('body')} title={t('copyResponseHint')}>
                {copied === 'body' ? t('copied') : t('copyResponse')}
              </button>
              <button class="btn btn-sm btn-ghost" style="height:22px;padding:0 7px" onClick={() => copy('report')} title={t('copyReportHint')}>
                {copied === 'report' ? t('copied') : t('copyReport')}
              </button>
            </div>
            {result.error && <div class="notice err">{result.error}</div>}
            {!result.error && <ValidationBadge v={result.validation} />}
            {captured && (
              <div class={`notice ${captured.applied ? 'ok' : 'info'}`} style="margin-top:8px">
                {captured.applied ? (
                  <>
                    {t('tokenCaptured', { key: captured.key })}{' '}
                    <button class="btn btn-sm btn-ghost" style="height:20px;padding:0 6px" onClick={clearToken}>{t('tokenClear')}</button>
                  </>
                ) : (
                  <>
                    {t('tokenFound', { key: captured.key })}{' '}
                    <button class="btn btn-sm" style="height:22px;padding:0 8px" onClick={() => applyToken(captured.value)}>{t('tokenUse')}</button>
                  </>
                )}
              </div>
            )}
            {!result.error && (
              <>
                <div class="tabs">
                  <button class={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>
                    {t('bodyTab')}
                  </button>
                  <button class={tab === 'headers' ? 'active' : ''} onClick={() => setTab('headers')}>
                    {t('headersTab')}
                  </button>
                  <button class={tab === 'curl' ? 'active' : ''} onClick={() => setTab('curl')}>
                    cURL
                  </button>
                </div>
                {tab === 'body' && (parseForTree(result.body) != null
                  ? <JsonView value={parseForTree(result.body)} />
                  : <pre>{prettyBody(result)}</pre>)}
                {tab === 'headers' && (
                  <pre>
                    {Object.entries(result.headers ?? {})
                      .map(([k, v]) => `${k}: ${v}`)
                      .join('\n')}
                  </pre>
                )}
                {tab === 'curl' && <pre>{toCurl(op.method, finalUrl, headers, resolvedBody)}</pre>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Whether the live response matches the documented schema (validated in the core). */
function ValidationBadge({ v }: { v: TryResult['validation'] }) {
  // A status the document never mentions is drift too — saying nothing would
  // let the absence of a badge read as "the response matches".
  if (v?.reason === 'undocumented_status') {
    return (
      <div class="notice warn" style="margin-top:8px">
        {t('undocumentedStatus', { status: String(v.status ?? ''), documented: (v.documented ?? []).join(', ') })}
      </div>
    );
  }
  if (!v?.checked) return null;
  if (!v.issues?.length) {
    return <div class="notice ok" style="margin-top:8px">{t('validationOk')}</div>;
  }
  return (
    <div class="notice warn" style="margin-top:8px">
      <b>{t('validationDiff')}</b>
      <ul style="margin:6px 0 0;padding-left:18px">
        {v.issues.slice(0, 8).map((i) => (
          <li><code>{i.path}</code> — {i.message}</li>
        ))}
        {v.issues.length > 8 && <li>{t('andMore', { n: v.issues.length - 8 })}</li>}
      </ul>
    </div>
  );
}

function prettyBody(r: TryResult): string {
  if (r.body == null) return r.bodyBase64 ? `<binary ${fmtBytes(r.size ?? 0)}>` : '';
  try {
    return JSON.stringify(JSON.parse(r.body), null, 2);
  } catch {
    return r.body;
  }
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function loadAuth(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem('ludin.auth') || '{}');
  } catch {
    return {};
  }
}
function saveAuth(v: Record<string, string>) {
  try {
    sessionStorage.setItem('ludin.auth', JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/**
 * Cookie chaining, the session-cookie twin of token capture: cookies a target
 * hands out on a Try-it-out response (a login) are kept per origin, in this
 * tab only, and sent back with every later call to that origin. The proxy makes
 * the call, so the target may live on any origin – not just the docs' own.
 */
function originOf(url: string): string {
  try { return new URL(url, location.href).origin; } catch { return ''; }
}
function loadJar(origin: string): Record<string, string> {
  try {
    return origin ? JSON.parse(sessionStorage.getItem(`ludin.cookies:${origin}`) || '{}') : {};
  } catch {
    return {};
  }
}
/**
 * Pinned headers: a small set of headers sent with every request of every
 * operation – an API key the spec never declared, a tenant id, a feature flag.
 * One switch turns them all off without losing them. Kept in localStorage like
 * the per-operation drafts, and headers only: a body or query has no meaning
 * across operations.
 */
interface Pinned { on: boolean; headers: Array<[string, string]> }
const PINNED_KEY = 'ludin.pinned-headers';
function loadPinned(): Pinned {
  const v = loadJson<Partial<Pinned>>(PINNED_KEY);
  return { on: v?.on !== false, headers: Array.isArray(v?.headers) ? v.headers : [] };
}
function savePinned(p: Pinned) {
  saveJson(PINNED_KEY, p);
}

/**
 * Environments: named sets of variables, one active at a time, usable as
 * `{{name}}` anywhere in a request – path and query values, headers, the body,
 * pinned headers, auth fields. Switching the environment switches the whole
 * set, the way a dev / staging / prod toggle should. Unknown names are left
 * as typed, so a literal `{{...}}` in a body still goes through.
 */
interface Envs { active: string; envs: Record<string, Array<[string, string]>> }
const VARS_KEY = 'ludin.vars';
const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
function loadEnvs(): Envs {
  const v = loadJson<Partial<Envs>>(VARS_KEY);
  const envs = v?.envs && typeof v.envs === 'object' && Object.keys(v.envs).length ? v.envs : { default: [] };
  const active = v?.active && envs[v.active] ? v.active : Object.keys(envs)[0];
  return { active, envs };
}
function saveEnvs(e: Envs) {
  saveJson(VARS_KEY, e);
}
function substitute(s: string, vars: Record<string, string>): string {
  return s.replace(VAR_RE, (m, k: string) => (k in vars ? vars[k] : m));
}

function saveJar(origin: string, jar: Record<string, string>) {
  try {
    if (Object.keys(jar).length) sessionStorage.setItem(`ludin.cookies:${origin}`, JSON.stringify(jar));
    else sessionStorage.removeItem(`ludin.cookies:${origin}`);
  } catch {
    /* ignore */
  }
}
