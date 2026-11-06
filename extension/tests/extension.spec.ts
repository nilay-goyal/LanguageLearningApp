// Loads the built extension into Chromium and runs it against the fake Netflix page.
// Run with `npm run test:e2e`, which builds first.
import { type BrowserContext, chromium, expect, type Page, test, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fakeWatchPage, type FakeOptions, LINE_LENGTH, LINE_SPACING, subtitleFile, TOP_LINE } from './fakeNetflix';

declare const chrome: { storage: { local: { set(items: object): Promise<void>; get(key: string): Promise<Record<string, any>> } } };

const EXTENSION = resolve('.output/chrome-mv3-dev');
/** Allowed gap between the video clock and the caption on screen. */
const SYNC_TOLERANCE = 0.1;

let context: BrowserContext;
let worker: Worker;
let profile: string;
let api: Server;
/** What the mock API does with each request. Replace per test. */
let apiHandler: (body: any) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
let apiCalls = 0;
let apiAuth: string | undefined;

const stats = { cached: 0, translated: 1, dropped: 0, refused: false, costUsd: 0 };
const noFrench = (body: any) => ({
  status: 200,
  body: { results: Object.fromEntries(body.lines.map((l: any) => [l.hash, { units: [], full: null }])), stats },
});
/** Every line gets a phrase and a full sentence. */
const allFrench = (body: any) => ({
  status: 200,
  body: {
    results: Object.fromEntries(
      body.lines.map((l: any) => [
        l.hash,
        {
          units: [{ start: 0, end: 2, text: 'la ligne', lemmas: ['le', 'ligne'], score: 2 }],
          full: { text: `FR ${l.text}`, lemmas: ['phrase'] },
        },
      ]),
    ),
    stats,
  },
});

test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), 'subtitle-learning-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 960, height: 540 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  apiHandler = noFrench;
  apiCalls = 0;
  api = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      apiCalls++;
      apiAuth = req.headers.authorization;
      const { status, body } = await apiHandler(JSON.parse(raw));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((done) => api.listen(0, '127.0.0.1', done));
  const { port } = api.address() as AddressInfo;
  await worker.evaluate((url) => chrome.storage.local.set({ apiOverride: { url, token: 'test-token' } }), `http://localhost:${port}`);
});

test.afterEach(async () => {
  await context.close();
  api.close();
  rmSync(profile, { recursive: true, force: true });
});

async function openWatch(options: Partial<FakeOptions> = {}, path = '/watch/1'): Promise<Page> {
  const page = await context.newPage();
  await context.route('https://www.netflix.com/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/fake-subs/')) {
      const [, , name] = url.pathname.split('/');
      const language = name!.startsWith('fr') ? 'fr' : 'en';
      const body = subtitleFile(`${language}${name!.match(/_watch_(\d+)/)?.[1] ?? ''}`, language);
      return route.fulfill({ status: 200, contentType: 'text/xml', body });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: fakeWatchPage({ initialTrack: 'en', hasEnglish: true, ...options }),
    });
  });
  await page.goto(`https://www.netflix.com${path}`);
  return page;
}

const shadowText = () => {
  const root = document.getElementById('subtitle-learning-root')?.shadowRoot;
  return [...(root?.querySelectorAll('[data-testid="caption-block"]') ?? [])].map((el) => (el as HTMLElement).innerText).join('|');
};

const captionText = (page: Page) => page.evaluate(shadowText);
const expectCaption = (page: Page, pattern: RegExp) => expect.poll(() => captionText(page), { timeout: 10_000 }).toMatch(pattern);

const nativeOpacity = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.querySelector('.player-timedtext')!).opacity);

const setEnabled = (value: boolean) => worker.evaluate((v) => chrome.storage.local.set({ enabled: v }), value);

const seek = (page: Page, t: number) => page.evaluate((x) => { document.querySelector('video')!.currentTime = x; }, t);

/** Watches the screen for a while; returns frames where the wrong line was on screen. */
async function measureSync(page: Page, prefix: string, ms: number): Promise<{ frames: number; wrong: string[] }> {
  return page.evaluate(
    ({ prefix, ms, spacing, length, tolerance, shadow }) =>
      new Promise((done) => {
        const read = new Function(`return (${shadow})()`) as () => string;
        const video = document.querySelector('video')!;
        const wrong: string[] = [];
        let frames = 0;
        const end = performance.now() + ms;
        (function tick() {
          const t = video.currentTime;
          const i = Math.floor(t / spacing);
          const within = t - i * spacing;
          const shown = read();
          // Skip the moments right around a line starting or ending.
          if (within > tolerance && within < length - tolerance) {
            frames++;
            if (shown !== `${prefix} line ${i}`) wrong.push(`${t.toFixed(2)}: "${shown}"`);
          } else if (within > length + tolerance && within < spacing - tolerance) {
            frames++;
            if (shown !== '') wrong.push(`${t.toFixed(2)}: "${shown}" in a gap`);
          }
          if (performance.now() < end) requestAnimationFrame(tick);
          else done({ frames, wrong });
        })();
      }),
    { prefix, ms, spacing: LINE_SPACING, length: LINE_LENGTH, tolerance: SYNC_TOLERANCE, shadow: shadowText.toString() },
  );
}

test('replaces Netflix captions and stays in sync', async () => {
  const page = await openWatch();
  await expectCaption(page, /^en1 line \d+$/);
  expect(await nativeOpacity(page)).toBe('0');
  const { frames, wrong } = await measureSync(page, 'en1', 7000);
  expect(frames).toBeGreaterThan(50);
  expect(wrong).toEqual([]);
});

test('stays in sync through seeking, speed changes and pause', async () => {
  const page = await openWatch();
  await expectCaption(page, /^en1 line/);

  await seek(page, 198.5);
  await expectCaption(page, /^en1 line 66$/);
  expect((await measureSync(page, 'en1', 4000)).wrong).toEqual([]);

  await seek(page, 31);
  await expectCaption(page, /^en1 line 10$/);

  await page.evaluate(() => { document.querySelector('video')!.playbackRate = 1.5; });
  expect((await measureSync(page, 'en1', 4000)).wrong).toEqual([]);

  // Pause partway through a line: the caption stays on screen.
  await page.evaluate(() => {
    const v = document.querySelector('video')!;
    v.playbackRate = 1;
    v.currentTime = 90.8;
    v.pause();
  });
  await expectCaption(page, /^en1 line 30$/);
  await page.waitForTimeout(1500);
  expect(await captionText(page)).toBe('en1 line 30');
});

test('works with Netflix captions not displaying, and keeps top placement', async () => {
  const page = await openWatch();
  await page.evaluate(() => { (window as any).fake.nativeOn = false; });
  await seek(page, TOP_LINE * LINE_SPACING + 0.3);
  await expectCaption(page, new RegExp(`^en1 line ${TOP_LINE}$`));
  const box = await page.evaluate(() => {
    const el = document.getElementById('subtitle-learning-root')!.shadowRoot!.querySelector('[data-testid="caption-block"]')!;
    return el.getBoundingClientRect().top;
  });
  expect(box).toBeLessThan(100);
});

test('copies the type and position of the Netflix caption', async () => {
  const page = await openWatch();
  await page.evaluate(() => { document.querySelector('video')!.pause(); });
  await seek(page, 0.5);
  await expectCaption(page, /^en1 line 0$/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.getElementById('subtitle-learning-root')!.shadowRoot!.querySelector<HTMLElement>('[data-testid="caption-block"]')!;
        const s = getComputedStyle(el);
        const native = document.querySelector('.player-timedtext-text-container')!.getBoundingClientRect();
        return { size: s.fontSize, color: s.color, weight: s.fontWeight, gap: Math.round(Math.abs(el.getBoundingClientRect().bottom - native.bottom)) };
      }),
    )
    .toMatchObject({ size: '30px', color: 'rgb(255, 255, 0)', weight: '700', gap: 0 });
});

test('turns English on when subtitles are off, and restores on switching off', async () => {
  const page = await openWatch({ initialTrack: 'off' });
  await expectCaption(page, /^en1 line/);
  expect(await page.evaluate(() => (window as any).fake.currentTrack())).toBe('en');

  await setEnabled(false);
  await expect.poll(() => page.evaluate(() => (window as any).fake.currentTrack())).toBe('off');
});

test('keeps trying when the player ignores the first switch', async () => {
  const page = await openWatch({ initialTrack: 'off', ignoreChangesMs: 6000 });
  await expect.poll(() => captionText(page), { timeout: 20_000 }).toMatch(/^en1 line/);
  expect(await page.evaluate(() => (window as any).fake.currentTrack())).toBe('en');
});

test('gets the file again if English was on but its download was missed', async () => {
  const page = await openWatch({ skipFirstLoad: true });
  await expect.poll(() => captionText(page), { timeout: 20_000 }).toMatch(/^en1 line/);
  expect(await page.evaluate(() => (window as any).fake.currentTrack())).toBe('en');
});

test('keeps a file fetched just before the player URL appears', async () => {
  const page = await openWatch({}, '/browse');
  await page.waitForTimeout(1000);
  expect(await captionText(page)).toBe('');
  await page.evaluate(() => { history.pushState({}, '', '/watch/1'); });
  await expectCaption(page, /^en line/);
});

test('shows the version on the development label', async () => {
  const page = await openWatch();
  await expectCaption(page, /^en1 line/);
  const label = await page.evaluate(() => document.getElementById('subtitle-learning-root')!.shadowRoot!.querySelector<HTMLElement>('[data-testid="debug-label"]')!.innerText);
  expect(label).toMatch(/^v0\.3\.1 \d\d-\d\d \d\d:\d\d · timeline · 1\/1 files/);
});

/** Starts a learner at a stage where switches are frequent, and speeds up the video. */
async function openAtStage(hour: number, rate = 4): Promise<Page> {
  await worker.evaluate(
    (h) => chrome.storage.local.set({ relaxTicks: true, learner: { wordsParsed: h * 8400, credit: 0, ticks: 0, ledger: [], window: [], lastPartialEnd: null, lemmaCounts: {}, rng: 1 } }),
    hour,
  );
  const page = await openWatch();
  await page.evaluate((r) => { document.querySelector('video')!.playbackRate = r; }, rate);
  return page;
}

const savedLearner = () => worker.evaluate(() => chrome.storage.local.get('learner').then((s) => s.learner as { wordsParsed: number; lemmaCounts: Record<string, number> } | undefined));

test('shows French in the captions, tints partial lines, and sends the client token', async () => {
  apiHandler = allFrench;
  const page = await openAtStage(250);
  await expect.poll(() => captionText(page), { timeout: 30_000 }).toMatch(/la ligne|^FR /i);
  expect(apiAuth).toBe('Bearer test-token');
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const l2 = document.getElementById('subtitle-learning-root')!.shadowRoot!.querySelector('.l2');
          return l2 ? getComputedStyle(l2).color : null;
        }),
      { timeout: 30_000 },
    )
    .toBe('rgb(242, 227, 190)');
});

test('never changes a line while it is on screen', async () => {
  apiHandler = async (body) => {
    await new Promise((r) => setTimeout(r, 1500));
    return allFrench(body);
  };
  const page = await openAtStage(400, 1);
  const changes = await page.evaluate(
    ({ shadow }) =>
      new Promise<string[]>((done) => {
        const read = new Function(`return (${shadow})()`) as () => string;
        const video = document.querySelector('video')!;
        const byLine = new Map<number, Set<string>>();
        const end = performance.now() + 12_000;
        (function tick() {
          const t = video.currentTime;
          const i = Math.floor(t / 3);
          const within = t - i * 3;
          const text = read();
          if (within > 0.15 && within < 1.85 && text) {
            const set = byLine.get(i) ?? new Set<string>();
            set.add(text);
            byLine.set(i, set);
          }
          if (performance.now() < end) requestAnimationFrame(tick);
          else done([...byLine.values()].filter((s) => s.size > 1).map((s) => [...s].join(' -> ')));
        })();
      }),
    { shadow: shadowText.toString() },
  );
  expect(changes).toEqual([]);
});

test('counts played lines once, and not again after skipping back', async () => {
  apiHandler = allFrench;
  const page = await openAtStage(100, 8);
  await expect.poll(async () => (await savedLearner())?.wordsParsed ?? 0, { timeout: 30_000 }).toBeGreaterThan(100 * 8400 + 30);
  await seek(page, 0.5);
  await page.waitForTimeout(300);
  await page.evaluate(() => { const v = document.querySelector('video')!; v.playbackRate = 1; });
  const before = (await savedLearner())!.wordsParsed;
  await page.waitForTimeout(4000);
  expect((await savedLearner())!.wordsParsed).toBe(before);
});

test('keeps English captions and playback going when the API fails', async () => {
  apiHandler = () => ({ status: 500, body: { error: 'upstream' } });
  const page = await openAtStage(400, 1);
  await expectCaption(page, /^en1 line/);
  expect((await measureSync(page, 'en1', 4000)).wrong).toEqual([]);
  expect(apiCalls).toBeGreaterThan(0);
});

test('stops asking and stays English when over budget', async () => {
  apiHandler = () => ({ status: 429, body: { error: 'over_budget' } });
  const page = await openAtStage(400, 1);
  await expectCaption(page, /^en1 line/);
  await page.waitForTimeout(6000);
  expect(apiCalls).toBe(1);
  expect((await measureSync(page, 'en1', 2000)).wrong).toEqual([]);
});

test('Hold E shows the English under the French', async () => {
  apiHandler = allFrench;
  const page = await openAtStage(500, 4);
  const hasFrench = async () => /^FR |la ligne/i.test(await captionText(page));
  await expect.poll(hasFrench, { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => { document.querySelector('video')!.pause(); });
  if (!(await hasFrench())) {
    // Paused between switches: play on to the next one.
    await page.evaluate(() => document.querySelector('video')!.play());
    await expect.poll(hasFrench, { timeout: 30_000 }).toBe(true);
    await page.evaluate(() => { document.querySelector('video')!.pause(); });
  }
  const revealed = () => page.evaluate(() => document.getElementById('subtitle-learning-root')!.shadowRoot!.querySelectorAll('.reveal').length);
  expect(await revealed()).toBe(0);
  await page.keyboard.down('e');
  await expect.poll(revealed).toBe(1);
  await page.keyboard.up('e');
  await expect.poll(revealed).toBe(0);
});

test('the panel keeps the hour, even with no Netflix tab open', async () => {
  const id = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/popup.html`);
  await panel.getByRole('button', { name: '175 h' }).click();
  await expect(panel.getByTestId('hour')).toContainText('175.0');
  await panel.reload();
  await expect(panel.getByTestId('hour')).toContainText('175.0');
  expect((await savedLearner())!.wordsParsed).toBe(175 * 8400);
});

test('a jump applies to an open episode, and export saves the lines', async () => {
  apiHandler = allFrench;
  const page = await openWatch();
  await expectCaption(page, /^en1 line/);
  await page.evaluate(() => window.postMessage({ type: 'subtitle-learning:dev', action: 'jump', hour: 500 }, location.origin));
  await expect.poll(async () => (await savedLearner())?.wordsParsed ?? 0).toBeGreaterThanOrEqual(500 * 8400);
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.postMessage({ type: 'subtitle-learning:dev', action: 'export' }, location.origin));
  expect((await download).suggestedFilename()).toBe('subtitle-lines-watch-1.json');
});

test('leaves Netflix alone when the title has no English track', async () => {
  const page = await openWatch({ initialTrack: 'fr', hasEnglish: false });
  await page.waitForTimeout(2000);
  expect(await captionText(page)).toBe('');
  expect(await nativeOpacity(page)).toBe('1');
  expect(await page.evaluate(() => (window as any).fake.currentTrack())).toBe('fr');
});

test('switching off returns Netflix to normal, and back on works', async () => {
  const page = await openWatch();
  await expectCaption(page, /^en1 line/);

  await setEnabled(false);
  await expect.poll(() => page.evaluate(() => document.getElementById('subtitle-learning-root') === null)).toBe(true);
  expect(await nativeOpacity(page)).toBe('1');
  expect(await page.evaluate(() => (window as any).fake.trackLog)).toEqual([]);

  await setEnabled(true);
  await expectCaption(page, /^en1 line/);
  expect(await nativeOpacity(page)).toBe('0');
});

test('stays off after a reload', async () => {
  const page = await openWatch();
  await setEnabled(false);
  await page.reload();
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => document.getElementById('subtitle-learning-root') === null)).toBe(true);
  expect(await nativeOpacity(page)).toBe('1');
});

test('moves to the next episode without showing the old one', async () => {
  const page = await openWatch();
  await expectCaption(page, /^en1 line/);
  await page.evaluate(() => {
    history.pushState({}, '', '/watch/2');
    document.querySelector('video')!.currentTime = 0;
    (window as any).fake.reload();
  });
  await expectCaption(page, /^en2 line/);
  expect((await measureSync(page, 'en2', 3000)).wrong).toEqual([]);
});

test('brings Netflix captions back if our code fails', async () => {
  const page = await openWatch();
  await expectCaption(page, /^en1 line/);
  await page.evaluate(() => { document.documentElement.dataset.subtitleLearningFail = '1'; });
  await expect.poll(() => nativeOpacity(page)).toBe('1');
  expect(await page.evaluate(() => document.getElementById('subtitle-learning-root') === null)).toBe(true);
  // The video keeps playing.
  const before = await page.evaluate(() => document.querySelector('video')!.currentTime);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(before);
});
