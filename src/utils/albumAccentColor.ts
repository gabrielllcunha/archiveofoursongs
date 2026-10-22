const accentCache = new Map<string, string>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h /= 6;
  if (h < 0) h += 1;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function toDisplayAccent(r: number, g: number, b: number): string {
  const [h, s, l] = rgbToHsl(r, g, b);
  const nextS = Math.max(0.58, Math.min(0.92, s * 1.2 + 0.08));
  const nextL = Math.min(0.64, Math.max(0.5, l < 0.38 ? 0.54 : l > 0.72 ? 0.58 : l));
  const [nr, ng, nb] = hslToRgb(h, nextS, nextL);
  return `${nr}, ${ng}, ${nb}`;
}

function accentFromBitmap(bitmap: ImageBitmap): string | null {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const buckets = new Map<number, { w: number; r: number; g: number; b: number }>();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);
    if (l < 0.07 || l > 0.93) continue;
    if (s < 0.08) continue;
    const mid = 1 - Math.abs(l - 0.46) * 1.35;
    const weight = Math.max(0.05, s * Math.max(0.18, mid));
    const key = Math.round(h * 24) * 2 + (s >= 0.28 ? 1 : 0);
    const cur = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
    cur.w += weight;
    cur.r += r * weight;
    cur.g += g * weight;
    cur.b += b * weight;
    buckets.set(key, cur);
  }

  const best = Array.from(buckets.values()).reduce<{ w: number; r: number; g: number; b: number } | null>((acc, cur) => {
    if (!acc || cur.w > acc.w) return cur;
    return acc;
  }, null);
  if (!best || best.w <= 0) return null;
  return toDisplayAccent(best.r / best.w, best.g / best.w, best.b / best.w);
}

export async function extractAlbumAccentColor(imageUrl: string): Promise<string | null> {
  const cached = accentCache.get(imageUrl);
  if (cached) return cached;
  const res = await fetch(`/api/album-image?url=${encodeURIComponent(imageUrl)}`);
  if (!res.ok) return null;
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) return null;
  const bitmap = await createImageBitmap(blob);
  const accent = accentFromBitmap(bitmap);
  bitmap.close();
  if (accent) accentCache.set(imageUrl, accent);
  return accent;
}
