/**
 * A small, dependency-free Markdown subset renderer.
 *
 * Input is HTML-escaped *first* and only then decorated, so notice bodies and
 * OpenAPI descriptions can never inject markup. Link targets are restricted to
 * http(s), mailto and relative URLs (no `javascript:`).
 */
export function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source ?? '');
  const codeBlocks: string[] = [];

  // Pull fenced code out first so its contents are not touched by inline rules.
  const text = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    codeBlocks.push(
      `<pre class="md-code"${lang ? ` data-lang="${lang}"` : ''}><code>${code.replace(/\n$/, '')}</code></pre>`,
    );
    return `@@CODE${codeBlocks.length - 1}@@`;
  });

  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const closeParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed) {
      closeParagraph();
      closeList();
      continue;
    }
    if (/^@@CODE\d+@@$/.test(trimmed)) {
      closeParagraph();
      closeList();
      out.push(trimmed);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeParagraph();
      closeList();
      out.push('<hr>');
      continue;
    }
    const quote = /^&gt;\s?(.*)$/.exec(trimmed);
    if (quote) {
      closeParagraph();
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      closeParagraph();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(trimmed);
  }
  closeParagraph();
  closeList();

  return out.join('\n').replace(/@@CODE(\d+)@@/g, (_m, i: string) => codeBlocks[Number(i)]);
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) =>
      safeUrl(src) ? `<img src="${src}" alt="${alt}" loading="lazy">` : alt,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
      safeUrl(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

/** Only schemes that cannot execute script. */
function safeUrl(url: string): boolean {
  const value = url.trim().toLowerCase();
  if (/^(https?:|mailto:)/.test(value)) return true;
  return !/^[a-z0-9+.-]*:/.test(value); // relative URLs
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
