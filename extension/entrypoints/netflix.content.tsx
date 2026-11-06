// Phase 0: replace Netflix's captions with our own layer, drawing the English
// lines from the captured TTML chunks once each chunk is anchored in time.
import { render } from 'preact';
import { TTML_MESSAGE, type TtmlMessage } from '../src/messages';
import { Caption, CAPTION_CSS } from '../src/overlay/Caption';
import { CueStore } from '../src/subtitles/cueStore';
import { parseTtml, ttmlLanguage } from '../src/subtitles/ttml';

const HIDE_NATIVE_CSS = '.player-timedtext { opacity: 0 !important; }';
const log = (...args: unknown[]) => console.debug('[subtitle-learning]', ...args);

export default defineContentScript({
  matches: ['https://www.netflix.com/*'],
  runAt: 'document_idle',
  main() {
    const store = new CueStore();
    let episode = location.pathname;
    const checkEpisode = () => {
      if (location.pathname === episode) return;
      episode = location.pathname;
      store.nextEpisode();
      log('episode changed');
    };

    window.addEventListener('message', (event: MessageEvent<TtmlMessage>) => {
      if (event.source !== window || event.data?.type !== TTML_MESSAGE) return;
      checkEpisode();
      // Skip trailers on the browse page and other languages' tracks.
      const language = ttmlLanguage(event.data.xml);
      if (!location.pathname.startsWith('/watch') || (language && !language.startsWith('en'))) return;
      const cues = parseTtml(event.data.xml);
      if (store.addChunk(cues)) {
        log(`file ${store.totalChunks}: ${cues.length} cues, ${cues[0]?.begin.toFixed(2)}–${cues.at(-1)?.end.toFixed(2)} s, video at ${event.data.currentTime?.toFixed(2)} s`);
      }
    });

    const hide = document.createElement('style');
    hide.textContent = HIDE_NATIVE_CSS;
    document.documentElement.append(hide);

    // Netflix keeps rendering its captions (invisibly); use them to anchor chunks.
    let nativeText = '';
    const readNative = () => {
      const el = document.querySelector<HTMLElement>('.player-timedtext');
      const text = el?.innerText.trim() ?? '';
      if (text === nativeText) return;
      nativeText = text;
      const video = document.querySelector('video');
      if (text && video) {
        const before = store.anchoredChunks;
        const offset = store.anchor(text, video.currentTime);
        if (offset !== null && store.anchoredChunks > before) log(`anchored chunk at offset ${offset.toFixed(3)} s`);
      }
    };
    new MutationObserver(readNative).observe(document.body, { childList: true, subtree: true, characterData: true });

    const host = document.createElement('div');
    host.id = 'subtitle-learning-root';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CAPTION_CSS;
    const mount = document.createElement('div');
    shadow.append(style, mount);

    let lastKey = '';
    const frame = () => {
      requestAnimationFrame(frame);
      checkEpisode();

      const video = document.querySelector('video');
      if (!video || !location.pathname.startsWith('/watch')) {
        if (host.isConnected) host.remove();
        return;
      }
      // Stay inside the fullscreen element so the layer survives fullscreen.
      const parent = document.fullscreenElement ?? document.body;
      if (host.parentElement !== parent) parent.append(host);

      const t = video.currentTime;
      const active = store.activeAt(t);
      const fromTimeline = active.length > 0;
      const lines = fromTimeline ? active.flatMap((c) => c.text.split('\n')) : nativeText ? nativeText.split('\n') : [];
      const rect = video.getBoundingClientRect();
      const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      const debug = import.meta.env.DEV
        ? `${fromTimeline ? 'timeline' : nativeText ? 'mirror' : 'idle'} · ${store.describe()} · ${t.toFixed(2)} s`
        : undefined;

      const key = JSON.stringify([lines, box, debug]);
      if (key === lastKey) return;
      lastKey = key;
      render(<Caption lines={lines} box={box} debug={debug} />, mount);
    };
    requestAnimationFrame(frame);
  },
});
