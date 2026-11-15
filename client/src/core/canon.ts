/** JCS (RFC 8785) for the JSON subset used by CRT: objects, arrays, strings, booleans, null and integers (no floats). */
export type Json = null | boolean | number | bigint | string | Json[] | { [k: string]: Json };

export function canonicalize(v: Json): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'string': return JSON.stringify(v);
    case 'bigint': return v.toString();
    case 'number':
      if (!Number.isSafeInteger(v)) throw new TypeError('canonicalize: only safe integers are allowed as numbers');
      return Object.is(v, -0) ? '0' : String(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
      // default sort compares UTF-16 code units, as RFC 8785 §3.2.3 requires
      const keys = Object.keys(v).sort();
      return '{' + keys.map((k) => {
        const val = (v as Record<string, Json>)[k];
        if (val === undefined) throw new TypeError(`canonicalize: undefined value at key ${k}`);
        return JSON.stringify(k) + ':' + canonicalize(val);
      }).join(',') + '}';
    }
    default: throw new TypeError(`canonicalize: unsupported type ${typeof v}`);
  }
}
