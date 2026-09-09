import { useEffect, useState } from 'preact/hooks';
import { api, type AdminInfo } from './api';
import { t } from './i18n';

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
