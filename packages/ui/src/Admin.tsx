import { useEffect, useState } from 'preact/hooks';
import { api, type AdminInfo } from './api';

/**
 * A read-only picture of the deployment: who may log in, which addresses are
 * allowed, what each role can do. All of it comes from the code that mounted
 * ludin, so this screen explains the configuration instead of editing it.
 */
export function Admin() {
  const [info, setInfo] = useState<AdminInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.admin().then(setInfo).catch((e) => setErr(e.message));
  }, []);

  if (!info) return err ? <div class="notice err">{err}</div> : <span class="spin" />;

  return (
    <div>
      <div class="op-head">
        <h1>Administration</h1>
        <div class="op-path">
          <span class="chip">
            <span class="dot" />
            read-only
          </span>
          <span class="chip">ip policy: {info.ipPolicy}</span>
          <span class="chip">audit → {info.audit.sink}</span>
        </div>
      </div>

      <div class="notice" style="margin-bottom:20px">
        <b>Configuration, not a control panel.</b> Accounts, IP rules and roles come from the options you pass to ludin (or
        from environment variables), so they are shown here and changed by a redeploy.
      </div>

      <div class="kpi">
        <div class="card"><div class="card-b"><div class="v">{info.users.length}</div><div class="l">Accounts</div></div></div>
        <div class="card"><div class="card-b"><div class="v">{info.ipRules.length || '—'}</div><div class="l">IP rules {info.ipRules.length ? '' : '(open)'}</div></div></div>
        <div class="card"><div class="card-b"><div class="v">{info.roles.length}</div><div class="l">Roles</div></div></div>
        <div class="card"><div class="card-b"><div class="v">{Object.keys(info.visibility).length}</div><div class="l">Visibility rules</div></div></div>
      </div>

      <div class="grid2">
        <div class="card" style="grid-column:1/-1">
          <div class="card-h">Accounts</div>
          <div class="card-b" style="padding:0;overflow:auto">
            <table>
              <thead>
                <tr><th>Email</th><th>Role</th><th>Password</th><th>IP</th></tr>
              </thead>
              <tbody>
                {info.users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.name && <div style="font-weight:500">{u.name}</div>}
                      <span class="mono" style="font-size:12px">{u.email}</span>
                    </td>
                    <td><span class={`role-badge ${u.role}`}>{u.role}</span></td>
                    <td>
                      {u.hashed ? <span class="tag">hashed</span> : <span class="tag" style="color:var(--warn)">plain text</span>}
                    </td>
                    <td class="mono" style="font-size:11.5px">{u.ipAllowlist.length ? u.ipAllowlist.join(', ') : '—'}</td>
                  </tr>
                ))}
                {info.users.length === 0 && (
                  <tr>
                    <td colSpan={4} style="color:var(--text-3)">
                      {info.customVerifier
                        ? 'Logins are checked by your own auth.verify – no accounts are configured here.'
                        : 'No accounts configured.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-h">IP allowlist</div>
          <div class="card-b" style="padding:0">
            <table>
              <thead><tr><th>Rule</th></tr></thead>
              <tbody>
                {info.ipRules.map((cidr) => (
                  <tr key={cidr}><td class="mono">{cidr}</td></tr>
                ))}
                {info.ipRules.length === 0 && (
                  <tr><td style="color:var(--text-3)">No rules — every IP may reach the login page.</td></tr>
                )}
              </tbody>
            </table>
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

        <div class="card" style="grid-column:1/-1">
          <div class="card-h">Readme page</div>
          <div class="card-b">
            {info.readme ? (
              <div style="font-size:13px">
                <div>
                  Button <b>{info.readme.label}</b> serves <span class="mono">{info.readme.path}</span>
                </div>
                <div style="margin-top:6px;color:var(--text-2)">
                  {info.readme.visibleTo.length ? (
                    <>
                      Visible to{' '}
                      {info.readme.visibleTo.map((r) => (
                        <span class={`role-badge ${r}`} style="margin-right:4px">{r}</span>
                      ))}
                    </>
                  ) : (
                    'Visible to every role that can read the docs.'
                  )}
                </div>
              </div>
            ) : (
              <div style="color:var(--text-3);font-size:13px">
                No page configured. Pass <span class="mono">readme: {'{'} enabled: true, path: './README.html' {'}'}</span> to show
                one next to the reference.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
