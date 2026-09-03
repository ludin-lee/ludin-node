import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type AdminInfo, type AdminUser } from './api';
import { Modal } from './Modal';

type Dialog =
  | { kind: 'none' }
  | { kind: 'invite' }
  | { kind: 'user' }
  | { kind: 'password'; user: AdminUser }
  | { kind: 'ip'; user: AdminUser }
  | { kind: 'link'; email: string; url: string };

export function Admin() {
  const [info, setInfo] = useState<AdminInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });

  const reload = () => api.admin().then(setInfo).catch((e) => setErr(e.message));
  useEffect(() => {
    reload();
  }, []);

  /** Run a mutation, surface its error, and refresh the screen. */
  async function act<T>(fn: () => Promise<T>, onDone?: (value: T) => void) {
    setBusy(true);
    setErr(null);
    try {
      const value = await fn();
      await reload();
      onDone?.(value);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!info) return err ? <div class="notice err">{err}</div> : <span class="spin" />;

  const can = info.capabilities;
  const editable = !info.readonly;
  const roleNames = info.roles.map((r) => r.name);

  return (
    <div>
      <div class="op-head">
        <h1>Administration</h1>
        <div class="op-path">
          <span class="chip">
            <span class="dot" style={info.readonly ? 'background:var(--warn)' : ''} />
            {info.readonly ? 'binding mode · read-only' : 'store mode'}
          </span>
          <span class="chip">ip policy: {info.ipPolicy}</span>
          <span class="chip">audit → {info.audit.sink}</span>
          {info.audit.retentionDays && <span class="chip">retention: {info.audit.retentionDays}d</span>}
        </div>
      </div>

      {info.readonly && (
        <div class="notice" style="margin-bottom:20px">
          <b>Binding mode.</b> Accounts and IP rules come from your code / environment variables, so they are shown here but cannot
          be edited. Redeploy to change them, or connect a <code>store</code> (SQLite, Postgres, …) to invite users and edit rules
          from this screen.
        </div>
      )}
      {err && (
        <div class="notice err" style="margin-bottom:20px">
          {err}
        </div>
      )}

      <div class="kpi">
        <div class="card"><div class="card-b"><div class="v">{info.users.length}</div><div class="l">Accounts</div></div></div>
        <div class="card"><div class="card-b"><div class="v">{info.ipRules.length || '—'}</div><div class="l">IP rules {info.ipRules.length ? '' : '(open)'}</div></div></div>
        <div class="card"><div class="card-b"><div class="v">{info.roles.length}</div><div class="l">Roles</div></div></div>
        <div class="card"><div class="card-b"><div class="v">{Object.keys(info.visibility).length}</div><div class="l">Visibility rules</div></div></div>
      </div>

      <div class="grid2">
        <div class="card" style="grid-column:1/-1">
          <div class="card-h">
            Accounts <span class="spacer" />
            {can.invites ? (
              <button class="btn btn-sm" disabled={busy} onClick={() => setDialog({ kind: 'invite' })}>
                + Invite
              </button>
            ) : (
              <button class="btn btn-sm" disabled title="Connect a store to enable">+ Invite</button>
            )}
            {can.users && (
              <button class="btn btn-sm btn-primary" disabled={busy} onClick={() => setDialog({ kind: 'user' })}>
                + Add account
              </button>
            )}
          </div>
          <div class="card-b" style="padding:0;overflow:auto">
            <table>
              <thead>
                <tr>
                  <th>Email</th><th>Role</th><th>Status</th><th>Password</th><th>IP</th>
                  {can.sessions && <th>Sessions</th>}
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {info.users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.name && <div style="font-weight:500">{u.name}</div>}
                      <span class="mono" style="font-size:12px">{u.email}</span>
                      {u.lastLoginAt && (
                        <div style="font-size:11px;color:var(--text-3)">last login {new Date(u.lastLoginAt).toLocaleString()}</div>
                      )}
                    </td>
                    <td>
                      {can.users ? (
                        <select
                          style="width:auto;padding:3px 6px;font-size:12px"
                          value={u.role}
                          disabled={busy}
                          onChange={(e) => act(() => api.updateUser(u.id, { role: (e.target as HTMLSelectElement).value }))}
                        >
                          {roleNames.map((r) => (
                            <option value={r}>{r}</option>
                          ))}
                        </select>
                      ) : (
                        <span class={`role-badge ${u.role}`}>{u.role}</span>
                      )}
                    </td>
                    <td>
                      {can.users ? (
                        <select
                          style="width:auto;padding:3px 6px;font-size:12px"
                          value={u.status}
                          disabled={busy}
                          onChange={(e) =>
                            act(() => api.updateUser(u.id, { status: (e.target as HTMLSelectElement).value as AdminUser['status'] }))
                          }
                        >
                          {['active', 'invited', 'disabled'].map((s) => (
                            <option value={s}>{s}</option>
                          ))}
                        </select>
                      ) : (
                        u.status
                      )}
                    </td>
                    <td>
                      {u.hashed ? <span class="tag">hashed</span> : <span class="tag" style="color:var(--warn)">plain text</span>}
                      {can.users && (
                        <button class="btn btn-sm btn-ghost" disabled={busy} onClick={() => setDialog({ kind: 'password', user: u })}>
                          Reset
                        </button>
                      )}
                    </td>
                    <td class="mono" style="font-size:11.5px">
                      {u.ipAllowlist.length ? u.ipAllowlist.join(', ') : '—'}
                      {can.users && (
                        <button class="btn btn-sm btn-ghost" disabled={busy} onClick={() => setDialog({ kind: 'ip', user: u })}>
                          Edit
                        </button>
                      )}
                    </td>
                    {can.sessions && (
                      <td>
                        {u.sessions || '—'}
                        {u.sessions > 0 && (
                          <button class="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(() => api.revokeUserSessions(u.id))}>
                            Sign out
                          </button>
                        )}
                      </td>
                    )}
                    {editable && (
                      <td style="text-align:right">
                        {can.users && (
                          <button
                            class="btn btn-sm btn-ghost"
                            disabled={busy}
                            title="Delete account"
                            onClick={() =>
                              confirm(`Delete ${u.email}? Their sessions are revoked immediately.`) &&
                              act(() => api.removeUser(u.id))
                            }
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {info.users.length === 0 && (
                  <tr><td colSpan={7} style="color:var(--text-3)">No accounts configured.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {can.invites && info.invites.length > 0 && (
          <div class="card" style="grid-column:1/-1">
            <div class="card-h">Pending invitations</div>
            <div class="card-b" style="padding:0;overflow:auto">
              <table>
                <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {info.invites.map((i) => (
                    <tr key={i.id}>
                      <td class="mono" style="font-size:12px">{i.email}</td>
                      <td><span class={`role-badge ${i.role}`}>{i.role}</span></td>
                      <td>{new Date(i.expiresAt).toLocaleString()}</td>
                      <td>{i.acceptedAt ? <span class="tag">accepted</span> : i.expired ? <span class="tag" style="color:var(--warn)">expired</span> : <span class="tag">pending</span>}</td>
                      <td style="text-align:right">
                        <button class="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(() => api.revokeInvite(i.id))}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div class="card">
          <div class="card-h">IP allowlist</div>
          <div class="card-b" style="padding:0">
            <table>
              <thead><tr><th>Rule</th><th>Note</th>{can.ipRules && <th />}</tr></thead>
              <tbody>
                {info.ipRules.map((r) => (
                  <tr key={r.id}>
                    <td class="mono">{r.cidr}</td>
                    <td style="color:var(--text-2)">{r.note ?? ''}</td>
                    {can.ipRules && (
                      <td style="text-align:right">
                        <button
                          class="btn btn-sm btn-ghost"
                          disabled={busy}
                          onClick={() =>
                            act(async () => {
                              try {
                                return await api.removeIpRule(r.id);
                              } catch (e) {
                                if (
                                  e instanceof ApiError &&
                                  e.code === 'self_lockout' &&
                                  confirm(`${e.message}\n\nRemove it anyway?`)
                                ) {
                                  return api.removeIpRule(r.id, true);
                                }
                                throw e;
                              }
                            })
                          }
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {info.ipRules.length === 0 && (
                  <tr><td colSpan={3} style="color:var(--text-3)">No rules — every IP may reach the login page.</td></tr>
                )}
              </tbody>
            </table>
            {can.ipRules && <AddIpRule busy={busy} onAdd={(input) => act(() => addRuleWithForce(input))} />}
            <div style="padding:10px 12px;border-top:1px solid var(--border);font-size:12.5px;color:var(--text-2)">
              policy <b>{info.ipPolicy}</b> · localhost bypass <b>{String(info.allowLocalhost)}</b> · trust proxy{' '}
              <b>{String(info.trustProxy)}</b>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h">Roles</div>
          <div class="card-b" style="padding:0">
            <table>
              <thead><tr><th>Role</th><th>Permissions</th></tr></thead>
              <tbody>
                {info.roles.map((r) => (
                  <tr>
                    <td><span class={`role-badge ${r.name}`}>{r.name}</span></td>
                    <td>{r.permissions.map((p) => <span class="tag" style="margin:0 4px 4px 0">{p}</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card" style="grid-column:1/-1">
          <div class="card-h">Visibility rules</div>
          <div class="card-b" style="padding:0">
            <table>
              <thead><tr><th>Rule</th><th>Visible to</th></tr></thead>
              <tbody>
                {Object.entries(info.visibility).map(([k, roles]) => (
                  <tr><td class="mono">{k}</td><td>{roles.map((r) => <span class={`role-badge ${r}`} style="margin-right:4px">{r}</span>)}</td></tr>
                ))}
                {Object.keys(info.visibility).length === 0 && (
                  <tr><td colSpan={2} style="color:var(--text-3)">All endpoints visible to every role.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {dialog.kind === 'invite' && (
        <InviteDialog
          roles={roleNames}
          busy={busy}
          onClose={() => setDialog({ kind: 'none' })}
          onSubmit={(input) =>
            act(
              () => api.createInvite(input),
              (res) => setDialog({ kind: 'link', email: input.email, url: absolute(res.url) }),
            )
          }
        />
      )}
      {dialog.kind === 'user' && (
        <UserDialog
          roles={roleNames}
          busy={busy}
          onClose={() => setDialog({ kind: 'none' })}
          onSubmit={(input) => act(() => api.createUser(input), () => setDialog({ kind: 'none' }))}
        />
      )}
      {dialog.kind === 'password' && (
        <PasswordDialog
          user={dialog.user}
          busy={busy}
          onClose={() => setDialog({ kind: 'none' })}
          onSubmit={(password) => act(() => api.updateUser(dialog.user.id, { password }), () => setDialog({ kind: 'none' }))}
        />
      )}
      {dialog.kind === 'ip' && (
        <IpListDialog
          user={dialog.user}
          busy={busy}
          onClose={() => setDialog({ kind: 'none' })}
          onSubmit={(ipAllowlist) => act(() => api.updateUser(dialog.user.id, { ipAllowlist }), () => setDialog({ kind: 'none' }))}
        />
      )}
      {dialog.kind === 'link' && <LinkDialog email={dialog.email} url={dialog.url} onClose={() => setDialog({ kind: 'none' })} />}
    </div>
  );
}

async function addRuleWithForce(input: { cidr: string; note?: string }) {
  try {
    return await api.addIpRule(input);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'self_lockout' && confirm(`${e.message}\n\nAdd it anyway?`)) {
      return api.addIpRule({ ...input, force: true });
    }
    throw e;
  }
}

function absolute(url: string): string {
  return new URL(url, location.href).toString();
}

// ---------------------------------------------------------------------------
function AddIpRule({ busy, onAdd }: { busy: boolean; onAdd: (input: { cidr: string; note?: string }) => void }) {
  const [cidr, setCidr] = useState('');
  const [note, setNote] = useState('');
  return (
    <form
      class="row"
      style="padding:10px 12px;border-top:1px solid var(--border)"
      onSubmit={(e) => {
        e.preventDefault();
        if (!cidr.trim()) return;
        onAdd({ cidr: cidr.trim(), note: note.trim() || undefined });
        setCidr('');
        setNote('');
      }}
    >
      <input placeholder="10.0.0.0/8" value={cidr} onInput={(e) => setCidr((e.target as HTMLInputElement).value)} />
      <input placeholder="note (optional)" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
      <button class="btn btn-sm btn-primary" disabled={busy || !cidr.trim()}>Add</button>
    </form>
  );
}

function InviteDialog({
  roles,
  busy,
  onClose,
  onSubmit,
}: {
  roles: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { email: string; role: string; ttl?: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(roles.includes('developer') ? 'developer' : roles[0]);
  const [ttl, setTtl] = useState('7d');
  return (
    <Modal title="Invite someone" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ email: email.trim(), role, ttl });
        }}
      >
        <div class="field">
          <label>Email</label>
          <input type="email" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label>Role</label>
          <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value)}>
            {roles.map((r) => (
              <option value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div class="field">
          <label>Link valid for</label>
          <select value={ttl} onChange={(e) => setTtl((e.target as HTMLSelectElement).value)}>
            <option value="1d">1 day</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
          </select>
        </div>
        <p style="font-size:12.5px;color:var(--text-2)">
          They pick their own password. The link is shown once — ludin stores only a hash of it.
        </p>
        <button class="btn btn-primary" disabled={busy}>Create invitation</button>
      </form>
    </Modal>
  );
}

function UserDialog({
  roles,
  busy,
  onClose,
  onSubmit,
}: {
  roles: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { email: string; password: string; role: string; name?: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(roles.includes('developer') ? 'developer' : roles[0]);
  return (
    <Modal title="Add an account" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ email: email.trim(), password, role, name: name.trim() || undefined });
        }}
      >
        <div class="field">
          <label>Email</label>
          <input type="email" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label>Name (optional)</label>
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label>Role</label>
          <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value)}>
            {roles.map((r) => (
              <option value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div class="field">
          <label>Password (min 8 characters)</label>
          <input type="password" required minLength={8} value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </div>
        <button class="btn btn-primary" disabled={busy}>Create account</button>
      </form>
    </Modal>
  );
}

function PasswordDialog({
  user,
  busy,
  onClose,
  onSubmit,
}: {
  user: AdminUser;
  busy: boolean;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  return (
    <Modal title={`Reset password · ${user.email}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(password);
        }}
      >
        <div class="field">
          <label>New password (min 8 characters)</label>
          <input type="password" required minLength={8} value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </div>
        <p style="font-size:12.5px;color:var(--text-2)">Their existing sessions are signed out.</p>
        <button class="btn btn-primary" disabled={busy}>Set password</button>
      </form>
    </Modal>
  );
}

function IpListDialog({
  user,
  busy,
  onClose,
  onSubmit,
}: {
  user: AdminUser;
  busy: boolean;
  onClose: () => void;
  onSubmit: (list: string[]) => void;
}) {
  const [value, setValue] = useState(user.ipAllowlist.join(', '));
  return (
    <Modal title={`IP restriction · ${user.email}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value.split(',').map((s) => s.trim()).filter(Boolean));
        }}
      >
        <div class="field">
          <label>Allowed addresses (comma separated, empty = no personal restriction)</label>
          <input class="mono" placeholder="203.0.113.0/24, 2001:db8::/32" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
        </div>
        <button class="btn btn-primary" disabled={busy}>Save</button>
      </form>
    </Modal>
  );
}

function LinkDialog({ email, url, onClose }: { email: string; url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Invitation created" onClose={onClose}>
      <p style="font-size:13px">
        Send this link to <b>{email}</b>. It is shown only once.
      </p>
      <div class="row">
        <input class="mono" readOnly value={url} onFocus={(e) => (e.target as HTMLInputElement).select()} />
        <button
          class="btn btn-sm btn-primary"
          onClick={() => {
            navigator.clipboard?.writeText(url).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Modal>
  );
}
