import type { Descriptor } from '@crt/client';

/** The secret `K` lives in memory only, never in storage. The kit (encrypted envelopes only) is kept in sessionStorage. */
export const memory: { K: Uint8Array | null; descriptor: Descriptor | null; hash: string | null } = { K: null, descriptor: null, hash: null };

const KIT = 'crt.kit';
export const saveKit = (html: string, name: string): void => { try { sessionStorage.setItem(KIT, JSON.stringify({ html, name })); } catch { /* ignore */ } };
export const loadKit = (): { html: string; name: string } | null => {
  try { const v = JSON.parse(sessionStorage.getItem(KIT) ?? 'null'); return v && typeof v.html === 'string' ? v : null; } catch { return null; }
};
export const clearKit = (): void => { try { sessionStorage.removeItem(KIT); } catch { /* ignore */ } };
