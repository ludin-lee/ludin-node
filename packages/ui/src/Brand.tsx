import { boot } from './config';

export function Brand() {
  const t = boot.theme ?? {};
  const title = t.title || 'API Docs';
  return (
    <div class="brand">
      {t.logo ? <img src={t.logo} alt="" /> : <span class="brand-mark">{title.slice(0, 1).toUpperCase()}</span>}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{title}</span>
    </div>
  );
}
