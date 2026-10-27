import { useEffect, useRef } from "react";
import { authenticatedFetch, UnauthorizedSessionError } from "@/utils/authenticatedFetch";
import styles from "./styles.module.scss";

type YoutubePlayer = {
  playVideo: () => void;
  stopVideo: () => void;
  destroy: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
};

type SpotifyWebPlayer = {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  pause: () => Promise<void>;
  activateElement?: () => Promise<void>;
  addListener: (event: string, cb: (payload: { device_id?: string; paused?: boolean; position?: number } | null) => void) => boolean;
};

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement, opts: Record<string, unknown>) => YoutubePlayer;
      PlayerState?: { ENDED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
    Spotify?: { Player: new (opts: Record<string, unknown>) => SpotifyWebPlayer };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

function loadYoutubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    if (!document.getElementById("yt-iframe-api")) {
      const tag = document.createElement("script");
      tag.id = "yt-iframe-api";
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }
    if (window.YT?.Player) resolve();
  });
}

let spotifySdkLoading: Promise<void> | null = null;

function loadSpotifyPlaybackSdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  if (spotifySdkLoading) return spotifySdkLoading;
  spotifySdkLoading = new Promise<void>((resolve, reject) => {
    const previous = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      previous?.();
      resolve();
    };
    if (!document.getElementById("spotify-player-sdk")) {
      const tag = document.createElement("script");
      tag.id = "spotify-player-sdk";
      tag.src = "https://sdk.scdn.co/spotify-player.js";
      tag.async = true;
      tag.onerror = () => reject(new Error("Could not load Spotify playback"));
      document.body.appendChild(tag);
    }
    if (window.Spotify?.Player) resolve();
  });
  return spotifySdkLoading;
}

async function fetchPlayerToken() {
  const res = await authenticatedFetch("/api/spotify/player-token");
  const data = (await res.json().catch(() => ({}))) as { access_token?: string | null; premium?: boolean; connected?: boolean };
  if (!res.ok || !data.connected || !data.access_token) return null;
  return data;
}

let spotifyPlayer: SpotifyWebPlayer | null = null;
let spotifyDeviceId: string | null = null;
let spotifyReady: Promise<string | null> | null = null;
let spotifyLastPosition = 0;
let spotifyOnEnded: (() => void) | null = null;
let spotifyOnPlaying: ((playing: boolean) => void) | null = null;

function resetSpotifyPlayer() {
  try {
    spotifyPlayer?.disconnect();
  } catch {
  }
  spotifyPlayer = null;
  spotifyDeviceId = null;
  spotifyReady = null;
  spotifyLastPosition = 0;
}

async function ensureSpotifyPlayer(): Promise<string | null> {
  await loadSpotifyPlaybackSdk();
  const SpotifyPlayer = window.Spotify?.Player;
  if (!SpotifyPlayer) return null;
  if (spotifyDeviceId && spotifyPlayer) return spotifyDeviceId;
  if (spotifyReady) return spotifyReady;

  spotifyReady = new Promise((resolve) => {
    const player = new SpotifyPlayer({
      name: "Archive of Our Songs",
      getOAuthToken: (cb: (token: string) => void) => {
        void fetchPlayerToken().then((next) => {
          if (next?.access_token) cb(next.access_token);
        });
      },
      volume: 0.85,
    });
    spotifyPlayer = player;
    let settled = false;
    const finish = (id: string | null) => {
      if (settled) return;
      settled = true;
      resolve(id);
    };
    player.addListener("ready", (payload) => {
      const id = payload?.device_id ?? null;
      if (id) spotifyDeviceId = id;
      finish(id);
    });
    player.addListener("not_ready", () => {
      spotifyDeviceId = null;
    });
    player.addListener("initialization_error", () => finish(null));
    player.addListener("authentication_error", () => finish(null));
    player.addListener("player_state_changed", (state) => {
      if (!state) return;
      const position = state.position ?? 0;
      spotifyOnPlaying?.(!state.paused);
      if (state.paused && position === 0 && spotifyLastPosition > 1200) {
        spotifyOnEnded?.();
      }
      spotifyLastPosition = position;
    });
    window.setTimeout(() => finish(spotifyDeviceId), 5000);
    void player.connect().then((ok) => {
      if (!ok) finish(null);
    });
  });

  const id = await spotifyReady;
  if (!id) resetSpotifyPlayer();
  return id;
}

async function playSpotifyTrack(trackId: string, startSeconds: number): Promise<boolean> {
  await spotifyPlayer?.activateElement?.().catch(() => undefined);
  let deviceId = await ensureSpotifyPlayer();
  if (!deviceId) return false;
  await spotifyPlayer?.activateElement?.().catch(() => undefined);

  const requestPlay = async (id: string) => {
    const fresh = await fetchPlayerToken();
    if (!fresh?.access_token) return false;
    const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${fresh.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uris: [`spotify:track:${trackId}`],
        position_ms: Math.round(Math.max(0, startSeconds) * 1000),
      }),
    });
    return res.ok || res.status === 204;
  };

  if (await requestPlay(deviceId)) return true;
  resetSpotifyPlayer();
  deviceId = await ensureSpotifyPlayer();
  if (!deviceId) return false;
  await spotifyPlayer?.activateElement?.().catch(() => undefined);
  return requestPlay(deviceId);
}

async function pauseSpotifyPlayback() {
  try {
    await spotifyPlayer?.pause();
  } catch {
  }
}

function applyAudioStart(audio: HTMLAudioElement, startSeconds: number) {
  const startSec = Math.max(0, startSeconds);
  if (startSec <= 0) return;
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    audio.currentTime = Math.min(startSec, Math.max(0, audio.duration - 0.05));
    return;
  }
  audio.currentTime = startSec;
}

async function playPreview(
  audio: HTMLAudioElement,
  trackId: string,
  onEnded: () => void,
  onPlayingChange?: (playing: boolean) => void,
  startSeconds = 0
) {
  const res = await authenticatedFetch(`/api/spotify/preview?id=${encodeURIComponent(trackId)}`);
  const data = (await res.json().catch(() => ({}))) as { url?: string | null };
  if (!data.url) return false;
  audio.src = data.url;
  audio.loop = false;
  audio.onplay = () => onPlayingChange?.(true);
  audio.onplaying = () => onPlayingChange?.(true);
  audio.onpause = () => onPlayingChange?.(false);
  audio.onended = () => {
    onPlayingChange?.(false);
    onEnded();
  };
  const seekOnReady = () => applyAudioStart(audio, startSeconds);
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    seekOnReady();
  } else {
    audio.addEventListener("loadedmetadata", seekOnReady, { once: true });
  }
  await audio.play().catch(() => undefined);
  return true;
}

interface ExternalSoundtrackPlayerProps {
  source: "youtube" | "spotify" | null;
  externalId: string | null;
  active: boolean;
  startSeconds?: number;
  onEnded: () => void;
  onPlayingChange?: (playing: boolean) => void;
}

const YT_PLAYING = 1;
const YT_BUFFERING = 3;

export function ExternalSoundtrackPlayer({ source, externalId, active, startSeconds = 0, onEnded, onPlayingChange }: ExternalSoundtrackPlayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onEndedRef = useRef(onEnded);
  const onPlayingChangeRef = useRef(onPlayingChange);
  onEndedRef.current = onEnded;
  onPlayingChangeRef.current = onPlayingChange;

  useEffect(() => {
    const host = hostRef.current;
    const audio = audioRef.current;
    if (!host || !active || !source || !externalId) {
      host?.replaceChildren();
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      void pauseSpotifyPlayback();
      onPlayingChangeRef.current?.(false);
      return;
    }

    let cancelled = false;
    let youtubePlayer: YoutubePlayer | null = null;
    spotifyOnEnded = () => onEndedRef.current();
    spotifyOnPlaying = (playing) => onPlayingChangeRef.current?.(playing);

    const mount = async () => {
      host.replaceChildren();

      if (source === "youtube") {
        const target = document.createElement("div");
        host.appendChild(target);
        await loadYoutubeApi();
        const YoutubePlayerCtor = window.YT?.Player;
        if (cancelled || !YoutubePlayerCtor) return;
        const startSec = Math.max(0, startSeconds);
        youtubePlayer = new YoutubePlayerCtor(target, {
          videoId: externalId,
          width: 1,
          height: 1,
          playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, start: Math.floor(startSec) },
          events: {
            onReady: (event: { target: YoutubePlayer }) => {
              if (startSec > 0) event.target.seekTo(startSec, true);
              event.target.playVideo();
            },
            onStateChange: (event: { data: number }) => {
              const data = event.data;
              if (data === window.YT?.PlayerState?.ENDED || data === 0) {
                onPlayingChangeRef.current?.(false);
                onEndedRef.current();
                return;
              }
              onPlayingChangeRef.current?.(data === YT_PLAYING || data === YT_BUFFERING);
            },
          },
        });
        return;
      }

      if (!audio) return;
      try {
        const token = await fetchPlayerToken();
        if (cancelled) return;
        if (token?.premium) {
          const played = await playSpotifyTrack(externalId, startSeconds);
          if (cancelled) {
            void pauseSpotifyPlayback();
            return;
          }
          if (played) {
            onPlayingChangeRef.current?.(true);
            return;
          }
        }
        await playPreview(audio, externalId, () => onEndedRef.current(), (playing) => onPlayingChangeRef.current?.(playing), startSeconds);
      } catch (err) {
        if (err instanceof UnauthorizedSessionError) return;
        if (!cancelled && audio) {
          await playPreview(audio, externalId, () => onEndedRef.current(), (playing) => onPlayingChangeRef.current?.(playing), startSeconds).catch(() => undefined);
        }
      }
    };

    void mount();

    return () => {
      cancelled = true;
      onPlayingChangeRef.current?.(false);
      try {
        youtubePlayer?.stopVideo();
        youtubePlayer?.destroy();
      } catch {
      }
      void pauseSpotifyPlayback();
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.onended = null;
        audio.load();
      }
      host.replaceChildren();
    };
  }, [active, source, externalId, startSeconds]);

  return (
    <>
      <div ref={hostRef} className={styles.hiddenExternalPlayer} aria-hidden />
      <audio ref={audioRef} className={styles.hiddenAudio} playsInline preload="auto" />
    </>
  );
}
