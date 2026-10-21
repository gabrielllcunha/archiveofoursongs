import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabaseAdmin } from '@/utils/supabaseAdmin';
import { getSupabaseUserFromRequest } from '@/utils/server/getSupabaseUserFromRequest';
import { audioObjectPath } from '@/utils/secretPageMonthIndex';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb',
    },
  },
};

const BUCKET = 'secret-pages-audio';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authUser = await getSupabaseUserFromRequest(req);
  if (!authUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return res.status(500).json({ error: 'Missing Supabase service configuration' });
  }

  const { year, month, audioBase64, audio_filename } = req.body as {
    year?: number;
    month?: string;
    audioBase64?: string;
    audio_filename?: string;
  };

  if (typeof year !== 'number' || !month || !audioBase64) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(audioBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid audio data' });
  }

  if (buffer.length < 16) {
    return res.status(400).json({ error: 'File too small' });
  }
  if (buffer.length > 20 * 1024 * 1024) {
    return res.status(400).json({ error: 'File too large (max 20MB)' });
  }

  const userId = authUser.user.id;
  const path = audioObjectPath(userId, year, month);

  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buffer, {
    contentType: 'audio/mpeg',
    upsert: true,
  });

  if (upErr) {
    return res.status(502).json({ error: upErr.message });
  }

  const { data: existing, error: existingErr } = await admin
    .from('secret_pages')
    .select('content, album_cover_url')
    .eq('user_id', userId)
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();

  if (existingErr) {
    return res.status(502).json({ error: existingErr.message });
  }

  const safeName =
    typeof audio_filename === 'string' && audio_filename.trim()
      ? audio_filename.trim().slice(0, 240)
      : null;

  const { error: dbErr } = await admin.from('secret_pages').upsert(
    {
      user_id: userId,
      year,
      month,
      content: existing ? existing.content : '',
      album_cover_url: existing ? existing.album_cover_url : null,
      audio_storage_path: path,
      audio_original_filename: safeName,
      audio_start_seconds: 0,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,year,month' }
  );

  if (dbErr) {
    return res.status(502).json({ error: dbErr.message });
  }

  return res.status(200).json({ audio_storage_path: path });
}
