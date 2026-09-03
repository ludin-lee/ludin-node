import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/md.js';

test('markdown: escapes HTML before decorating', () => {
  const html = renderMarkdown('<script>alert(1)</script> **bold**');
  assert.ok(!html.includes('<script>'), 'no raw script tag');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
});

test('markdown: refuses script-bearing link and image targets', () => {
  const link = renderMarkdown('[click](javascript:alert(1))');
  assert.ok(!link.includes('href'), 'javascript: link is rendered as plain text');
  assert.match(link, /click/);

  const img = renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)');
  assert.ok(!img.includes('<img'), 'data: image is dropped');

  const ok = renderMarkdown('[docs](https://example.com/a) and [rel](/guide)');
  assert.match(ok, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(ok, /<a href="\/guide"/);
});

test('markdown: headings, lists, quotes, rules and code', () => {
  const html = renderMarkdown(
    ['# Title', '', 'Intro *text*.', '', '- one', '- two', '', '1. first', '', '> quoted', '', '---', '', '`inline`'].join('\n'),
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>Intro <em>text<\/em>.<\/p>/);
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>first<\/li>\n<\/ol>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<code>inline<\/code>/);
});

test('markdown: fenced code keeps its content verbatim', () => {
  const html = renderMarkdown('```ts\nconst a = 1 < 2 && "x";\n```');
  assert.match(html, /<pre class="md-code" data-lang="ts"><code>/);
  assert.match(html, /const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;;/);
  assert.ok(!/<em>|<strong>/.test(html), 'inline rules do not touch code');
});
