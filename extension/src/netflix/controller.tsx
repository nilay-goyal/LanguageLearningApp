// Runs the caption layer on Netflix: reads subtitle files and Netflix's own (hidden)
// captions, and draws ours. If anything here throws, the layer removes itself and
// Netflix's captions come back.
import { render } from 'preact';
import {
  COMMAND_MESSAGE,
  type CommandMessage,
  TRACK_STATUS_MESSAGE,
  type TrackStatusMessage,
  TTML_MESSAGE,
  type TtmlMessage,
} from '../messages';
import { Caption, CAPTION_CSS, type CaptionStyle, DEFAULT_CAPTION_STYLE } from '../overlay/Caption';
import { buildBlocks, chooseSource, type Placement, syncSummary } from '../overlay/display';
import { buildLines } from '../learning/lines';
import { deserializeState, LearningSession, serializeState, type TranslateOutcome } from '../learning/session';
import {
  DEV_COMMAND_MESSAGE,
  EXPORT_LINES_MESSAGE,
  JUMP_KEY,
  type JumpRequest,
  LEARNER_KEY,
  PACE_KEY,
  RELAX_TICKS_KEY,
  STATUS_MESSAGE,
  type TabStatus,
  TRANSLATE_MESSAGE,
} from '../settings';
import { CueStore, isEpisodeLength } from '../subtitles/cueStore';
import { type Cue, parseTtml, type Run, ttmlLanguage } from '../subtitles/ttml';

const NATIVE_SELECTOR = '.player-timedtext';
const NATIVE_TEXT_SELECTOR = '.player-timedtext-text-container';
const HIDE_NATIVE_CSS = `${NATIVE_SELECTOR} { opacity: 0 !important; }`;

/** How often slower things are re-measured: the video box and Netflix's caption. */
const MEASURE_MS = 250;
/** How long Netflix's caption is treated as stale after a seek or a start. */
const SETTLE_MS = 600;
const SYNC_SAMPLES = 200;
/** While no subtitle file has arrived, how often to retry and for how many times (5 minutes covers pre-roll ads). */
const RECOVER_EVERY_MS = 4000;
const MAX_RECOVERIES = 75;
/** Hold this key to see the English line under the French. */
const REVEAL_KEY = 'e';

const log = (...args: unknown[]) => {
  if (import.meta.env.DEV) console.debug('[subtitle-learning]', ...args);
};

export class CaptionController {
  private store = new CueStore();
  private running = false;
  private failed = false;
  /** The title has no English track, so Netflix is left entirely alone. */
  private passthrough = false;
  private episode = location.pathname;

  private frameId = 0;
  private measureTimer: ReturnType<typeof setInterval> | undefined;
  private nativeObserver: MutationObserver | null = null;
  private watchedNative: HTMLElement | null = null;
  private watchedVideo: HTMLVideoElement | null = null;

  private nativeText = '';
  private nativePlacement: Placement | null = null;
  private bottomOffset: number | null = null;
  private style: CaptionStyle = DEFAULT_CAPTION_STYLE;
  private box = { left: 0, top: 0, width: 0, height: 0 };
  private settleUntil = 0;
  private syncErrors: number[] = [];
  private lastKey = '';
  private trackStatus: TrackStatusMessage['status'] | null = null;
  private lastRecovery = 0;
  private recoveries = 0;
  private session: LearningSession | null = null;
  private lastLayout: string | null = null;
  private layoutBuild = 0;
  private revealing = false;

  private hideStyle = document.createElement('style');
  private host = document.createElement('div');
  private mount = document.createElement('div');

  constructor() {
    this.hideStyle.textContent = HIDE_NATIVE_CSS;
    this.host.id = 'subtitle-learning-root';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const css = document.createElement('style');
    css.textContent = CAPTION_CSS;
    shadow.append(css, this.mount);
    // Files are collected even while off, so switching on mid-episode works at once.
    window.addEventListener('message', (event) => this.onMessage(event));
    window.addEventListener('keydown', (event) => this.onKey(event, true), true);
    window.addEventListener('keyup', (event) => this.onKey(event, false), true);
    window.addEventListener('pagehide', () => this.session?.flush());
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[PACE_KEY] && this.session) this.session.pace = Number(changes[PACE_KEY].newValue) || 1;
      if (changes[RELAX_TICKS_KEY] && this.session) this.session.relaxTicks = changes[RELAX_TICKS_KEY].newValue === true;
      const jump = changes[JUMP_KEY]?.newValue as JumpRequest | undefined;
      if (jump) this.session?.jump(jump.hour, jump.reset, this.watchedVideo?.currentTime ?? 0);
    });
    browser.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
      if (message?.type === EXPORT_LINES_MESSAGE) {
        sendResponse(this.exportLines());
      } else if (message?.type === STATUS_MESSAGE) {
        const progress = this.session?.progress() ?? { lines: 0, translated: 0, stopped: null };
        sendResponse({ ...progress, running: this.running } satisfies TabStatus);
      }
    });
    void this.loadLearner();
  }

  private async loadLearner(): Promise<void> {
    const stored = await browser.storage.local.get([LEARNER_KEY, PACE_KEY, RELAX_TICKS_KEY]);
    const session = new LearningSession(
      {
        translate: (request) =>
          browser.runtime.sendMessage({ type: TRANSLATE_MESSAGE, request }).catch((): TranslateOutcome => ({ ok: false, reason: 'failed' })),
        save: (state) => void browser.storage.local.set({ [LEARNER_KEY]: serializeState(state) }),
      },
      deserializeState(stored[LEARNER_KEY]),
    );
    session.pace = Number(stored[PACE_KEY]) || 1;
    session.relaxTicks = stored[RELAX_TICKS_KEY] === true;
    this.session = session;
  }

  /** Dev panel: saves this episode's English lines to a local file, for the model eval. */
  private exportLines(): number {
    const lines = this.session?.exportLines() ?? [];
    if (lines.length === 0) return 0;
    const blob = new Blob([JSON.stringify({ video: this.episode, lines })], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `subtitle-lines${this.episode.replaceAll('/', '-')}.json`;
    // The link must be on the page, and the file must outlive the click.
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return lines.length;
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (event.key.toLowerCase() !== REVEAL_KEY || event.ctrlKey || event.metaKey || event.altKey) return;
    this.revealing = down;
  }

  start(): void {
    if (this.running || this.failed) return;
    this.running = true;
    this.settle();
    this.beginTrackRecovery();
    this.command('ensure-english');
    this.measureTimer = setInterval(() => this.guard(() => this.measure()), MEASURE_MS);
    this.frameId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.session?.flush();
    this.teardown();
    this.command('restore-track');
  }

  private teardown(): void {
    this.running = false;
    cancelAnimationFrame(this.frameId);
    clearInterval(this.measureTimer);
    this.nativeObserver?.disconnect();
    this.nativeObserver = null;
    this.watchedNative = null;
    this.hideStyle.remove();
    this.host.remove();
    this.lastKey = '';
  }

  private fail(error: unknown): void {
    console.warn('[subtitle-learning] caption layer stopped:', error);
    this.failed = true;
    this.teardown();
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.fail(error);
    }
  }

  private command(command: CommandMessage['command']): void {
    const message: CommandMessage = { type: COMMAND_MESSAGE, command };
    window.postMessage(message, window.location.origin);
  }

  private settle(): void {
    this.settleUntil = performance.now() + SETTLE_MS;
  }

  private beginTrackRecovery(): void {
    this.lastRecovery = performance.now();
    this.recoveries = 0;
  }

  /**
   * Netflix can ignore or undo a track change while the player starts or during a
   * pre-roll ad, and a file can download before we are listening. So until a file
   * arrives, keep asking; if English already looks on, make Netflix fetch it again.
   */
  private recoverTrack(): void {
    if (this.store.totalChunks > 0 || this.passthrough || !this.watchedVideo) return;
    if (!location.pathname.startsWith('/watch') || this.recoveries >= MAX_RECOVERIES) return;
    const now = performance.now();
    if (now - this.lastRecovery < RECOVER_EVERY_MS) return;
    this.lastRecovery = now;
    this.recoveries++;
    this.command(this.trackStatus === 'kept' ? 'refresh-track' : 'ensure-english');
  }

  private checkEpisode(): void {
    if (location.pathname === this.episode) return;
    const wasWatching = this.episode.startsWith('/watch');
    this.episode = location.pathname;
    // Coming from the browse page, a file already fetched for this title stays.
    if (wasWatching) this.store.nextEpisode();
    this.passthrough = false;
    this.trackStatus = null;
    this.syncErrors = [];
    this.settle();
    this.beginTrackRecovery();
    this.lastLayout = null;
    log('episode changed');
    if (this.running && location.pathname.startsWith('/watch')) this.command('ensure-english');
  }

  private onMessage(event: MessageEvent<TtmlMessage | TrackStatusMessage>): void {
    if (event.source !== window) return;
    const data = event.data;
    try {
      if (import.meta.env.DEV && (data as { type?: string })?.type === DEV_COMMAND_MESSAGE) {
        const command = data as unknown as { action: string; hour?: number };
        if (command.action === 'export') this.exportLines();
        if (command.action === 'jump' && this.session) {
          this.session.relaxTicks = (command.hour ?? 0) > 0;
          void browser.storage.local.set({ [RELAX_TICKS_KEY]: this.session.relaxTicks });
          this.session.jump(command.hour ?? 0, false, this.watchedVideo?.currentTime ?? 0);
        }
        return;
      }
      if (data?.type === TRACK_STATUS_MESSAGE) {
        log('track status:', data.status);
        this.trackStatus = data.status;
        this.passthrough = data.status === 'no-english';
        return;
      }
      if (data?.type !== TTML_MESSAGE) return;
      this.checkEpisode();
      const language = ttmlLanguage(data.xml);
      if (language && !language.startsWith('en')) return;
      const cues = parseTtml(data.xml);
      // Away from the player, keep only episode files (Netflix can fetch one just
      // before the URL changes), which skips the short trailers on the browse page.
      if (!location.pathname.startsWith('/watch') && !isEpisodeLength(cues)) return;
      if (this.store.addChunk(cues)) {
        log(`file ${this.store.totalChunks}: ${cues.length} cues, ${cues[0]?.begin.toFixed(2)}–${cues.at(-1)?.end.toFixed(2)} s, video at ${data.currentTime?.toFixed(2)} s`);
      }
    } catch (error) {
      log('could not read message', error);
    }
  }

  /** Watches only Netflix's caption element, re-finding it if Netflix replaces it. */
  private watchNative(): void {
    const el = document.querySelector<HTMLElement>(NATIVE_SELECTOR);
    if (el === this.watchedNative) return;
    this.nativeObserver?.disconnect();
    this.watchedNative = el;
    this.nativeObserver = null;
    if (!el) return;
    this.nativeObserver = new MutationObserver(() => this.guard(() => this.readNative()));
    this.nativeObserver.observe(el, { childList: true, subtree: true, characterData: true });
    this.readNative();
  }

  private readNative(): void {
    const text = this.watchedNative?.innerText.trim() ?? '';
    if (text === this.nativeText) return;
    this.nativeText = text;
    this.sampleNativeStyle();

    const video = this.watchedVideo;
    if (!text || !video || video.seeking) return;
    const offset = this.store.anchor(text, video.currentTime);
    if (offset !== null) log(`caption anchored at offset ${offset.toFixed(3)} s`);
    if (!video.paused && performance.now() >= this.settleUntil) {
      const error = this.store.syncError(text, video.currentTime);
      if (error !== null && Math.abs(error) < 2) {
        this.syncErrors.push(error);
        if (this.syncErrors.length > SYNC_SAMPLES) this.syncErrors.shift();
      }
    }
  }

  /** Copies type and placement from Netflix's caption while it has one on screen. */
  private sampleNativeStyle(): void {
    const container = this.watchedNative?.querySelector<HTMLElement>(NATIVE_TEXT_SELECTOR);
    const { box } = this;
    if (!container || !this.nativeText || box.height === 0) {
      this.nativePlacement = null;
      return;
    }
    const rect = container.getBoundingClientRect();
    if (rect.height === 0) {
      this.nativePlacement = null;
      return;
    }
    const x = (rect.left + rect.width / 2 - box.left) / box.width;
    if (rect.top + rect.height / 2 < box.top + box.height / 2) {
      this.nativePlacement = { x, y: 'top', offset: (rect.top - box.top) / box.height };
    } else {
      const offset = (box.top + box.height - rect.bottom) / box.height;
      this.nativePlacement = { x, y: 'bottom', offset };
      this.bottomOffset = offset;
    }

    const textEl = container.querySelector<HTMLElement>('span span') ?? container;
    const computed = getComputedStyle(textEl);
    const fontPx = parseFloat(computed.fontSize);
    if (fontPx > 0) {
      this.style = {
        fontRatio: fontPx / box.height,
        color: computed.color,
        fontFamily: computed.fontFamily,
        fontWeight: computed.fontWeight,
        textShadow: computed.textShadow === 'none' ? DEFAULT_CAPTION_STYLE.textShadow : computed.textShadow,
      };
    }
  }

  private watchVideo(video: HTMLVideoElement | null): void {
    if (video === this.watchedVideo) return;
    this.watchedVideo = video;
    video?.addEventListener('seeking', () => this.settle());
    video?.addEventListener('seeked', () => this.settle());
  }

  /** The slower work: runs a few times a second rather than every frame. */
  private measure(): void {
    this.checkEpisode();
    this.watchVideo(document.querySelector('video'));
    if (this.watchedVideo) {
      const r = this.watchedVideo.getBoundingClientRect();
      this.box = { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    this.watchNative();
    this.sampleNativeStyle();
    this.recoverTrack();
    this.syncSession();
  }

  /** Keeps the learning session on the current episode and playback position. */
  private syncSession(): void {
    const session = this.session;
    const video = this.watchedVideo;
    const videoId = location.pathname.match(/^\/watch\/(\d+)/)?.[1];
    if (!session || !video || !videoId) return;
    session.setEpisode(videoId);

    const layout = this.store.layoutKey();
    if (layout !== this.lastLayout) {
      this.lastLayout = layout;
      const build = ++this.layoutBuild;
      void buildLines(this.store.timeline()).then((lines) => {
        if (build === this.layoutBuild) session.setLines(lines, video.currentTime);
      });
    }
    const counting = !video.paused && !video.seeking && document.visibilityState === 'visible';
    session.tick(video.currentTime, counting);
  }

  private displayLines(cue: Cue): Run[][] {
    const hybrid = this.session?.linesFor(cue);
    if (!hybrid) return cue.lines;
    return this.revealing ? [...hybrid, [{ text: cue.text.replace(/\n/g, ' '), reveal: true }]] : hybrid;
  }

  private frame = (): void => {
    if (!this.running) return;
    this.frameId = requestAnimationFrame(this.frame);
    this.guard(() => this.draw());
  };

  private draw(): void {
    // After the extension is reloaded, this copy of the code can no longer use its APIs.
    if (!browser.runtime?.id) throw new Error('extension was reloaded; reload this tab');
    if (import.meta.env.DEV && document.documentElement.dataset.subtitleLearningFail) throw new Error('forced failure');
    if (this.watchedVideo === null) this.measure();
    const video = this.watchedVideo;
    if (!video?.isConnected || !location.pathname.startsWith('/watch') || this.passthrough) {
      this.watchVideo(null);
      this.host.remove();
      this.hideStyle.remove();
      this.lastKey = '';
      return;
    }
    if (this.box.height === 0) this.measure();

    const t = video.currentTime;
    const settling = video.seeking || performance.now() < this.settleUntil;
    const active = this.store.activeAt(t);
    const source = chooseSource(active, this.nativeText, settling);
    const debug = import.meta.env.DEV ? this.debugLabel(source, t) : undefined;
    const shown = active.map((cue) => ({ ...cue, lines: this.displayLines(cue) }));

    const key = JSON.stringify([source, shown.map((c) => c.lines), this.nativeText, this.nativePlacement, this.box, this.style, debug]);
    if (key === this.lastKey) return;
    this.lastKey = key;

    const blocks = buildBlocks(source, shown, this.nativeText, this.nativePlacement, this.bottomOffset);
    render(<Caption blocks={blocks} box={this.box} style={this.style} debug={debug} />, this.mount);

    // Stay inside the fullscreen element so the layer survives fullscreen.
    const parent = document.fullscreenElement ?? document.body;
    if (this.host.parentElement !== parent) parent.append(this.host);
    // Netflix's captions are hidden only once ours are actually drawn.
    if (blocks.length > 0 && !this.hideStyle.isConnected) document.documentElement.append(this.hideStyle);
  }

  private debugLabel(source: string, t: number): string {
    const sync = syncSummary(this.syncErrors);
    const syncText = sync ? `sync ${sync.median}/${sync.p95} ms` : 'sync –';
    const build = `v${browser.runtime.getManifest().version} ${__BUILD_TIME__}`;
    return `${build} · ${source} · ${this.store.describe()} · track ${this.trackStatus ?? '?'} · ${syncText} · ${t.toFixed(1)} s${this.session ? ` · ${this.session.describe()}` : ''}`;
  }
}
