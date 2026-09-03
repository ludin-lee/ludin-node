import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type AuditEvent, type AuditFilter } from './api';

const TYPES = [
  'login.success',
  'login.failure',
  'logout',
  'docs.view',
  'docs.try',
  'ip.blocked',
  'admin.user.create',
  'admin.user.update',
  'admin.user.remove',
  'admin.ip.create',
  'admin.ip.remove',
  'admin.sessions.revoke',
  'invite.create',
  'invite.accept',
  'invite.revoke',
];

export function Audit({ canReadAll }: { canReadAll: boolean }) {
  const [filter, setFilter] = useState<AuditFilter>({});
  const [applied, setApplied] = useState<AuditFilter>({});
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(f: AuditFilter, append = false) {
    setBusy(true);
    setErr(null);
    try {
      const page = await api.audit({ ...f, limit: 50 });
      setEvents((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor ?? null);
    } catch (e) {
      setErr({ message: e instanceof ApiError ? e.message : String(e), code: e instanceof ApiError ? e.code : undefined });
      if (!append) setEvents([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load({});
  }, []);

  function submit(e: Event) {
    e.preventDefault();
    setApplied(filter);
    load(filter);
  }

  const set = (patch: Partial<AuditFilter>) => setFilter((f) => ({ ...f, ...patch }));

  return (
    <div>
      <div class="op-head">
        <h1>Audit log</h1>
        <div class="op-path">
          <span class="chip">{canReadAll ? 'all activity' : 'your activity'}</span>
          {events.length > 0 && <span class="chip">{events.length} shown</span>}
        </div>
      </div>

      <form class="toolbar" onSubmit={submit}>
        <input
          placeholder="Search path, detail, address…"
          value={filter.q ?? ''}
          onInput={(e) => set({ q: (e.target as HTMLInputElement).value })}
        />
        <select value={filter.type ?? ''} onChange={(e) => set({ type: (e.target as HTMLSelectElement).value || undefined })}>
          <option value="">All events</option>
          {TYPES.map((t) => (
            <option value={t}>{t}</option>
          ))}
        </select>
        {canReadAll && (
          <input
            placeholder="user@example.com"
            value={filter.user ?? ''}
            onInput={(e) => set({ user: (e.target as HTMLInputElement).value || undefined })}
          />
        )}
        <input
          type="date"
          title="From"
          value={(filter.from ?? '').slice(0, 10)}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            set({ from: v ? new Date(v).toISOString() : undefined });
          }}
        />
        <input
          type="date"
          title="To"
          value={(filter.to ?? '').slice(0, 10)}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            set({ to: v ? new Date(v + 'T23:59:59.999Z').toISOString() : undefined });
          }}
        />
        <button class="btn btn-sm btn-primary" disabled={busy}>Apply</button>
        <a class="btn btn-sm" href={api.auditCsvUrl(applied)} download>
          Export CSV
        </a>
      </form>

      {err && (
        <div class="notice err" style="margin-bottom:16px">
          {err.message}
        </div>
      )}

      <div class="card">
        <div class="card-b" style="padding:0;overflow:auto">
          <table>
            <thead>
              <tr><th style="width:170px">Time</th><th style="width:150px">Event</th><th>User</th><th style="width:130px">IP</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td class="mono" style="font-size:11.5px;white-space:nowrap">{new Date(e.ts).toLocaleString()}</td>
                  <td><span class="tag">{e.type}</span></td>
                  <td>
                    {e.user ? (
                      <>
                        <span class="mono" style="font-size:12px">{e.user.email}</span>{' '}
                        <span class={`role-badge ${e.user.role}`}>{e.user.role}</span>
                      </>
                    ) : (
                      <span style="color:var(--text-3)">—</span>
                    )}
                  </td>
                  <td class="mono" style="font-size:11.5px">{e.ip || '—'}</td>
                  <td class="mono" style="font-size:11.5px;color:var(--text-2);word-break:break-word">
                    {e.detail ? <Detail detail={e.detail} /> : '—'}
                  </td>
                </tr>
              ))}
              {events.length === 0 && !busy && !err && (
                <tr><td colSpan={5} style="color:var(--text-3)">No events match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {(cursor || busy) && (
          <div class="pager">
            {busy ? (
              <span class="spin" />
            ) : (
              <button class="btn btn-sm" onClick={() => load({ ...applied, cursor: cursor! }, true)}>
                Load older
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Detail({ detail }: { detail: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const text = JSON.stringify(detail);
  if (text.length <= 120) return <>{text}</>;
  return (
    <>
      {open ? text : `${text.slice(0, 120)}…`}{' '}
      <button class="btn btn-sm btn-ghost" onClick={() => setOpen(!open)}>
        {open ? 'less' : 'more'}
      </button>
    </>
  );
}
