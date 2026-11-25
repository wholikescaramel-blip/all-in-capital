// Phone numbers: Indian mobiles (10 digits starting 6-9, with or without 0/91/+91) and international numbers written with a +.
export function normalisePhone(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const plus = raw.trim().startsWith("+");
  const d = raw.replace(/\D/g, "");
  if (!plus && d.length === 10 && /^[6-9]/.test(d)) return "+91" + d;
  if (!plus && d.length === 12 && d.startsWith("91") && /^[6-9]/.test(d.slice(2))) return "+" + d;
  if (!plus && d.length === 11 && d.startsWith("0") && /^[6-9]/.test(d.slice(1))) return "+91" + d.slice(1);
  if (plus && d.length >= 10 && d.length <= 15) return "+" + d;
  return undefined;
}

export function findPhone(text: string): string | undefined {
  for (const m of text.match(/\+?\d[\d\s().-]{8,16}\d/g) ?? []) { const p = normalisePhone(m); if (p) return p; }
  return undefined;
}
