// A plain development panel. The real controls are designed in Phase 4.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { WORDS_PER_HOUR } from '../../src/engine/constants';
import { createState } from '../../src/engine/s6r';
import { deserializeState, serializeState } from '../../src/learning/session';
import {
  ENABLED_KEY,
  EXPORT_LINES_MESSAGE,
  isEnabledValue,
  JUMP_KEY,
  type JumpRequest,
  LAST_ERROR_KEY,
  LEARNER_KEY,
  PACE_KEY,
  RELAX_TICKS_KEY,
  STATUS_MESSAGE,
  type TabStatus,
} from '../../src/settings';

const STAGES = [20, 90, 175, 350, 550];
const PACES: [string, number][] = [['Gentle', 0.75], ['Balanced', 1], ['Immersive', 1.2]];
const style = `
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; width: 270px; color: #191816; background: #f3eee5; }
  main { padding: 12px; display: grid; gap: 10px; }
  .row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  button { font: inherit; padding: 3px 7px; border: 1px solid #6f6a62; background: none; border-radius: 3px; cursor: pointer; }
  button.on { background: #191816; color: #f3eee5; }
  small { color: #6f6a62; display: block; }
  .status { padding: 6px 8px; border: 1px solid #d9d2c5; border-radius: 3px; }
`;

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function statusText(tab: { url?: string } | undefined, status: TabStatus | null): string {
  if (!tab?.url?.startsWith('https://www.netflix.com/')) return 'Go to a Netflix tab to use this.';
  if (!tab.url.includes('/watch')) return 'Open an episode on Netflix.';
  if (!status) return 'Not connected. Reload the Netflix tab.';
  if (!status.running) return 'Switched off.';
  if (status.lines === 0) return 'Connected. Waiting for subtitles (ads play first).';
  if (status.stopped === 'over_budget') return `${status.lines} lines. Daily spending cap reached, staying in English.`;
  if (status.stopped === 'unconfigured') return `${status.lines} lines. No translation service set up.`;
  return `Working. ${status.translated} of ${status.lines} lines translated.`;
}

function Panel() {
  const [enabled, setEnabled] = useState(true);
  const [hour, setHour] = useState(0);
  const [pace, setPace] = useState(1);
  const [status, setStatus] = useState('Checking...');
  const [exported, setExported] = useState('');
  const [lastError, setLastError] = useState('');

  useEffect(() => {
    void browser.storage.local.get([ENABLED_KEY, LEARNER_KEY, PACE_KEY, LAST_ERROR_KEY]).then((s) => {
      setLastError(String(s[LAST_ERROR_KEY] ?? ''));
      setEnabled(isEnabledValue(s[ENABLED_KEY]));
      setHour(((s[LEARNER_KEY] as { wordsParsed?: number } | undefined)?.wordsParsed ?? 0) / WORDS_PER_HOUR);
      setPace(Number(s[PACE_KEY]) || 1);
    });
    const refresh = async () => {
      const tab = await activeTab();
      const reply = tab?.id === undefined ? null : await browser.tabs.sendMessage(tab.id, { type: STATUS_MESSAGE }).catch(() => null);
      setStatus(statusText(tab, (reply as TabStatus | null) ?? null));
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, []);

  const toggle = () => {
    void browser.storage.local.set({ [ENABLED_KEY]: !enabled });
    setEnabled(!enabled);
  };
  const jump = async (to: number, reset = false) => {
    // Saved here too, so it holds even with no Netflix tab open.
    const stored = await browser.storage.local.get(LEARNER_KEY);
    const next = createState(to);
    if (!reset) next.lemmaCounts = deserializeState(stored[LEARNER_KEY])?.lemmaCounts ?? next.lemmaCounts;
    const request: JumpRequest = { hour: to, reset, nonce: Date.now() };
    // Stages reached without learning the words before them skip the tick gate.
    await browser.storage.local.set({ [LEARNER_KEY]: serializeState(next), [JUMP_KEY]: request, [RELAX_TICKS_KEY]: to > 0 });
    setHour(to);
  };
  const choosePace = (value: number) => {
    void browser.storage.local.set({ [PACE_KEY]: value });
    setPace(value);
  };
  const exportLines = async () => {
    const tab = await activeTab();
    const count = tab?.id === undefined ? null : await browser.tabs.sendMessage(tab.id, { type: EXPORT_LINES_MESSAGE }).catch(() => null);
    setExported(count ? `Saved ${count} lines to your Downloads folder.` : 'Nothing to save yet. Play an episode first, then reload the tab if this persists.');
  };

  return (
    <main>
      <style>{style}</style>
      <div class="status" data-testid="status">{status}</div>
      <button class={enabled ? 'on' : ''} onClick={toggle}>{enabled ? 'On' : 'Off'}</button>
      {import.meta.env.DEV && (
        <>
          <div>
            <div data-testid="hour">Learner at hour {hour.toFixed(1)} <small style={{ display: 'inline' }}>of 600</small></div>
            <small>How far along the French course you are. Higher means more French. Drag, or pick a stage.</small>
            <input
              type="range" min="0" max="600" step="1" value={hour} style={{ width: '100%' }}
              onChange={(e) => void jump(Number(e.currentTarget.value))}
            />
            <div class="row">
              {STAGES.map((s) => <button key={s} onClick={() => void jump(s)}>{s} h</button>)}
            </div>
          </div>
          <div>
            <small>How quickly French is added</small>
            <div class="row">
              {PACES.map(([label, value]) => (
                <button key={label} class={pace === value ? 'on' : ''} onClick={() => choosePace(value)}>{label}</button>
              ))}
            </div>
          </div>
          <div class="row">
            <button onClick={() => void jump(0, true)}>Reset progress</button>
            <button onClick={() => void exportLines()}>Export lines</button>
          </div>
          {exported && <small data-testid="exported">{exported}</small>}
          {lastError && <small>Last problem: {lastError}</small>}
          <small>French is shown in a warm tint. Hold E on Netflix, with French on screen, to see the English under it.</small>
        </>
      )}
    </main>
  );
}

render(<Panel />, document.getElementById('app')!);
