import type { NextApiRequest, NextApiResponse } from "next";

const ALLOWED_HOSTS = [
  "lastfm.freetls.fastly.net",
  "lastfm-img2.akamaized.net",
];

function isAllowedAlbumImageUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (ALLOWED_HOSTS.includes(host)) return true;
  if (host.endsWith(".last.fm")) return true;
  if (host.endsWith(".supabase.co")) return true;
  return false;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url || !isAllowedAlbumImageUrl(url)) {
    return res.status(400).json({ error: "Invalid image url" });
  }

  const upstream = await fetch(url, { headers: { Accept: "image/*" } }).catch(() => null);
  if (!upstream?.ok) {
    return res.status(502).json({ error: "Could not load image" });
  }

  const contentType = upstream.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) {
    return res.status(400).json({ error: "Not an image" });
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length < 16 || buffer.length > 4 * 1024 * 1024) {
    return res.status(400).json({ error: "Invalid image size" });
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
  return res.status(200).send(buffer);
}
