import { deref, schemaTypeLabel, type Doc } from './openapi';

interface Props {
  doc: Doc;
  schema: any;
  name?: string;
  required?: boolean;
  depth?: number;
  seen?: string[];
  description?: string;
  open?: boolean;
}

/** Recursive, collapsible schema tree. */
export function Schema({ doc, schema, name, required, depth = 0, seen = [], description, open }: Props) {
  const s = deref(doc, schema);
  if (!s) return null;
  const refName: string | undefined = s.__refName;
  const cyclic = refName ? seen.includes(refName) : false;
  const nextSeen = refName ? [...seen, refName] : seen;
  const label = schemaTypeLabel(doc, schema);

  const props: Array<[string, any]> = Object.entries(s.properties ?? {});
  const variants: any[] | undefined = s.oneOf ?? s.anyOf;
  const allOf: any[] | undefined = s.allOf;
  const items = s.items;
  const addl = s.additionalProperties && typeof s.additionalProperties === 'object' ? s.additionalProperties : null;
  const expandable = !cyclic && (props.length > 0 || variants || allOf || items || addl);

  const head = (
    <span class="row">
      {name != null && (
        <span class="k">
          {name}
          {required && <span class="tag req" style="margin-left:6px">required</span>}
        </span>
      )}
      <span class="type">{label}</span>
      {s.nullable && <span class="tag">nullable</span>}
      {s.readOnly && <span class="tag">readOnly</span>}
      {s.writeOnly && <span class="tag">writeOnly</span>}
      {s.deprecated && <span class="tag">deprecated</span>}
      {s.format && !label.includes('<') && <span class="tag">{s.format}</span>}
      {s.enum && <span class="tag">enum: {s.enum.map(String).join(' | ')}</span>}
      {s.default !== undefined && <span class="tag">default: {JSON.stringify(s.default)}</span>}
      {s.minimum !== undefined && <span class="tag">min {s.minimum}</span>}
      {s.maximum !== undefined && <span class="tag">max {s.maximum}</span>}
      {s.minLength !== undefined && <span class="tag">minLen {s.minLength}</span>}
      {s.maxLength !== undefined && <span class="tag">maxLen {s.maxLength}</span>}
      {s.pattern && <span class="tag">/{s.pattern}/</span>}
      {(description ?? s.description) && <span class="d">{description ?? s.description}</span>}
      {cyclic && <span class="tag">recursive</span>}
    </span>
  );

  if (!expandable) return <div class="schema">{head}</div>;

  const body = (
    <div class="nest">
      {props.map(([k, v]) => (
        <Schema doc={doc} schema={v} name={k} required={s.required?.includes(k)} depth={depth + 1} seen={nextSeen} />
      ))}
      {addl && <Schema doc={doc} schema={addl} name="[key: string]" depth={depth + 1} seen={nextSeen} />}
      {items && !props.length && <Schema doc={doc} schema={items} name="[item]" depth={depth + 1} seen={nextSeen} />}
      {variants?.map((v, i) => (
        <Schema doc={doc} schema={v} name={`${s.oneOf ? 'one of' : 'any of'} #${i + 1}`} depth={depth + 1} seen={nextSeen} />
      ))}
      {allOf?.map((v, i) => (
        <Schema doc={doc} schema={v} name={`all of #${i + 1}`} depth={depth + 1} seen={nextSeen} open />
      ))}
    </div>
  );

  return (
    <details class="schema" open={open ?? depth < 2}>
      <summary>{head}</summary>
      {body}
    </details>
  );
}
