// A stand-in for Netflix's watch page: a real <video>, the same caption elements and
// player API the extension relies on, and subtitle files downloaded by XHR. All text
// is made up. The tests never contact Netflix.

export const LINE_SPACING = 3;
export const LINE_LENGTH = 2;
export const VIDEO_SECONDS = 400;
/** This line is placed at the top of the picture by its subtitle file. */
export const TOP_LINE = 5;

export function subtitleFile(prefix: string, language = 'en'): string {
  let body = '';
  for (let i = 0; i * LINE_SPACING < VIDEO_SECONDS; i++) {
    const begin = i * LINE_SPACING * 10_000_000;
    const end = begin + LINE_LENGTH * 10_000_000;
    const region = i === TOP_LINE ? 'high' : 'low';
    body += `<p xml:id="s${i}" begin="${begin}t" end="${end}t" region="${region}">${prefix} line ${i}</p>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    xmlns:tts="http://www.w3.org/ns/ttml#styling" ttp:tickRate="10000000" ttp:timeBase="media" xml:lang="${language}">
  <head><layout>
    <region xml:id="high" tts:origin="10% 5%" tts:extent="80% 10%"/>
    <region xml:id="low" tts:origin="10% 80%" tts:extent="80% 10%"/>
  </layout></head>
  <body><div>${body}</div></body>
</tt>`;
}

export interface FakeOptions {
  /** Track on when the page loads. */
  initialTrack: 'en' | 'off' | 'fr';
  /** Whether the title has any English track. */
  hasEnglish: boolean;
  /** Track changes are silently ignored for this long, like a player still starting up. */
  ignoreChangesMs?: number;
  /** The first file download is never seen, as if it happened before anyone listened. */
  skipFirstLoad?: boolean;
}

export function fakeWatchPage({ initialTrack, hasEnglish, ignoreChangesMs = 0, skipFirstLoad = false }: FakeOptions): string {
  return `<!doctype html>
<html><head><title>Fake player</title><style>
  body { margin: 0; background: #000; }
  video { position: fixed; left: 0; top: 0; width: 960px; height: 540px; }
  .player-timedtext { position: absolute; inset: 0 84px; }
  .player-timedtext-text-container { position: absolute; left: 50%; bottom: 80px; transform: translateX(-50%); white-space: nowrap; }
  .player-timedtext span span { font-size: 30px; color: rgb(255, 255, 0); font-family: Arial; font-weight: 700; }
</style></head><body>
<video id="v" muted></video>
<div id="native-host" style="position:fixed;left:0;top:0;width:960px;height:540px"><div class="player-timedtext"></div></div>
<script>
  // A silent WAV as a blob, so the video can seek freely.
  const seconds = ${VIDEO_SECONDS}, rate = 8000, n = seconds * rate;
  const wav = new Uint8Array(44 + n).fill(128);
  const dv = new DataView(wav.buffer);
  const tag = (o, s) => [...s].forEach((c, i) => (wav[o + i] = c.charCodeAt(0)));
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n, true); tag(8, 'WAVEfmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate, true);
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); tag(36, 'data'); dv.setUint32(40, n, true);
  const video = document.getElementById('v');
  video.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  video.play();

  const tracks = [
    { trackId: 'off', bcp47: null, isNoneTrack: true, rawTrackType: 'SUBTITLES' },
    ${hasEnglish ? "{ trackId: 'en', bcp47: 'en', rawTrackType: 'SUBTITLES' }," : ''}
    { trackId: 'fr', bcp47: 'fr', rawTrackType: 'SUBTITLES' },
  ];
  let current = tracks.find((t) => t.trackId === '${initialTrack}') ?? tracks[0];
  let cues = [];
  window.fake = { trackLog: [], nativeOn: true };

  // Downloads a track's file and draws its captions the way Netflix does.
  function load(track) {
    cues = [];
    if (track.isNoneTrack) return;
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/fake-subs/' + track.trackId + location.pathname.replaceAll('/', '_') + '.xml');
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(xhr.response), 'text/xml');
      cues = [...doc.querySelectorAll('p')].map((p) => ({
        begin: parseInt(p.getAttribute('begin')) / 1e7, end: parseInt(p.getAttribute('end')) / 1e7, text: p.textContent,
      }));
    };
    xhr.send();
  }

  window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
    getAllPlayerSessionIds: () => ['watch-1'],
    getVideoPlayerBySessionId: () => ({
      getTimedTextTrackList: () => tracks,
      getTimedTextTrack: () => current,
      setTimedTextTrack: (t) => { if (performance.now() < ${ignoreChangesMs}) return; current = t; window.fake.trackLog.push(t.trackId); load(t); },
    }),
  } }) } } } };
  window.fake.currentTrack = () => current.trackId;
  window.fake.reload = () => load(current);
  if (!${skipFirstLoad}) load(current);

  const host = document.querySelector('.player-timedtext');
  let shown = null;
  (function draw() {
    requestAnimationFrame(draw);
    const t = video.currentTime;
    const cue = window.fake.nativeOn ? cues.find((c) => c.begin <= t && t < c.end) : null;
    const text = cue ? cue.text : '';
    if (text === shown) return;
    shown = text;
    host.innerHTML = text
      ? '<div class="player-timedtext-text-container"><span><span>' + text + '</span></span></div>'
      : '';
  })();
</script></body></html>`;
}
