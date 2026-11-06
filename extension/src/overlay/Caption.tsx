// The caption layer drawn over the video in place of Netflix's own captions.
// It is meant to be indistinguishable from Netflix's captions in type and placement.

export interface CaptionProps {
  lines: string[];
  /** Video box in viewport pixels. */
  box: { left: number; top: number; width: number; height: number };
  debug?: string;
}

export const CAPTION_CSS = `
:host { all: initial; }
.layer {
  position: fixed;
  pointer-events: none;
  z-index: 2147483000;
}
.caption {
  position: absolute;
  left: 6%;
  right: 6%;
  bottom: 9%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.12em;
  font-family: 'Netflix Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-weight: 500;
  line-height: 1.22;
  letter-spacing: 0.005em;
  color: #fff;
  text-align: center;
  text-shadow: 0 0 7px rgba(0, 0, 0, 0.9), 0 1px 2px rgba(0, 0, 0, 0.9);
}
.line { white-space: pre-wrap; }
.debug {
  position: absolute;
  top: 12px;
  left: 12px;
  font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace;
  color: rgba(255, 255, 255, 0.55);
  text-shadow: none;
}
`;

export function Caption({ lines, box, debug }: CaptionProps) {
  const fontPx = Math.min(56, Math.max(16, box.height * 0.045));
  return (
    <div class="layer" style={{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }}>
      {lines.length > 0 && (
        <div class="caption" style={{ fontSize: `${fontPx}px` }}>
          {lines.map((l, i) => (
            <div class="line" key={i}>
              {l}
            </div>
          ))}
        </div>
      )}
      {debug && <div class="debug">{debug}</div>}
    </div>
  );
}
