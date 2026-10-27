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

function loadSpotifyPlaybackSdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
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
}

async function fetchPlayerToken() {
  const res = await authenticatedFetch("/api/spotify/player-token");
  const data = (await res.json().catch(() => ({}))) as { access_token?: string | null; premium?: boolean; connected?: boolean };
  if (!res.ok || !data.connected || !data.access_token) return null;
  return data;
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
      onPlayingChangeRef.current?.(false);
      return;
    }

    let cancelled = false;
    let youtubePlayer: YoutubePlayer | null = null;
    let spotifyPlayer: SpotifyWebPlayer | null = null;

    const mount = async () => {
      host.replaceChildren();

      if (source === "youtube") {
        const target = document.createElement("div");
        host.appendChild(target);
        await loadYoutubeApi();
        if (cancelled || !window.YT?.Player) return;
        const startSec = Math.max(0, startSeconds);
        youtubePlayer = new window.YT.Player(target, {
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
          await loadSpotifyPlaybackSdk();
          if (cancelled || !window.Spotify?.Player) return;
          const player = new window.Spotify.Player({
            name: "Archive of Our Songs",
            getOAuthToken: (cb: (token: string) => void) => {
              void fetchPlayerToken().then((next) => {
                if (next?.access_token) cb(next.access_token);
              });
            },
            volume: 0.85,
          });
          spotifyPlayer = player;
          let lastPosition = 0;
          player.addListener("player_state_changed", (state: { paused?: boolean; position?: number } | null) => {
            if (!state) return;
            const position = state.position ?? 0;
            onPlayingChangeRef.current?.(!state.paused);
            if (state.paused && position === 0 && lastPosition > 1200) {
              onPlayingChangeRef.current?.(false);
              onEndedRef.current();
            }
            lastPosition = position;
          });
          player.addListener("ready", (payload) => {
            const deviceId = payload?.device_id;
            if (!deviceId) return;
            void (async () => {
              const fresh = await fetchPlayerToken();
              if (!fresh?.access_token || cancelled) return;
              await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${fresh.access_token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  uris: [`spotify:track:${externalId}`],
                  position_ms: Math.round(Math.max(0, startSeconds) * 1000),
                }),
              }).catch(() => undefined);
            })();
          });
          player.addListener("account_error", () => {
            void playPreview(audio, externalId, () => onEndedRef.current(), (playing) => onPlayingChangeRef.current?.(playing), startSeconds);
          });
          await player.activateElement?.().catch(() => undefined);
          await player.connect();
          return;
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
      try {
        spotifyPlayer?.disconnect();
      } catch {
      }
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
