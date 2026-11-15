import type { Runner } from '@crt/client';

export interface CoalitionSummary {
  count: number;
  countries: Map<string, number>;
  asns: Map<string, number>;
  unknownLocation: number;
  unproven: number;
  /** warnings in plain language; empty when the set looks spread out */
  warnings: string[];
  text: string;
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Coalition risk of the chosen set: operator / ASN / country concentration (SPEC §9). */
export function coalitionSummary(chosen: Runner[]): CoalitionSummary {
  const countries = new Map<string, number>();
  const asns = new Map<string, number>();
  let unknownLocation = 0;
  let unproven = 0;
  for (const r of chosen) {
    if (r.unproven) unproven++;
    const [country, asn] = (r.diversityKey ?? '').split('/');
    if (!r.diversityKey) { unknownLocation++; continue; }
    if (country && country !== '?') bump(countries, country);
    if (asn && asn !== '?') bump(asns, asn);
  }
  const warnings: string[] = [];
  const n = chosen.length;
  if (n === 0) {
    return { count: 0, countries, asns, unknownLocation, unproven, warnings, text: 'No runners selected yet.' };
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  const tc = top(countries);
  if (tc && n > 1 && tc[1] / n > 0.5) warnings.push(`${tc[1]} of ${n} runners are in ${tc[0]}: one legal system could reach most of them.`);
  const ta = top(asns);
  if (ta && ta[1] > 1) warnings.push(`${ta[1]} runners share network ${ta[0]}: one network operator could take them offline together.`);
  if (unknownLocation > 0) warnings.push(`${unknownLocation} of ${n} runners have no declared country or network, so their concentration cannot be judged.`);
  if (unproven > 0) warnings.push(`${unproven} of ${n} runners are unproven: no observed CRT performance yet.`);
  const text = `${n} runners in ${countries.size} countries and ${asns.size} networks. ` + (warnings.length ? warnings.join(' ') : 'No concentration found.');
  return { count: n, countries, asns, unknownLocation, unproven, warnings, text };
}
