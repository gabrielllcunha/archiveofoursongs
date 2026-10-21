import { supabase } from '@/utils/supabase';
import { authenticatedFetch, UnauthorizedSessionError } from '@/utils/authenticatedFetch';
import * as idbSecretPages from '@/services/storage/idbSecretPages';
import {
  decryptSecretPageContentDetailed,
  encryptSecretPageContent,
} from '@/utils/secretPageCrypto';
import { ensureSecretPagesKeyMaterial } from '@/utils/ensureSecretPagesKeyMaterial';
import { isStoredFileAudioPath } from '@/utils/soundtrackSource';

export type SecretPageRecord = {
  content: string;
  audio_storage_path: string | null;
  album_cover_url: string | null;
  audio_original_filename: string | null;
  audio_start_seconds: number;
  audio_blob?: ArrayBuffer | null;
  decryptFailed?: boolean;
};

type CloudFetchResult = {
  record: SecretPageRecord | null;
  rawEncryptedContent: string | null;
  decryptFailed: boolean;
  needsReencryptWithSyncKey: boolean;
};

type StoreSecretPageOptions = {
  allowReplaceUnreadContent?: boolean;
};

function storedContentIsNonEmpty(value: string | null | undefined): boolean {
  return Boolean(value && value.trim());
}

const emptyRecord = (): SecretPageRecord => ({
  content: '',
  audio_storage_path: null,
  album_cover_url: null,
  audio_original_filename: null,
  audio_start_seconds: 0,
  audio_blob: null,
  decryptFailed: false,
});

async function requireSessionUserId(): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured');
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.user?.id) {
    throw new Error('Not authenticated');
  }
  return session.user.id;
}

function isBrowserIndexedDbAvailable() {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function mapRow(row: {
  content: string | null;
  audio_storage_path: string | null;
  album_cover_url: string | null;
  audio_original_filename: string | null;
  audio_start_seconds: number | null;
}): SecretPageRecord {
  const start = row.audio_start_seconds;
  return {
    content: row.content ?? '',
    audio_storage_path: row.audio_storage_path ?? null,
    album_cover_url: row.album_cover_url ?? null,
    audio_original_filename: row.audio_original_filename ?? null,
    audio_start_seconds: typeof start === 'number' && Number.isFinite(start) ? start : 0,
    audio_blob: null,
    decryptFailed: false,
  };
}

async function fetchSupabaseSecretPage(
  year: number,
  month: string
): Promise<CloudFetchResult> {
  if (!supabase) {
    return {
      record: null,
      rawEncryptedContent: null,
      decryptFailed: false,
      needsReencryptWithSyncKey: false,
    };
  }
  const userId = await requireSessionUserId();
  await ensureSecretPagesKeyMaterial();
  const { data, error } = await supabase
    .from('secret_pages')
    .select(
      'content, audio_storage_path, album_cover_url, audio_original_filename, audio_start_seconds'
    )
    .eq('user_id', userId)
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return {
      record: null,
      rawEncryptedContent: null,
      decryptFailed: false,
      needsReencryptWithSyncKey: false,
    };
  }

  const row = mapRow(data);
  const rawContent = data.content ?? '';
  const decrypted = await decryptSecretPageContentDetailed(userId, rawContent);

  if (decrypted.decryptFailed) {
    return {
      record: { ...row, content: '', decryptFailed: true },
      rawEncryptedContent: rawContent || null,
      decryptFailed: true,
      needsReencryptWithSyncKey: false,
    };
  }

  return {
    record: { ...row, content: decrypted.plaintext, decryptFailed: false },
    rawEncryptedContent: rawContent || null,
    decryptFailed: false,
    needsReencryptWithSyncKey: decrypted.needsReencryptWithSyncKey,
  };
}

async function upsertSupabaseSecretPage(
  year: number,
  month: string,
  record: SecretPageRecord,
  options?: { preserveEncryptedContent?: string | null; refuseContentWrite?: boolean }
) {
  if (!supabase) throw new Error('Supabase is not configured');
  const userId = await requireSessionUserId();

  const { data: existing, error: existingError } = await supabase
    .from('secret_pages')
    .select('content')
    .eq('user_id', userId)
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();
  if (existingError) throw existingError;

  const existingContent = existing?.content ?? '';
  let contentForStorage: string;
  if (options?.preserveEncryptedContent) {
    contentForStorage = options.preserveEncryptedContent;
  } else if (options?.refuseContentWrite && storedContentIsNonEmpty(existingContent)) {
    contentForStorage = existingContent;
  } else {
    contentForStorage = await encryptSecretPageContent(userId, record.content);
  }

  if (!storedContentIsNonEmpty(contentForStorage) && storedContentIsNonEmpty(existingContent)) {
    contentForStorage = existingContent;
  }

  const { error } = await supabase.from('secret_pages').upsert(
    {
      user_id: userId,
      year,
      month,
      content: contentForStorage,
      audio_storage_path: record.audio_storage_path,
      album_cover_url: record.album_cover_url,
      audio_original_filename: record.audio_original_filename,
      audio_start_seconds: record.audio_start_seconds,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,year,month' }
  );
  if (error) throw error;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = reader.result as string;
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function toIdbPayload(record: SecretPageRecord): idbSecretPages.SecretPageIdbValue {
  return {
    content: record.content,
    audio_storage_path: record.audio_storage_path,
    album_cover_url: record.album_cover_url,
    audio_original_filename: record.audio_original_filename,
    audio_start_seconds: record.audio_start_seconds,
    audio_blob: record.audio_blob ?? undefined,
  };
}

export const secretPagesStorage = {
  async getSecretPage(lastfmUsername: string, year: number, month: string): Promise<SecretPageRecord> {
    if (!isBrowserIndexedDbAvailable()) {
      if (!supabase) return emptyRecord();
      try {
        const fetched = await fetchSupabaseSecretPage(year, month);
        if (
          fetched.record &&
          fetched.needsReencryptWithSyncKey &&
          !fetched.decryptFailed &&
          storedContentIsNonEmpty(fetched.record.content)
        ) {
          void upsertSupabaseSecretPage(year, month, fetched.record).catch(() => undefined);
        }
        return fetched.record ?? emptyRecord();
      } catch {
        return { ...emptyRecord(), decryptFailed: true };
      }
    }

    if (supabase) {
      try {
        const fetched = await fetchSupabaseSecretPage(year, month);
        if (fetched.record !== null) {
          if (
            fetched.needsReencryptWithSyncKey &&
            !fetched.decryptFailed &&
            storedContentIsNonEmpty(fetched.record.content)
          ) {
            void upsertSupabaseSecretPage(year, month, fetched.record).catch(() => undefined);
          }
          if (!fetched.decryptFailed && isBrowserIndexedDbAvailable()) {
            void idbSecretPages
              .storeSecretPageRecord(lastfmUsername, year, month, toIdbPayload(fetched.record))
              .catch(() => undefined);
          }
          return fetched.record;
        }
        return emptyRecord();
      } catch {
        const local = await idbSecretPages.getSecretPageRecord(lastfmUsername, year, month);
        const localEmpty = !storedContentIsNonEmpty(local.content);
        return {
          content: local.content,
          audio_storage_path: local.audio_storage_path,
          album_cover_url: local.album_cover_url,
          audio_original_filename: local.audio_original_filename,
          audio_start_seconds: local.audio_start_seconds,
          audio_blob: local.audio_blob ?? null,
          decryptFailed: localEmpty,
        };
      }
    }

    const local = await idbSecretPages.getSecretPageRecord(lastfmUsername, year, month);
    return {
      content: local.content,
      audio_storage_path: local.audio_storage_path,
      album_cover_url: local.album_cover_url,
      audio_original_filename: local.audio_original_filename,
      audio_start_seconds: local.audio_start_seconds,
      audio_blob: local.audio_blob ?? null,
      decryptFailed: false,
    };
  },

  async storeSecretPage(
    lastfmUsername: string,
    year: number,
    month: string,
    patch: Partial<SecretPageRecord>,
    options?: StoreSecretPageOptions
  ): Promise<void> {
    let base = emptyRecord();
    let preserveEncryptedContent: string | null = null;
    let decryptFailed = false;
    let cloudUnreachable = false;
    let existingRawContent: string | null = null;

    if (supabase) {
      try {
        const fetched = await fetchSupabaseSecretPage(year, month);
        if (fetched.record) {
          base = { ...fetched.record };
          decryptFailed = fetched.decryptFailed;
          existingRawContent = fetched.rawEncryptedContent;
          const incomingContent = patch.content;
          const incomingEmpty = incomingContent === undefined || !incomingContent.trim();
          const refuseUnreadReplace = decryptFailed && !options?.allowReplaceUnreadContent;
          if (fetched.rawEncryptedContent && (incomingEmpty || refuseUnreadReplace)) {
            preserveEncryptedContent = fetched.rawEncryptedContent;
          }
          if (incomingEmpty && storedContentIsNonEmpty(fetched.rawEncryptedContent)) {
            preserveEncryptedContent = fetched.rawEncryptedContent;
          }
        }
      } catch {
        cloudUnreachable = true;
        const local = await idbSecretPages.getSecretPageRecord(lastfmUsername, year, month);
        base = {
          content: local.content,
          audio_storage_path: local.audio_storage_path,
          album_cover_url: local.album_cover_url,
          audio_original_filename: local.audio_original_filename,
          audio_start_seconds: local.audio_start_seconds,
          audio_blob: local.audio_blob ?? null,
          decryptFailed: false,
        };
      }
    } else if (isBrowserIndexedDbAvailable()) {
      const local = await idbSecretPages.getSecretPageRecord(lastfmUsername, year, month);
      base = {
        content: local.content,
        audio_storage_path: local.audio_storage_path,
        album_cover_url: local.album_cover_url,
        audio_original_filename: local.audio_original_filename,
        audio_start_seconds: local.audio_start_seconds,
        audio_blob: local.audio_blob ?? null,
        decryptFailed: false,
      };
    }

    const incomingEmpty = patch.content === undefined || !patch.content.trim();
    const refuseUnreadReplace = decryptFailed && !options?.allowReplaceUnreadContent;
    if ((decryptFailed && incomingEmpty) || refuseUnreadReplace || (incomingEmpty && storedContentIsNonEmpty(existingRawContent))) {
      const { content: _ignored, decryptFailed: _df, ...safePatch } = patch;
      patch = safePatch;
      if (Object.keys(patch).length === 0 && (preserveEncryptedContent || incomingEmpty)) {
        return;
      }
    }

    const next: SecretPageRecord = {
      ...base,
      ...patch,
      audio_blob: patch.audio_blob !== undefined ? patch.audio_blob : base.audio_blob,
      audio_start_seconds:
        patch.audio_start_seconds !== undefined ? patch.audio_start_seconds : base.audio_start_seconds,
      audio_original_filename:
        patch.audio_original_filename !== undefined
          ? patch.audio_original_filename
          : base.audio_original_filename,
      decryptFailed: false,
    };

    if (decryptFailed && options?.allowReplaceUnreadContent && storedContentIsNonEmpty(patch.content)) {
      preserveEncryptedContent = null;
    }

    if (cloudUnreachable) {
      if (isBrowserIndexedDbAvailable()) {
        await idbSecretPages.storeSecretPageRecord(lastfmUsername, year, month, toIdbPayload(next));
      }
      return;
    }

    const upsertOptions = {
      preserveEncryptedContent,
      refuseContentWrite: Boolean(preserveEncryptedContent) || refuseUnreadReplace,
    };

    if (!isBrowserIndexedDbAvailable()) {
      if (!supabase) return;
      try {
        await upsertSupabaseSecretPage(year, month, next, upsertOptions);
      } catch {
      }
      return;
    }

    if (supabase) {
      try {
        await upsertSupabaseSecretPage(year, month, next, upsertOptions);
        if (!preserveEncryptedContent) {
          await idbSecretPages.storeSecretPageRecord(
            lastfmUsername,
            year,
            month,
            toIdbPayload(next)
          );
        }
        return;
      } catch {
        await idbSecretPages.storeSecretPageRecord(lastfmUsername, year, month, toIdbPayload(next));
        return;
      }
    }

    await idbSecretPages.storeSecretPageRecord(lastfmUsername, year, month, toIdbPayload(next));
  },

  async uploadAudioFile(lastfmUsername: string, year: number, month: string, file: File): Promise<void> {
    const looksAudio =
      !file.type ||
      file.type.startsWith('audio/') ||
      /\.(mp3|m4a|aac|wav|ogg|flac|webm)$/i.test(file.name);
    if (!looksAudio) {
      throw new Error('Only audio files are allowed');
    }
    const audioBase64 = await fileToBase64(file);
    const res = await authenticatedFetch('/api/secret-pages/upload-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        year,
        month,
        audioBase64,
        audio_filename: file.name,
      }),
    });

    if (!res.ok) {
      const buf = await file.arrayBuffer();
      await secretPagesStorage.storeSecretPage(lastfmUsername, year, month, {
        audio_blob: buf,
        audio_storage_path: null,
        audio_original_filename: file.name.slice(0, 240),
        audio_start_seconds: 0,
      });
      throw new Error('Upload failed; saved locally only');
    }

    await res.json().catch(() => ({}));
  },

  async setExternalSoundtrack(
    lastfmUsername: string,
    year: number,
    month: string,
    path: string,
    filename: string
  ): Promise<void> {
    await secretPagesStorage.removeAudioFile(lastfmUsername, year, month);
    await secretPagesStorage.storeSecretPage(lastfmUsername, year, month, {
      audio_storage_path: path,
      audio_original_filename: filename.slice(0, 240),
      audio_start_seconds: 0,
      audio_blob: null,
    });
  },

  async removeAudioFile(lastfmUsername: string, year: number, month: string): Promise<boolean> {
    let serverOk = false;
    try {
      const res = await authenticatedFetch('/api/secret-pages/delete-audio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ year, month }),
      });
      serverOk = res.ok;
    } catch (error) {
      if (error instanceof UnauthorizedSessionError) throw error;
      serverOk = false;
    }

    await secretPagesStorage.storeSecretPage(lastfmUsername, year, month, {
      audio_storage_path: null,
      audio_blob: null,
      audio_original_filename: null,
      audio_start_seconds: 0,
    });

    return serverOk;
  },

  async getAudioPlaybackUrl(
    year: number,
    month: string,
    record: SecretPageRecord
  ): Promise<string | null> {
    if (record.audio_blob && record.audio_blob.byteLength > 0) {
      return URL.createObjectURL(new Blob([record.audio_blob], { type: 'audio/mpeg' }));
    }
    if (!isStoredFileAudioPath(record.audio_storage_path)) return null;

    const res = await authenticatedFetch('/api/secret-pages/audio-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ year, month }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { url?: string | null };
    return data.url ?? null;
  },
};
