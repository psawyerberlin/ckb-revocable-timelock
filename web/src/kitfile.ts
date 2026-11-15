import { validateDescriptor, type Descriptor, type Envelope } from '@crt/client';

export interface ParsedKit { descriptor: Descriptor; envelopes: Envelope[] }

/** Reads descriptor and envelopes out of a kit HTML file (`#crt-descriptor`, `#crt-envelopes`). Throws on anything else. */
export function parseKit(html: string): ParsedKit {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const d = doc.getElementById('crt-descriptor')?.textContent;
  const e = doc.getElementById('crt-envelopes')?.textContent;
  if (!d || !e) throw new Error('This file is not a CRT recovery kit (no descriptor or envelopes found).');
  const envelopes = JSON.parse(e) as Envelope[];
  if (!Array.isArray(envelopes)) throw new Error('The kit envelopes are malformed.');
  return { descriptor: validateDescriptor(JSON.parse(d)), envelopes };
}
