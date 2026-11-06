// The caption layer drawn over the video in place of Netflix's own captions.
// It copies Netflix's type and placement so it can't be told apart from them.
import type { Block } from './display';

export interface CaptionStyle {
  /** Font size as a fraction of the picture height. */
  fontRatio: number;
  color: string;
  fontFamily: string;
  fontWeight: string;
  textShadow: string;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontRatio: 0.045,
  color: '#fff',
  fontFamily: "'Netflix Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  fontWeight: '500',
  textShadow: 'rgba(0, 0, 0, 0.9) 0 0 7px, rgba(0, 0, 0, 0.9) 0 1px 2px',
};

export interface CaptionProps {
  blocks: Block[];
  /** Video box in viewport pixels. */
  box: { left: number; top: number; width: number; height: number };
  style: CaptionStyle;
  debug?: string;
}

export const CAPTION_CSS = `
:host { all: initial; }
.layer {
  position: fixed;
  pointer-events: none;
  z-index: 2147483000;
}
.block {
  position: absolute;
  max-width: 88%;
  transform: translateX(-50%);
  line-height: 1.22;
  text-align: center;
}
.line { white-space: pre-wrap; }
.debug {
  position: absolute;
  top: 12px;
  left: 12px;
  font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace;
  color: rgba(255, 255, 255, 0.55);
}
`;

export function Caption({ blocks, box, style, debug }: CaptionProps) {
  const fontSize = `${Math.min(72, Math.max(14, box.height * style.fontRatio))}px`;
  return (
    <div class="layer" style={{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }}>
      {blocks.map((block, b) => (
        <div
          class="block"
          key={b}
          data-testid="caption-block"
          style={{
            left: `${block.x * 100}%`,
            [block.y]: `${block.offset * 100}%`,
            fontSize,
            color: style.color,
            fontFamily: style.fontFamily,
            fontWeight: style.fontWeight,
            textShadow: style.textShadow,
          }}
        >
          {block.lines.map((line, l) => (
            <div class="line" key={l}>
              {line.map((run, r) => (run.italic ? <i key={r}>{run.text}</i> : <span key={r}>{run.text}</span>))}
            </div>
          ))}
        </div>
      ))}
      {debug && <div class="debug" data-testid="debug-label">{debug}</div>}
    </div>
  );
}
