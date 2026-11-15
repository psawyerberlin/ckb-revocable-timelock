export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

export const short = (hex: string, keep = 8): string => (hex.length > 2 * keep + 4 ? `${hex.slice(0, keep + 2)}…${hex.slice(-keep)}` : hex);
