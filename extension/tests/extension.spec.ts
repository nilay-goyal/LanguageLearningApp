// Loads the built extension into Chromium and runs it against the fake Netflix page.
// Run with `npm run test:e2e`, which builds first.
import { type BrowserContext, chromium, expect, type Page, test, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fakeWatchPage, type FakeOptions, LINE_LENGTH, LINE_SPACING, subtitleFile, TOP_LINE } from './fakeNetflix';

declare const chrome: { storage: { local: { set(items: object): Promise<void> } } };

const EXTENSION = resolve('.output/chrome-mv3-dev');
/** Allowed gap between the video clock and the caption on screen. */
const SYNC_TOLERANCE = 0.1;

let context: BrowserContext;
let worker: Worker;
let profile: string;

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
});

test.afterEach(async () => {
  await context.close();
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
