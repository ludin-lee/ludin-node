import type { Doc, TagGroup } from './openapi';
import { Schema } from './Schema';

export function Overview({ doc, groups, schemaName }: { doc: Doc; groups: TagGroup[]; schemaName?: string }) {
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
        </div>
        {info.description && <div class="op-desc md">{info.description}</div>}
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
            {g.description && <div class="md" style="padding:6px 8px 10px">{g.description}</div>}
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
