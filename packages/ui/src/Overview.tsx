import { useEffect, useState } from 'preact/hooks';
import type { Doc, TagGroup } from './openapi';
import { api, type LintInfo } from './api';
import { Schema } from './Schema';
import { Markdown } from './Markdown';

/** Documentation health, linted by the core against the role-filtered spec. */
function HealthCard({ specName }: { specName: string }) {
  const [lint, setLint] = useState<LintInfo | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setLint(null);
    api.lint(specName).then(setLint).catch(() => setLint(null));
  }, [specName]);
  if (!lint) return null;
  const tone = lint.score >= 90 ? 'var(--ok, #3fb950)' : lint.score >= 60 ? 'var(--warn, #d29922)' : 'var(--err, #f85149)';
  return (
    <>
      <div class="card" style="cursor:pointer" onClick={() => setOpen(!open)} title="Click for the issue list (also: npx ludin lint)">
        <div class="card-b">
          <div class="v" style={`color:${tone}`}>{lint.score}</div>
          <div class="l">Docs health · {lint.passed}/{lint.checks} checks</div>
        </div>
      </div>
      {open && lint.issues.length > 0 && (
        <div class="card" style="grid-column:1/-1">
          <div class="card-h">Documentation issues <span class="count" style="font-weight:400">{lint.issues.length}</span></div>
          <div class="card-b" style="padding:6px 14px;max-height:260px;overflow:auto">
            {lint.issues.map((i) => (
              <div class="param" style="grid-template-columns:56px 1fr">
                <span class={`status-pill ${i.severity === 'error' ? 's5' : i.severity === 'warn' ? 's4' : 's2'}`}>{i.severity}</span>
                <span class="desc"><code>{i.path}</code> — {i.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export function Overview({
  doc,
  groups,
  schemaName,
  specName,
}: {
  doc: Doc;
  groups: TagGroup[];
  schemaName?: string;
  specName?: string;
}) {
  const info = doc.info ?? {};
  if (schemaName) {
    const schema = doc.components?.schemas?.[schemaName];
    return (
      <div>
        <div class="op-head">
          <h1 class="mono" style="font-family:var(--mono)">{schemaName}</h1>
          {schema?.description && <div class="op-desc">{schema.description}</div>}
        </div>
        <div class="card">
          <div class="card-b">{schema ? <Schema doc={doc} schema={schema} open /> : <div class="notice err">Schema not found</div>}</div>
        </div>
      </div>
    );
  }
  const total = groups.reduce((n, g) => n + g.operations.length, 0);
  return (
    <div>
      <div class="op-head">
        <h1>{info.title ?? 'API'}</h1>
        <div class="op-path">
          {info.version && <span class="chip">v{info.version}</span>}
          {doc.openapi && <span class="chip">OpenAPI {doc.openapi}</span>}
          {doc.swagger && <span class="chip">Swagger {doc.swagger}</span>}
          {info.license?.name && <span class="chip">{info.license.name}</span>}
          {specName && (
            <>
              <a class="btn btn-sm" href={api.specDownloadUrl(specName, 'json')} download title="Download the document you are allowed to see">
                ↓ JSON
              </a>
              <a class="btn btn-sm" href={api.specDownloadUrl(specName, 'yaml')} download title="Download the document you are allowed to see">
                ↓ YAML
              </a>
            </>
          )}
        </div>
        {info.description && <Markdown text={info.description} class="op-desc md" />}
      </div>

      <div class="kpi">
        <div class="card">
          <div class="card-b">
            <div class="v">{total}</div>
            <div class="l">Endpoints</div>
          </div>
        </div>
        <div class="card">
          <div class="card-b">
            <div class="v">{groups.length}</div>
            <div class="l">Tags</div>
          </div>
        </div>
        <div class="card">
          <div class="card-b">
            <div class="v">{Object.keys(doc.components?.schemas ?? {}).length}</div>
            <div class="l">Schemas</div>
          </div>
        </div>
        {doc.servers?.length > 0 && (
          <div class="card">
            <div class="card-b">
              <div class="v" style="font-size:14px;font-family:var(--mono);word-break:break-all">{doc.servers[0].url}</div>
              <div class="l">Server{doc.servers.length > 1 ? `s (+${doc.servers.length - 1})` : ''}</div>
            </div>
          </div>
        )}
        {specName && <HealthCard specName={specName} />}
      </div>

      {groups.map((g) => (
        <div class="card" style="margin-bottom:14px">
          <div class="card-h">
            {g.name}
            <span class="count" style="color:var(--text-3);font-weight:400">
              {g.operations.length}
            </span>
          </div>
          <div class="card-b" style="padding:6px 8px">
            {g.description && (
              <div style="padding:6px 8px 10px">
                <Markdown text={g.description} />
              </div>
            )}
            {g.operations.map((o) => (
              <a href={`#/op/${encodeURIComponent(o.id)}`} class={`nav-item ${o.deprecated ? 'deprecated' : ''}`}>
                <span class={`method ${o.method}`}>{o.method}</span>
                <span class="path" style="flex:0 0 auto;max-width:45%">{o.path}</span>
                <span style="color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{o.summary}</span>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
