import { useEffect, useState } from 'preact/hooks';
import { api, type DiffInfo } from './api';
import { t, type MsgKey } from './i18n';

/**
 * The changes view: what moved between the configured baseline and the
 * document being served. Both sides are role-filtered by the core, so this
 * never reveals an operation the viewer cannot otherwise see.
 */

/** Short localized label per change kind; the location and params carry the specifics. */
const KIND_LABELS: Record<string, MsgKey> = {
  'path-added': 'chgPathAdded',
  'path-removed': 'chgPathRemoved',
  'operation-added': 'chgOpAdded',
  'operation-removed': 'chgOpRemoved',
  'operation-deprecated': 'chgOpDeprecated',
  'param-added-required': 'chgParamAddedRequired',
  'param-added-optional': 'chgParamAdded',
  'param-removed': 'chgParamRemoved',
  'param-required-added': 'chgParamNowRequired',
  'property-added-required': 'chgPropRequired',
  'property-added': 'chgPropAdded',
  'property-removed': 'chgPropRemoved',
  'type-changed': 'chgTypeChanged',
  'enum-value-removed': 'chgEnumRemoved',
  'enum-value-added': 'chgEnumAdded',
  'response-added': 'chgResponseAdded',
  'response-removed': 'chgResponseRemoved',
  'request-body-required': 'chgBodyRequired',
  'security-added': 'chgSecurityAdded',
  'security-removed': 'chgSecurityRemoved',
};

function label(kind: string): string {
  const key = KIND_LABELS[kind];
  return key ? t(key) : kind;
}

export function Changes({ specName }: { specName: string }) {
  const [diff, setDiff] = useState<DiffInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDiff(null);
    setErr(null);
    api.diff(specName).then(setDiff).catch((e) => setErr(e.message));
  }, [specName]);

  if (err) return <div class="notice err">{err}</div>;
  if (!diff) return <div style="padding:20px;text-align:center"><span class="spin" /></div>;

  const breaking = diff.changes.filter((c) => c.breaking);
  const compatible = diff.changes.filter((c) => !c.breaking);

  const list = (changes: DiffInfo['changes']) => (
    <div class="card-b" style="padding:4px 14px">
      {changes.map((c) => (
        <div class="param" style="grid-template-columns:180px 1fr">
          <span class={`chg-kind ${c.breaking ? 'breaking' : ''}`}>{label(c.kind)}</span>
          <span class="desc">
            <code>{c.at}</code>
            {c.params && Object.keys(c.params).length > 0 && (
              <span class="mono" style="color:var(--text-3);margin-left:8px;font-size:11.5px">
                {Object.values(c.params).join(' · ')}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div>
      <div class="op-head">
        <h1>{t('changes')}</h1>
        <div class="op-path">
          {(diff.versions.before || diff.versions.after) && (
            <span class="chip">
              {diff.versions.before ?? '?'} → {diff.versions.after ?? '?'}
            </span>
          )}
          <span class={`chip ${diff.breaking ? 'chip-breaking' : ''}`}>{t('breakingCount', { n: diff.breaking })}</span>
          <span class="chip">{t('compatibleCount', { n: diff.nonBreaking })}</span>
        </div>
      </div>

      {diff.changes.length === 0 && <div class="notice ok">{t('noChanges')}</div>}

      {breaking.length > 0 && (
        <div class="card" style="margin-bottom:14px">
          <div class="card-h">{t('breakingChanges')} <span class="count" style="font-weight:400">{breaking.length}</span></div>
          {list(breaking)}
        </div>
      )}
      {compatible.length > 0 && (
        <div class="card" style="margin-bottom:14px">
          <div class="card-h">{t('compatibleChanges')} <span class="count" style="font-weight:400">{compatible.length}</span></div>
          {list(compatible)}
        </div>
      )}
    </div>
  );
}
