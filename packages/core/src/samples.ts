import { deref, exampleFromSchema } from './schema.js';
import type { OpenApiDoc } from './spec.js';

/**
 * Code sample generation (spec §6, v0.3). Samples are built in the core from
 * the role-filtered document, so an operation someone may not see never yields
 * a sample either — and the UI only renders strings.
 */

export const SAMPLE_LANGUAGES = ['curl', 'fetch', 'axios', 'python', 'go', 'http'] as const;
export type SampleLanguage = (typeof SAMPLE_LANGUAGES)[number];

export interface SampleInput {
  method: string;           // upper case
  url: string;              // full URL with path params filled in
  headers: Array<[string, string]>;
  body: string | null;      // pretty JSON, or null
}

/** Resolve one operation into the concrete request the samples describe. */
export function buildSampleInput(
  doc: OpenApiDoc,
  method: string,
  path: string,
  server?: string,
): SampleInput | null {
  const item = doc.paths?.[path];
  const op = item?.[method.toLowerCase()];
  if (!op) return null;

  const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: any) => deref(doc, p));
  let filledPath = path;
  const query: string[] = [];
  const headers: Array<[string, string]> = [];

  for (const p of params) {
    if (!p || typeof p !== 'object') continue;
    const value = p.example ?? exampleFromSchema(doc, p.schema ?? {}) ?? 'value';
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (p.in === 'path') filledPath = filledPath.replace(`{${p.name}}`, encodeURIComponent(str));
    else if (p.in === 'query' && p.required) query.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(str)}`);
    else if (p.in === 'header' && p.required) headers.push([p.name, str]);
  }

  // Auth header from the effective security requirement (first scheme wins).
  const requirement = (op.security ?? doc.security ?? [])[0];
  const schemeName = requirement ? Object.keys(requirement)[0] : undefined;
  const scheme = schemeName ? deref(doc, doc.components?.securitySchemes?.[schemeName]) : undefined;
  if (scheme?.type === 'http' && scheme.scheme === 'bearer') headers.push(['Authorization', 'Bearer $TOKEN']);
  else if (scheme?.type === 'http' && scheme.scheme === 'basic') headers.push(['Authorization', 'Basic $CREDENTIALS']);
  else if (scheme?.type === 'apiKey' && scheme.in === 'header') headers.push([scheme.name, '$API_KEY']);
  else if (scheme?.type === 'apiKey' && scheme.in === 'query') query.push(`${encodeURIComponent(scheme.name)}=%24API_KEY`);
  else if (scheme?.type === 'oauth2' || scheme?.type === 'openIdConnect') headers.push(['Authorization', 'Bearer $TOKEN']);

  // JSON request body, when the operation takes one.
  let body: string | null = null;
  const content = deref(doc, op.requestBody)?.content;
  const jsonType = content && Object.keys(content).find((t) => /json/i.test(t));
  if (jsonType) {
    body = JSON.stringify(exampleFromSchema(doc, content[jsonType].schema ?? {}), null, 2);
    headers.push(['Content-Type', jsonType]);
  }

  const base = (server ?? doc.servers?.[0]?.url ?? '').replace(/\/+$/, '').replace(/\{[^}]+\}/g, 'x');
  const url = `${base || 'http://localhost'}${filledPath}${query.length ? '?' + query.join('&') : ''}`;
  return { method: method.toUpperCase(), url, headers, body };
}

export function generateSamples(input: SampleInput): Record<SampleLanguage, string> {
  return {
    curl: curlSample(input),
    fetch: fetchSample(input),
    axios: axiosSample(input),
    python: pythonSample(input),
    go: goSample(input),
    http: httpSample(input),
  };
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;   // shell single-quote
const js = (s: string) => JSON.stringify(s);

function curlSample({ method, url, headers, body }: SampleInput): string {
  const lines = [`curl -X ${method} ${sq(url)}`];
  for (const [k, v] of headers) lines.push(`  -H ${sq(`${k}: ${v}`)}`);
  if (body != null) lines.push(`  -d ${sq(body)}`);
  return lines.join(' \\\n');
}

function fetchSample({ method, url, headers, body }: SampleInput): string {
  const opts: string[] = [`method: ${js(method)}`];
  if (headers.length) opts.push(`headers: {\n${headers.map(([k, v]) => `    ${js(k)}: ${js(v)},`).join('\n')}\n  }`);
  if (body != null) opts.push(`body: JSON.stringify(${body.replace(/\n/g, '\n  ')})`);
  return `const res = await fetch(${js(url)}, {\n  ${opts.join(',\n  ')},\n});\nconst data = await res.json();`;
}

function axiosSample({ method, url, headers, body }: SampleInput): string {
  const opts: string[] = [`method: ${js(method.toLowerCase())}`, `url: ${js(url)}`];
  if (headers.length) opts.push(`headers: {\n${headers.map(([k, v]) => `    ${js(k)}: ${js(v)},`).join('\n')}\n  }`);
  if (body != null) opts.push(`data: ${body.replace(/\n/g, '\n  ')}`);
  return `const { data } = await axios({\n  ${opts.join(',\n  ')},\n});`;
}

function pythonSample({ method, url, headers, body }: SampleInput): string {
  const py = (s: string) => js(s);  // JSON string quoting is valid Python
  const lines = ['import requests', ''];
  if (headers.length) lines.push(`headers = {\n${headers.map(([k, v]) => `    ${py(k)}: ${py(v)},`).join('\n')}\n}`);
  const args = [py(url)];
  if (headers.length) args.push('headers=headers');
  if (body != null) {
    lines.push(`payload = ${body.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')}`);
    args.push('json=payload');
  }
  lines.push(`res = requests.${method.toLowerCase()}(${args.join(', ')})`, 'print(res.json())');
  return lines.join('\n');
}

function goSample({ method, url, headers, body }: SampleInput): string {
  const lines = [
    body != null ? `payload := strings.NewReader(\`${body.replace(/`/g, "'")}\`)` : '',
    `req, _ := http.NewRequest(${js(method)}, ${js(url)}, ${body != null ? 'payload' : 'nil'})`,
    ...headers.map(([k, v]) => `req.Header.Set(${js(k)}, ${js(v)})`),
    `res, err := http.DefaultClient.Do(req)`,
    `if err != nil { panic(err) }`,
    `defer res.Body.Close()`,
  ];
  return lines.filter(Boolean).join('\n');
}

function httpSample({ method, url, headers, body }: SampleInput): string {
  const lines = [`${method} ${url}`];
  for (const [k, v] of headers) lines.push(`${k}: ${v}`);
  if (body != null) lines.push('', body);
  return lines.join('\n');
}
