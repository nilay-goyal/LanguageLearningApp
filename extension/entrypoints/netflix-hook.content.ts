// Runs in Netflix's page context at document_start. Forwards TTML subtitle responses
// to the content script and controls the subtitle track through the player API.
// Every part is wrapped so that a failure here can never reach Netflix's player.
import {
  COMMAND_MESSAGE,
  type CommandMessage,
  TRACK_STATUS_MESSAGE,
  type TrackStatusMessage,
  TTML_MESSAGE,
  type TtmlMessage,
} from '../src/messages';
import { chooseEnglishTrack, type NetflixTrack } from '../src/netflix/tracks';
import { isTtml } from '../src/subtitles/ttml';

interface NetflixPlayer {
  getTimedTextTrackList(): NetflixTrack[];
  getTimedTextTrack(): NetflixTrack | null;
  setTimedTextTrack(track: NetflixTrack): void;
}

/** Binary responses larger than this can't be subtitles (they are video segments). */
const MAX_SUBTITLE_BYTES = 8_000_000;
const ENSURE_RETRY_MS = 500;
const ENSURE_ATTEMPTS = 40;
const REFRESH_GAP_MS = 300;

function currentPlayer(): NetflixPlayer | null {
  try {
    // Internal and undocumented, so it may change without notice.
    const netflix = (window as unknown as { netflix: any }).netflix;
    const videoPlayer = netflix.appContext.state.playerApp.getAPI().videoPlayer;
    const ids: string[] = videoPlayer.getAllPlayerSessionIds();
    const id = ids.find((s) => s.startsWith('watch')) ?? ids[0];
    return id ? videoPlayer.getVideoPlayerBySessionId(id) : null;
  } catch {
    return null;
  }
}

function hookNetwork() {
  const forward = (text: string) => {
    if (!isTtml(text)) return;
    const video = document.querySelector('video');
    const message: TtmlMessage = { type: TTML_MESSAGE, xml: text, currentTime: video?.currentTime ?? null };
    window.postMessage(message, window.location.origin);
  };

  const forwardBinary = (buffer: ArrayBuffer) => {
    if (buffer.byteLength > MAX_SUBTITLE_BYTES) return;
    // Look at the start first, so video data is never decoded.
    const start = new TextDecoder().decode(buffer.slice(0, 64)).trimStart();
    if (start.startsWith('<')) forward(new TextDecoder().decode(buffer));
  };

  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<typeof send>) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') forward(this.responseText);
        else if (this.responseType === 'arraybuffer' && this.response instanceof ArrayBuffer) forwardBinary(this.response);
      } catch {}
    });
    return send.apply(this, args);
  };

  const fetchOriginal = window.fetch;
  window.fetch = async (...args) => {
    const response = await fetchOriginal(...args);
    try {
      if ((response.headers.get('content-type') ?? '').includes('xml')) {
        response.clone().text().then(forward, () => {});
      }
    } catch {}
    return response;
  };
}

function hookTrackControl() {
  // The track that was on before we changed it, for restoring when turned off.
  let originalTrackId: string | null = null;
  let switched = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const report = (status: TrackStatusMessage['status']) => {
    const message: TrackStatusMessage = { type: TRACK_STATUS_MESSAGE, status };
    window.postMessage(message, window.location.origin);
  };

  const ensureEnglish = (attempt = 0) => {
    clearTimeout(retry);
    try {
      const player = currentPlayer();
      const list = player?.getTimedTextTrackList() ?? [];
      if (!player || list.length === 0) {
        if (attempt < ENSURE_ATTEMPTS) retry = setTimeout(() => ensureEnglish(attempt + 1), ENSURE_RETRY_MS);
        else report('unavailable');
        return;
      }
      const current = player.getTimedTextTrack();
      const choice = chooseEnglishTrack(current, list);
      if (choice === 'keep') return report('kept');
      if (!choice) return report('no-english');
      if (!switched) originalTrackId = current?.trackId ?? null;
      player.setTimedTextTrack(choice);
      switched = true;
      report('switched');
    } catch {
      report('unavailable');
    }
  };

  const restore = () => {
    clearTimeout(retry);
    if (!switched) return;
    switched = false;
    try {
      const player = currentPlayer();
      const original = player?.getTimedTextTrackList().find((t) => t.trackId === originalTrackId);
      if (player && original) player.setTimedTextTrack(original);
    } catch {}
  };

  const refresh = () => {
    try {
      const player = currentPlayer();
      const current = player?.getTimedTextTrack();
      const off = player?.getTimedTextTrackList().find((t) => t.isNoneTrack);
      if (!player || !current || !off) return;
      player.setTimedTextTrack(off);
      setTimeout(() => {
        try {
          player.setTimedTextTrack(current);
        } catch {}
      }, REFRESH_GAP_MS);
    } catch {}
  };

  window.addEventListener('message', (event: MessageEvent<CommandMessage>) => {
    if (event.source !== window || event.data?.type !== COMMAND_MESSAGE) return;
    if (event.data.command === 'ensure-english') ensureEnglish();
    else if (event.data.command === 'refresh-track') refresh();
    else restore();
  });
}

export default defineContentScript({
  matches: ['https://www.netflix.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    hookNetwork();
    hookTrackControl();
  },
});
