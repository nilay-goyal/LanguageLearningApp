// A plain development panel. The real controls are designed in Phase 4.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { WORDS_PER_HOUR } from '../../src/engine/constants';
import {
  ENABLED_KEY,
  EXPORT_LINES_MESSAGE,
  isEnabledValue,
  JUMP_KEY,
  type JumpRequest,
  LEARNER_KEY,
  PACE_KEY,
  RELAX_TICKS_KEY,
} from '../../src/settings';

const STAGES = [20, 90, 175, 350, 550];
const PACES: [string, number][] = [['Gentle', 0.75], ['Balanced', 1], ['Immersive', 1.2]];
const style = `
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; width: 260px; color: #191816; background: #f3eee5; }
  main { padding: 12px; display: grid; gap: 10px; }
  .row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  button { font: inherit; padding: 3px 7px; border: 1px solid #6f6a62; background: none; border-radius: 3px; cursor: pointer; }
  button.on { background: #191816; color: #f3eee5; }
  small { color: #6f6a62; }
`;

function Panel() {
  const [enabled, setEnabled] = useState(true);
  const [hour, setHour] = useState(0);
  const [pace, setPace] = useState(1);

  useEffect(() => {
    void browser.storage.local.get([ENABLED_KEY, LEARNER_KEY, PACE_KEY]).then((s) => {
      setEnabled(isEnabledValue(s[ENABLED_KEY]));
      setHour(((s[LEARNER_KEY] as { wordsParsed?: number } | undefined)?.wordsParsed ?? 0) / WORDS_PER_HOUR);
      setPace(Number(s[PACE_KEY]) || 1);
    });
  }, []);

  const toggle = () => {
    void browser.storage.local.set({ [ENABLED_KEY]: !enabled });
    setEnabled(!enabled);
  };
  const jump = (to: number, reset = false) => {
    const request: JumpRequest = { hour: to, reset, nonce: Date.now() };
    // Stages reached without learning the words before them skip the tick gate.
    void browser.storage.local.set({ [JUMP_KEY]: request, [RELAX_TICKS_KEY]: to > 0 });
    setHour(to);
  };
  const choosePace = (value: number) => {
    void browser.storage.local.set({ [PACE_KEY]: value });
    setPace(value);
  };
  const exportLines = async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) await browser.tabs.sendMessage(tab.id, { type: EXPORT_LINES_MESSAGE });
  };

  return (
    <main>
      <style>{style}</style>
      <button class={enabled ? 'on' : ''} onClick={toggle}>{enabled ? 'On' : 'Off'}</button>
      {import.meta.env.DEV && (
        <>
          <div>
            <div>Hour {hour.toFixed(1)} <small>of 600</small></div>
            <input
              type="range" min="0" max="600" step="1" value={hour} style={{ width: '100%' }}
              onChange={(e) => jump(Number(e.currentTarget.value))}
            />
            <div class="row">
              {STAGES.map((s) => <button key={s} onClick={() => jump(s)}>{s} h</button>)}
            </div>
          </div>
          <div class="row">
            {PACES.map(([label, value]) => (
              <button key={label} class={pace === value ? 'on' : ''} onClick={() => choosePace(value)}>{label}</button>
            ))}
          </div>
          <div class="row">
            <button onClick={() => jump(0, true)}>Reset progress</button>
            <button onClick={() => void exportLines()}>Export lines</button>
          </div>
          <small>Hold E on Netflix to see the English line.</small>
        </>
      )}
    </main>
  );
}

render(<Panel />, document.getElementById('app')!);
