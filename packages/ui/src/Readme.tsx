/**
 * The page configured through `readme`. It is framed rather than inlined: the
 * file is served in an opaque origin, so its own CSS and scripts run without
 * reaching the docs UI or its session cookie.
 */
export function Readme({ label, url }: { label: string; url: string }) {
  return (
    <iframe
      class="readme-frame"
      src={url}
      title={label}
      sandbox="allow-scripts allow-popups allow-forms allow-modals"
      referrerpolicy="no-referrer"
    />
  );
}
