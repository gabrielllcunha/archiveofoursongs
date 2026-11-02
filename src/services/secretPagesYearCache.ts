import type { SecretPageRecord } from '@/services/secretPagesStorage';

export const SECRET_PAGE_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

type Slot = {
  record: SecretPageRecord;
  rawEncryptedContent: string | null;
  revision: number;
};

type YearBucket = {
  loaded: boolean;
  slots: Map<string, Slot>;
};

type AudioUrlSlot = {
  url: string;
  path: string | null;
  blob: boolean;
  expiresAt: number;
};

const years = new Map<string, YearBucket>();
const audioUrls = new Map<string, AudioUrlSlot>();
const warmedImages = new Set<string>();
const listeners = new Set<() => void>();
let generation = 0;

export function secretPageCacheGeneration() {
  return generation;
}

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribeSecretPageCache(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function yearKey(username: string, year: number) {
  return `${username}::${year}`;
}

function audioKey(year: number, month: string) {
  return `${year}::${month}`;
}

function emptyRecord(): SecretPageRecord {
  return {
    content: '',
    audio_storage_path: null,
    album_cover_url: null,
    audio_original_filename: null,
    audio_start_seconds: 0,
    audio_blob: null,
    decryptFailed: false,
  };
}

function bucketFor(username: string, year: number) {
  const key = yearKey(username, year);
  let bucket = years.get(key);
  if (!bucket) {
    bucket = { loaded: false, slots: new Map() };
    years.set(key, bucket);
  }
  return bucket;
}

export function isSecretPageYearLoaded(username: string, year: number) {
  return years.get(yearKey(username, year))?.loaded === true;
}

export function peekSecretPage(username: string, year: number, month: string): SecretPageRecord | null {
  const bucket = years.get(yearKey(username, year));
  if (!bucket?.loaded) return null;
  return bucket.slots.get(month)?.record ?? emptyRecord();
}

export function peekSecretPageSlot(username: string, year: number, month: string): Slot | null {
  const bucket = years.get(yearKey(username, year));
  if (!bucket?.loaded) return null;
  return bucket.slots.get(month) ?? null;
}

export function rememberSecretPageLocal(username: string, year: number, month: string, record: SecretPageRecord, rawEncryptedContent?: string | null) {
  const bucket = bucketFor(username, year);
  const prev = bucket.slots.get(month);
  bucket.slots.set(month, {
    record: { ...record, audio_blob: record.audio_blob ?? null },
    rawEncryptedContent: rawEncryptedContent === undefined ? (prev?.rawEncryptedContent ?? null) : rawEncryptedContent,
    revision: (prev?.revision ?? 0) + 1,
  });
  warmImage(record.album_cover_url);
}

export function fillSecretPageYearFromNetwork(username: string, year: number, entries: Array<{ month: string; record: SecretPageRecord; rawEncryptedContent: string | null }>) {
  const bucket = bucketFor(username, year);
  const byMonth = new Map(entries.map((entry) => [entry.month, entry]));
  for (const month of SECRET_PAGE_MONTHS) {
    const prev = bucket.slots.get(month);
    if (prev && prev.revision > 0) continue;
    const found = byMonth.get(month);
    const record = found?.record ?? emptyRecord();
    bucket.slots.set(month, { record, rawEncryptedContent: found?.rawEncryptedContent ?? null, revision: 0 });
    warmImage(record.album_cover_url);
  }
  bucket.loaded = true;
  emit();
}

export function peekAudioPlaybackUrl(year: number, month: string, record: SecretPageRecord): string | null {
  const slot = audioUrls.get(audioKey(year, month));
  if (!slot) return null;
  if (slot.path !== (record.audio_storage_path ?? null)) return null;
  if (!slot.blob && slot.expiresAt <= Date.now()) {
    audioUrls.delete(audioKey(year, month));
    return null;
  }
  return slot.url;
}

export function rememberAudioPlaybackUrl(year: number, month: string, record: SecretPageRecord, url: string, blob: boolean, ttlMs: number) {
  const key = audioKey(year, month);
  const prev = audioUrls.get(key);
  if (prev?.blob && prev.url !== url) URL.revokeObjectURL(prev.url);
  audioUrls.set(key, { url, path: record.audio_storage_path ?? null, blob, expiresAt: Date.now() + ttlMs });
}

export function forgetAudioPlaybackUrl(year: number, month: string) {
  const key = audioKey(year, month);
  const prev = audioUrls.get(key);
  if (prev?.blob) URL.revokeObjectURL(prev.url);
  audioUrls.delete(key);
}

export function warmImage(url: string | null | undefined) {
  if (!url || typeof window === 'undefined' || warmedImages.has(url)) return;
  warmedImages.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
}

export function warmImages(urls: Array<string | null | undefined>) {
  for (const url of urls) warmImage(url);
}

export function clearSecretPageSessionCache() {
  generation += 1;
  audioUrls.forEach((slot) => {
    if (slot.blob) URL.revokeObjectURL(slot.url);
  });
  audioUrls.clear();
  years.clear();
  warmedImages.clear();
}
