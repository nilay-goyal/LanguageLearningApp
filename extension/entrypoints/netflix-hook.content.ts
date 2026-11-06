// Runs in Netflix's page context at document_start and forwards every TTML
// subtitle response to the extension's content script.
import { TTML_MESSAGE, type TtmlMessage } from '../src/messages';
import { isTtml } from '../src/subtitles/ttml';

export default defineContentScript({
  matches: ['https://www.netflix.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const forward = (text: string) => {
      if (!isTtml(text)) return;
      const video = document.querySelector('video');
      const message: TtmlMessage = { type: TTML_MESSAGE, xml: text, currentTime: video?.currentTime ?? null };
      window.postMessage(message, window.location.origin);
    };

    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<typeof send>) {
      this.addEventListener('load', () => {
        // Never let the hook break Netflix's player.
        try {
          if (this.responseType === '' || this.responseType === 'text') forward(this.responseText);
          else if (this.responseType === 'arraybuffer' && this.response instanceof ArrayBuffer) {
            forward(new TextDecoder().decode(this.response));
          }
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
  },
});
