import type { ComponentChildren } from 'preact';

/** Centered dialog. Clicking the backdrop closes it. */
export function Modal({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal-card ${wide ? 'modal-wide' : ''}`}>
        <div class="card-h">
          {title} <span class="spacer" />
          <button class="btn btn-sm btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div class="card-b">{children}</div>
      </div>
    </div>
  );
}
