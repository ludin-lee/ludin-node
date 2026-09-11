import { useState } from 'preact/hooks';
import { boot, isDark } from './config';

/** Platform name + logo in the top-left corner. */
export function Brand() {
  const t = boot.theme ?? {};
  const title = t.title || 'API Docs';
  const [broken, setBroken] = useState(false);

  // A logo made for a light background disappears on dark; `logoDark` opts out.
  const src = t.logoDark && isDark() ? t.logoDark : t.logo;

  return (
    <div class="brand">
      {src && !broken ? (
        <img src={src} alt="" onError={() => setBroken(true)} />
      ) : (
        <span class="brand-mark">{title.slice(0, 1).toUpperCase()}</span>
      )}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{title}</span>
    </div>
  );
}
