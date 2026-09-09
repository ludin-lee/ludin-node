import { useState } from 'preact/hooks';

/**
 * Collapsible JSON tree – used for request/response examples and Try-it-out
 * response bodies. Objects and arrays fold like a JSON pretty-printer; deep
 * levels start collapsed so large payloads stay scannable.
 */

const OPEN_DEPTH = 4;       // levels expanded by default
const MAX_ENTRIES = 300;    // per object/array, keeps huge payloads responsive

export function JsonView({ value }: { value: unknown }) {
  return (
    <pre class="json-tree">
      <Node v={value} depth={0} />
    </pre>
  );
}

function Node({ v, depth }: { v: unknown; depth: number }) {
  if (v === null) return <span class="j-null">null</span>;
  if (typeof v === 'string') return <span class="j-str">{JSON.stringify(v)}</span>;
  if (typeof v === 'number') return <span class="j-num">{String(v)}</span>;
  if (typeof v === 'boolean') return <span class="j-bool">{String(v)}</span>;
  if (typeof v !== 'object') return <span class="j-null">{String(v)}</span>;

  const isArr = Array.isArray(v);
  const entries = isArr ? (v as unknown[]).map((x, i) => [i, x] as const) : Object.entries(v as object);
  return <Branch isArr={isArr} entries={entries} depth={depth} />;
}

function Branch({ isArr, entries, depth }: { isArr: boolean; entries: ReadonlyArray<readonly [string | number, unknown]>; depth: number }) {
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const [b0, b1] = isArr ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) return <span class="j-punct">{b0}{b1}</span>;

  if (!open) {
    return (
      <span class="j-fold" onClick={() => setOpen(true)} title="Expand">
        <span class="j-arrow">▸</span>
        <span class="j-punct">{b0}</span>
        <span class="j-hint"> {entries.length} {isArr ? (entries.length === 1 ? 'item' : 'items') : (entries.length === 1 ? 'key' : 'keys')} </span>
        <span class="j-punct">{b1}</span>
      </span>
    );
  }

  const pad = '  '.repeat(depth + 1);
  const shown = entries.slice(0, MAX_ENTRIES);
  return (
    <>
      <span class="j-fold" onClick={() => setOpen(false)} title="Collapse">
        <span class="j-arrow">▾</span>
        <span class="j-punct">{b0}</span>
      </span>
      {'\n'}
      {shown.map(([k, val], i) => (
        <>
          {pad}
          {!isArr && (
            <>
              <span class="j-key">{JSON.stringify(String(k))}</span>
              <span class="j-punct">: </span>
            </>
          )}
          <Node v={val} depth={depth + 1} />
          {i < entries.length - 1 ? <span class="j-punct">,</span> : null}
          {'\n'}
        </>
      ))}
      {entries.length > MAX_ENTRIES && <>{pad}<span class="j-hint">… {entries.length - MAX_ENTRIES} more</span>{'\n'}</>}
      {'  '.repeat(depth)}
      <span class="j-punct">{b1}</span>
    </>
  );
}

/** Parse text as JSON for the tree view; null when it isn't (or is too big). */
export function parseForTree(text: string | null | undefined): unknown | null {
  if (!text || text.length > 500_000) return null;
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    return null;
  }
}
