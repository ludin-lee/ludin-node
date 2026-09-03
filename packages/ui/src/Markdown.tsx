import { useMemo } from 'preact/hooks';
import { renderMarkdown } from './md';

/** Renders a Markdown subset. The source is HTML-escaped before decoration. */
export function Markdown({ text, class: className = 'md' }: { text: string; class?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
