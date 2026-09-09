import { useEffect, useMemo, useState } from 'preact/hooks';
import { Markdown } from './Markdown';
import { JsonView, parseForTree } from './Json';
import { api, type TryResult } from './api';
import { buildUrl, deref, exampleFor, securityRequirements, serverUrls, toCurl, type Doc, type Operation } from './openapi';
import { Schema } from './Schema';
import { t } from './i18n';

export function OperationView({ doc, op, canTry, specName }: { doc: Doc; op: Operation; canTry: boolean; specName: string }) {
  const body = op.op.requestBody ? deref(doc, op.op.requestBody) : null;
  const contentTypes = Object.keys(body?.content ?? {});
  const responses = Object.entries<any>(op.op.responses ?? {});
  const security = securityRequirements(doc, op.op);
  const byIn = (kind: string) => op.parameters.filter((p) => p.in === kind);

  return (
    <div>
      <div class="op-head">
        <h1>
          {op.summary} {op.deprecated && <span class="deprecated-badge">{t('deprecated')}</span>}
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
                {t('requestBody')} {body.required && <span class="tag req">{t('required')}</span>}
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
          <TryIt doc={doc} op={op} canTry={canTry} specName={specName} contentTypes={contentTypes} security={security} />
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

// ----------------------------------------------------------------- Try it out
function TryIt({
  doc,
  op,
  canTry,
  specName,
  contentTypes,
  security,
}: {
  doc: Doc;
  op: Operation;
  canTry: boolean;
  specName: string;
  contentTypes: string[];
  security: Array<{ name: string; scheme: any }>;
}) {
  const servers = serverUrls(doc);
  const [server, setServer] = useState(servers[0]);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const p of op.parameters) {
      const ex = p.example ?? p.schema?.example ?? p.schema?.default;
      if (ex !== undefined) v[`${p.in}:${p.name}`] = String(ex);
    }
    return v;
  });
  const [ct, setCt] = useState(contentTypes[0] ?? 'application/json');
  const [bodyText, setBodyText] = useState(() => {
    const body = op.op.requestBody ? deref(doc, op.op.requestBody) : null;
    const media = body?.content?.[contentTypes[0]];
    if (!media) return '';
    const ex = media.example ?? (media.examples ? deref(doc, Object.values<any>(media.examples)[0])?.value : undefined) ?? exampleFor(doc, media.schema);
    return ex === undefined ? '' : typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2);
  });
  const [auth, setAuth] = useState<Record<string, string>>(() => loadAuth());
  const [extra, setExtra] = useState<Array<[string, string]>>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [tab, setTab] = useState<'body' | 'headers' | 'curl'>('body');

  const url = buildUrl(server, op.path, op.parameters, values);
  const headers = useMemo(() => {
    const h: Record<string, string> = {};
    for (const p of op.parameters) {
      if (p.in === 'header' && values[`header:${p.name}`]) h[p.name] = values[`header:${p.name}`];
    }
    if (op.op.requestBody && bodyText) h['content-type'] = ct;
    for (const s of security) {
      const v = auth[s.name];
      if (!v) continue;
      const sc = s.scheme;
      if (sc.type === 'http' && sc.scheme === 'bearer') h['authorization'] = `Bearer ${v}`;
      else if (sc.type === 'http' && sc.scheme === 'basic') h['authorization'] = `Basic ${btoa(v)}`;
      else if (sc.type === 'apiKey' && sc.in === 'header') h[sc.name] = v;
      else if (sc.type === 'oauth2' || sc.type === 'openIdConnect') h['authorization'] = `Bearer ${v}`;
    }
    for (const [k, v] of extra) if (k) h[k] = v;
    return h;
  }, [op, values, bodyText, ct, security, auth, extra]);

  const finalUrl = useMemo(() => {
    let u = url;
    for (const s of security) {
      const v = auth[s.name];
      if (v && s.scheme.type === 'apiKey' && s.scheme.in === 'query') {
        u += (u.includes('?') ? '&' : '?') + `${encodeURIComponent(s.scheme.name)}=${encodeURIComponent(v)}`;
      }
    }
    return u;
  }, [url, security, auth]);

  const hasBody = op.method !== 'get' && op.method !== 'head' && bodyText;

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.try({
        method: op.method,
        url: finalUrl,
        headers,
        body: hasBody ? bodyText : null,
        spec: specName,
        op: { method: op.method, path: op.path },
      });
      setResult(r);
      setTab('body');
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
        {servers.length > 1 && (
          <div class="field">
            <label>{t('serverField')}</label>
            <select value={server} onChange={(e) => setServer((e.target as HTMLSelectElement).value)}>
              {servers.map((s) => (
                <option value={s}>{s || '(relative)'}</option>
              ))}
            </select>
          </div>
        )}
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
          <button class="btn" onClick={() => navigator.clipboard?.writeText(toCurl(op.method, finalUrl, headers, hasBody ? bodyText : null))}>
            {t('copyCurl')}
          </button>
          {missing.length > 0 && <span style="font-size:12px;color:var(--text-3)">{t('fillFields', { names: missing.map((m) => m.name).join(', ') })}</span>}
        </div>
        {!canTry && <div class="notice info" style="margin-top:10px">{t('roleCannotTry')}</div>}

        {result && (
          <div>
            <div class="result-h">
              <span class={`status-pill s${String(result.status)[0]}`}>{result.status || 'ERR'}</span>
              {result.statusText}
              <span class="spacer" />
              {result.size != null && <span>{fmtBytes(result.size)}</span>}
              <span>{result.ms} ms</span>
            </div>
            {result.error && <div class="notice err">{result.error}</div>}
            {!result.error && <ValidationBadge v={result.validation} />}
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
                {tab === 'curl' && <pre>{toCurl(op.method, finalUrl, headers, hasBody ? bodyText : null)}</pre>}
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
