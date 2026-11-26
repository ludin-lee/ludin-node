import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { t } from './i18n';

// Themed replacement for window.prompt / window.confirm. Resolves to the
// entered text (prompt) / true (confirm), or null / false when dismissed.
function open<T>(message: string, withInput: boolean, anchor: HTMLElement | undefined, dismissed: T, accepted: (v: string) => T): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const done = (v: T) => { render(null, host); host.remove(); resolve(v); };
    render(<Dialog anchor={anchor} message={message} withInput={withInput} onCancel={() => done(dismissed)} onOk={(v) => done(accepted(v))} />, host);
  });
}

export const askText = (message: string, anchor?: HTMLElement) => open<string | null>(message, true, anchor, null, (v) => v);
export const askConfirm = (message: string) => open<boolean>(message, false, undefined, false, () => true);

function Dialog(p: { anchor?: HTMLElement; message: string; withInput: boolean; onCancel: () => void; onOk: (v: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => (p.withInput ? input : ok).current?.focus(), []);
  // With an anchor, pop out of it as a speech bubble instead of a centered modal.
  const r = p.anchor?.getBoundingClientRect();
  const bubble = r && { top: `${r.bottom + 10}px`, left: `${Math.max(8, Math.min(r.left, innerWidth - 408))}px`, '--ox': `${Math.min(r.width / 2, 40)}px` };
  return (
    <div class={`palette-backdrop${r ? ' bubble-backdrop' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && p.onCancel()}>
      <form
        class={`palette dialog${r ? ' bubble' : ''}`}
        style={bubble || undefined}
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => e.key === 'Escape' && p.onCancel()}
        onSubmit={(e) => { e.preventDefault(); p.onOk(input.current?.value ?? ''); }}
      >
        <div class="dialog-body">
          <p>{p.message}</p>
          {p.withInput && <input ref={input} type="text" />}
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn btn-sm btn-ghost" onClick={p.onCancel}>{t('cancel')}</button>
          <button type="submit" class="btn btn-sm btn-primary" ref={ok}>{t('confirm')}</button>
        </div>
      </form>
    </div>
  );
}
