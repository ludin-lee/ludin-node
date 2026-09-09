import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type SearchEntry } from './api';

/**
 * ⌘K command palette. The index (operations + schema field names) comes from
 * the core, already filtered for the caller's role — this component only
 * matches and renders.
 */

const opId = (e: SearchEntry) => e.operationId || `${e.method.toLowerCase()}-${e.path}`.replace(/[^a-zA-Z0-9]+/g, '-');

interface Hit {
  entry: SearchEntry;
  score: number;
  /** The schema field that matched, when the path/summary did not. */
  field?: string;
}

function match(entries: SearchEntry[], q: string): Hit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries.slice(0, 30).map((entry) => ({ entry, score: 0 }));
  const hits: Hit[] = [];
  for (const entry of entries) {
    const path = entry.path.toLowerCase();
    const hay = `${entry.method} ${path} ${entry.operationId ?? ''} ${entry.summary ?? ''} ${entry.tags.join(' ')}`.toLowerCase();
    let score = 0;
    let field: string | undefined;
    if (path.includes(needle)) score = path.startsWith(needle) ? 100 : 80;
    else if ((entry.operationId ?? '').toLowerCase().includes(needle)) score = 70;
    else if (hay.includes(needle)) score = 50;
    else {
      field = entry.fields.find((f) => f.toLowerCase().includes(needle));
      if (field) score = field.toLowerCase() === needle ? 40 : 25;
    }
    if (score) hits.push({ entry, score, field });
  }
  return hits.sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length).slice(0, 30);
}

export function Palette({ specName, onClose }: { specName: string; onClose: () => void }) {
  const [index, setIndex] = useState<SearchEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    api.searchIndex(specName).then((r) => setIndex(r.index)).catch((e) => setErr(e.message));
  }, [specName]);

  const hits = useMemo(() => (index ? match(index, q) : []), [index, q]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  function go(hit: Hit) {
    location.hash = `#/op/${encodeURIComponent(opId(hit.entry))}`;
    onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(sel + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(sel - 1, 0)); }
    else if (e.key === 'Enter' && hits[sel]) go(hits[sel]);
    else if (e.key === 'Escape') onClose();
  }

  return (
    <div class="palette-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="palette" role="dialog" aria-label="Search">
        <input
          ref={inputRef}
          placeholder="Search paths, operations, schema fields…"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={onKey}
        />
        <div class="palette-list" ref={listRef}>
          {err && <div class="notice err">{err}</div>}
          {!index && !err && <div class="palette-empty"><span class="spin" /></div>}
          {index && hits.length === 0 && <div class="palette-empty">No matches</div>}
          {hits.map((h, i) => (
            <button class={`palette-item ${i === sel ? 'active' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
              <span class={`method ${h.entry.method.toLowerCase()}`}>{h.entry.method}</span>
              <span class="path">{h.entry.path}</span>
              {h.field && <span class="tag" title="matched a schema field">field: {h.field}</span>}
              <span class="palette-summary">{h.entry.summary ?? ''}</span>
            </button>
          ))}
        </div>
        <div class="palette-foot">↑↓ navigate · ↵ open · esc close</div>
      </div>
    </div>
  );
}
