import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type Notice, type NoticeInput, type NoticeSummary } from './api';
import { Markdown } from './Markdown';
import { Modal } from './Modal';

const SEEN_KEY = 'ludin.notices.seen';

/** Timestamp of the newest notice the reader has opened, for the unread dot. */
export function lastSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function markSeen(at: string) {
  try {
    localStorage.setItem(SEEN_KEY, at);
  } catch {
    /* private mode – the dot just stays */
  }
}

export function Notices({ id, roles }: { id?: string; roles: string[] }) {
  const [list, setList] = useState<NoticeSummary[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<Notice | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    api
      .notices()
      .then((r) => {
        setList(r.notices);
        setCanWrite(r.canWrite);
        const newest = r.notices.filter((n) => n.status === 'published').map((n) => n.updatedAt).sort().pop();
        if (newest) markSeen(newest);
      })
      .catch((e) => setErr(e.message));

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    if (!id) {
      setNotice(null);
      return;
    }
    setNotice(null);
    api
      .notice(id)
      .then((r) => {
        setNotice(r.notice);
        setCanWrite(r.canWrite);
      })
      .catch((e) => setErr(e.message));
  }, [id]);

  async function act<T>(fn: () => Promise<T>, after?: () => void) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await reload();
      after?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- one notice ----------------------------------------------------------
  if (id) {
    return (
      <div>
        <div class="op-head">
          <a class="btn btn-sm btn-ghost" href="#/notices">
            ← All notices
          </a>
          {notice && (
            <>
              <h1 style="margin-top:8px">{notice.title}</h1>
              <div class="op-path">
                <span class="chip">{new Date(notice.updatedAt).toLocaleString()}</span>
                {notice.authorEmail && <span class="chip">{notice.authorEmail}</span>}
                {notice.pinned && <span class="chip">pinned</span>}
                {notice.status === 'draft' && <span class="chip" style="color:var(--warn)">draft</span>}
                {notice.visibleTo?.length ? (
                  <span class="chip">
                    visible to {notice.visibleTo.join(', ')}
                  </span>
                ) : null}
                {canWrite && (
                  <>
                    <button class="btn btn-sm" disabled={busy} onClick={() => setEditing(notice)}>
                      Edit
                    </button>
                    <button
                      class="btn btn-sm btn-ghost"
                      disabled={busy}
                      onClick={() =>
                        confirm(`Delete “${notice.title}”?`) &&
                        act(() => api.removeNotice(notice.id), () => (location.hash = '#/notices'))
                      }
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        {err && <div class="notice err">{err}</div>}
        {!notice && !err && <span class="spin" />}
        {notice && (
          <div class="card">
            <div class="card-b">
              <Markdown text={notice.body} class="md md-page" />
            </div>
          </div>
        )}
        {editing && editing !== 'new' && (
          <NoticeEditor
            notice={editing}
            roles={roles}
            busy={busy}
            onClose={() => setEditing(null)}
            onSubmit={(input) =>
              act(
                async () => {
                  const r = await api.updateNotice(editing.id, input);
                  setNotice(r.notice);
                },
                () => setEditing(null),
              )
            }
          />
        )}
      </div>
    );
  }

  // ---- the board -----------------------------------------------------------
  return (
    <div>
      <div class="op-head">
        <h1>Notices</h1>
        <div class="op-path">
          <span class="chip">{list?.length ?? 0} posts</span>
          {canWrite && (
            <button class="btn btn-sm btn-primary" disabled={busy} onClick={() => setEditing('new')}>
              + New notice
            </button>
          )}
        </div>
      </div>

      {err && <div class="notice err" style="margin-bottom:16px">{err}</div>}
      {!list && !err && <span class="spin" />}

      {list && list.length === 0 && (
        <div class="empty">
          <h2>Nothing posted yet</h2>
          <p>{canWrite ? 'Use “New notice” to write the first one.' : 'Announcements from the API team will show up here.'}</p>
        </div>
      )}

      <div class="notice-list">
        {list?.map((n) => (
          <a class="card notice-item" href={`#/notices/${encodeURIComponent(n.id)}`} key={n.id}>
            <div class="card-b">
              <div class="notice-title">
                {n.pinned && <span class="tag">pinned</span>}
                {n.status === 'draft' && <span class="tag" style="color:var(--warn)">draft</span>}
                <b>{n.title}</b>
              </div>
              <div class="notice-meta">
                {new Date(n.updatedAt).toLocaleDateString()}
                {n.authorEmail ? ` · ${n.authorEmail}` : ''}
                {n.visibleTo?.length ? ` · ${n.visibleTo.join(', ')} only` : ''}
              </div>
              {n.excerpt && <div class="notice-excerpt">{n.excerpt}</div>}
            </div>
          </a>
        ))}
      </div>

      {editing === 'new' && (
        <NoticeEditor
          roles={roles}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(input) => act(() => api.createNotice(input), () => setEditing(null))}
        />
      )}
    </div>
  );
}

function NoticeEditor({
  notice,
  roles,
  busy,
  onClose,
  onSubmit,
}: {
  notice?: Notice;
  roles: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: NoticeInput) => void;
}) {
  const [title, setTitle] = useState(notice?.title ?? '');
  const [body, setBody] = useState(notice?.body ?? '');
  const [status, setStatus] = useState<'draft' | 'published'>(notice?.status ?? 'published');
  const [pinned, setPinned] = useState(notice?.pinned ?? false);
  const [visibleTo, setVisibleTo] = useState<string[]>(notice?.visibleTo ?? []);
  const [preview, setPreview] = useState(false);

  const toggleRole = (role: string) =>
    setVisibleTo((current) => (current.includes(role) ? current.filter((r) => r !== role) : [...current, role]));

  return (
    <Modal title={notice ? 'Edit notice' : 'New notice'} wide onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ title: title.trim(), body, status, pinned, visibleTo });
        }}
      >
        <div class="field">
          <label>Title</label>
          <input required value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label>
            Body (Markdown) <span class="spacer" />
            <button type="button" class="btn btn-sm btn-ghost" onClick={() => setPreview(!preview)}>
              {preview ? 'Write' : 'Preview'}
            </button>
          </label>
          {preview ? (
            <div class="card" style="min-height:200px">
              <div class="card-b">
                <Markdown text={body} class="md md-page" />
              </div>
            </div>
          ) : (
            <textarea
              style="min-height:240px"
              placeholder={'## Release 2.4\n\n- `POST /pets` now accepts `tag`\n- Rate limit raised to 100 rpm'}
              value={body}
              onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
            />
          )}
        </div>
        <div class="row" style="margin-bottom:10px">
          <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value as 'draft' | 'published')}>
            <option value="published">Published</option>
            <option value="draft">Draft (only authors see it)</option>
          </select>
          <label class="check">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned((e.target as HTMLInputElement).checked)} />
            Pin to top
          </label>
        </div>
        <div class="field">
          <label>Visible to (none selected = everyone who can read the docs)</label>
          <div class="row" style="flex-wrap:wrap">
            {roles.map((role) => (
              <label class="check" key={role}>
                <input type="checkbox" checked={visibleTo.includes(role)} onChange={() => toggleRole(role)} />
                {role}
              </label>
            ))}
          </div>
        </div>
        <button class="btn btn-primary" disabled={busy}>
          {notice ? 'Save changes' : 'Post notice'}
        </button>
      </form>
    </Modal>
  );
}
