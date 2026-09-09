import { useEffect, useState } from 'preact/hooks';
import { api, type AdminInfo, type Me } from './api';
import { t } from './i18n';

/**
 * A read-only picture of the deployment: who may log in, which addresses are
 * allowed, what each role can do. All of it comes from the code that mounted
 * ludin, so this screen explains the configuration instead of editing it.
 */
/**
 * Mint an expiring share link. What the link may do is decided server-side and
 * sealed into the token; this form only asks. Admin-capable roles are not
 * offered, because the core refuses them anyway.
 */
function ShareCard({ roles }: { roles: AdminInfo['roles'] }) {
  const [specs, setSpecs] = useState<string[]>([]);
  const [role, setRole] = useState('viewer');
  const [ttl, setTtl] = useState('3d');
  const [spec, setSpec] = useState('');
  const [canTry, setCanTry] = useState(false);
  const [label, setLabel] = useState('');
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.specs().then((r) => setSpecs(r.specs.map((s) => s.name))).catch(() => setSpecs([]));
  }, []);

  const shareable = roles.filter((r) => !r.permissions.some((p) => p.startsWith('admin:')));

  async function create() {
    setErr(null);
    setLink(null);
    try {
      const r = await api.createShare({ role, ttl, canTry, spec: spec || undefined, label: label || undefined });
      setLink({ url: r.url, expiresAt: r.expiresAt });
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <div class="card" style="grid-column:1/-1">
      <div class="card-h">{t('shareLink')}</div>
      <div class="card-b">
        <div class="notice info" style="margin-bottom:12px">{t('shareNotice')}</div>
        <div class="share-form">
          <label>
            {t('role')}
            <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value)}>
              {shareable.map((r) => <option value={r.name}>{r.name}</option>)}
            </select>
          </label>
          <label>
            {t('shareExpires')}
            <select value={ttl} onChange={(e) => setTtl((e.target as HTMLSelectElement).value)}>
              {['1d', '3d', '7d', '30d'].map((v) => <option value={v}>{v}</option>)}
            </select>
          </label>
          {specs.length > 1 && (
            <label>
              {t('shareSpec')}
              <select value={spec} onChange={(e) => setSpec((e.target as HTMLSelectElement).value)}>
                <option value="">{t('shareAllSpecs')}</option>
                {specs.map((n) => <option value={n}>{n}</option>)}
              </select>
            </label>
          )}
          <label>
            {t('shareLabel')}
            <input placeholder="Acme Inc." value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <label class="auto-capture" style="margin-top:10px">
          <input type="checkbox" checked={canTry} onChange={() => setCanTry(!canTry)} />
          {t('shareCanTry')}
        </label>
        <div class="row2" style="margin-top:10px">
          <button class="btn btn-primary" onClick={create}>{t('shareCreate')}</button>
        </div>
        {err && <div class="notice err" style="margin-top:10px">{err}</div>}
        {link && (
          <div class="notice ok" style="margin-top:10px">
            <div class="mono" style="word-break:break-all;font-size:11.5px">{link.url}</div>
            <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
              <button class="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
                {copied ? t('copied') : t('copy')}
              </button>
              <span style="font-size:12px;color:var(--text-2)">{t('shareExpiresAt', { at: new Date(link.expiresAt).toLocaleString() })}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Admin({ me }: { me?: Me }) {
  const [info, setInfo] = useState<AdminInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.admin().then(setInfo).catch((e) => setErr(e.message));
  }, []);

  if (!info) return err ? <div class="notice err">{err}</div> : <span class="spin" />;

  return (
    <div>
      <div class="op-head">
        <h1>{t('administration')}</h1>
        <div class="op-path">
          <span class="chip">
            <span class="dot" />
            {t('readOnly')}
          </span>
          <span class="chip">ip policy: {info.ipPolicy}</span>
          <span class="chip">audit → {info.audit.sink}</span>
        </div>
      </div>

      <div class="notice" style="margin-bottom:20px">
        <b>{t('adminNoticeTitle')}</b> {t('adminNoticeBody')}
      </div>

      <div class="kpi">
        <div class="card"><div class="card-b"><div class="v">{info.users.length}</div><div class="l">{t('accounts')}</div></div></div>
        <div class="card"><div class="card-b"><div class="v">{info.ipRules.length || '—'}</div><div class="l">{t('ipRules')} {info.ipRules.length ? '' : t('ipRulesOpen')}</div></div></div>
        <div class="card"><div class="card-b"><div class="v">{info.roles.length}</div><div class="l">{t('roles')}</div></div></div>
        <div class="card"><div class="card-b"><div class="v">{Object.keys(info.visibility).length}</div><div class="l">{t('visibilityRules')}</div></div></div>
      </div>

      <div class="grid2">
        <div class="card" style="grid-column:1/-1">
          <div class="card-h">{t('accounts')}</div>
          <div class="card-b" style="padding:0;overflow:auto">
            <table>
              <thead>
                <tr><th>{t('email')}</th><th>{t('role')}</th><th>{t('password')}</th><th>IP</th></tr>
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
                      {u.hashed ? <span class="tag">{t('hashed')}</span> : <span class="tag" style="color:var(--warn)">{t('plainText')}</span>}
                    </td>
                    <td class="mono" style="font-size:11.5px">{u.ipAllowlist.length ? u.ipAllowlist.join(', ') : '—'}</td>
                  </tr>
                ))}
                {info.users.length === 0 && (
                  <tr>
                    <td colSpan={4} style="color:var(--text-3)">
                      {info.customVerifier
                        ? t('customVerifierNote')
                        : t('noAccounts')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-h">{t('ipAllowlist')}</div>
          <div class="card-b" style="padding:0">
            <table>
              <thead><tr><th>{t('rule')}</th></tr></thead>
              <tbody>
                {info.ipRules.map((cidr) => (
                  <tr key={cidr}><td class="mono">{cidr}</td></tr>
                ))}
                {info.ipRules.length === 0 && (
                  <tr><td style="color:var(--text-3)">{t('noIpRules')}</td></tr>
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
          <div class="card-h">{t('roles')}</div>
          <div class="card-b" style="padding:0">
            <table>
              <thead><tr><th>{t('role')}</th><th>{t('permissions')}</th></tr></thead>
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
          <div class="card-h">{t('visibilityRules')}</div>
          <div class="card-b" style="padding:0">
            <table>
              <thead><tr><th>{t('rule')}</th><th>{t('visibleTo')}</th></tr></thead>
              <tbody>
                {Object.entries(info.visibility).map(([k, roles]) => (
                  <tr><td class="mono">{k}</td><td>{roles.map((r) => <span class={`role-badge ${r}`} style="margin-right:4px">{r}</span>)}</td></tr>
                ))}
                {Object.keys(info.visibility).length === 0 && (
                  <tr><td colSpan={2} style="color:var(--text-3)">{t('allVisible')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {me?.shareEnabled && <ShareCard roles={info.roles} />}

        <div class="card" style="grid-column:1/-1">
          <div class="card-h">{t('readmePage')}</div>
          <div class="card-b">
            {info.readme ? (
              <div style="font-size:13px">
                <div>
                  Button <b>{info.readme.label}</b> serves <span class="mono">{info.readme.path}</span>
                </div>
                <div style="margin-top:6px;color:var(--text-2)">
                  {info.readme.visibleTo.length ? (
                    <>
                      {t('visibleTo')}{' '}
                      {info.readme.visibleTo.map((r) => (
                        <span class={`role-badge ${r}`} style="margin-right:4px">{r}</span>
                      ))}
                    </>
                  ) : (
                    t('readmeVisibleAll')
                  )}
                </div>
              </div>
            ) : (
              <div style="color:var(--text-3);font-size:13px">
                {t('noReadme')} <span class="mono">readme: {'{'} enabled: true, path: './README.html' {'}'}</span> to show
                one next to the reference.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
