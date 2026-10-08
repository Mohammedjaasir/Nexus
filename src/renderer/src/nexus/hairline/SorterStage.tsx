import { useEffect, useRef, useState } from 'react';
import { HL } from './kernel';
import { sorter, type SorterHandle } from './sorter';

/** The Sorter figure, hosted the way Hairline's bench hosts a figure: a stage,
 *  an svg, and a read-out in the corner. `pick` routes the note to a cubby
 *  (-1 for rest); the pointer can still try any cubby by hand, and when it
 *  leaves, the note goes back to `pick`. */
export function SorterStage({ pick }: { pick: number }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handle = useRef<SorterHandle | null>(null);
  const want = useRef(pick);
  const [read, setRead] = useState('rest');

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    HL.inject(document);
    stage.setAttribute('data-hairline', sorter.name);
    const svg = HL.mk('svg', { viewBox: '0 0 400 320', 'aria-hidden': 'true' }, stage) as SVGSVGElement;
    let text: string | null = 'rest';
    const host = {
      stage, svg,
      read: {
        get textContent() { return text; },
        set textContent(v: string | null) { text = v ?? ''; setRead(text); }
      }
    };
    const h = sorter.mount(host, sorter.range[1]);
    handle.current = h;
    h.pick(want.current);
    let timer = 0;
    const back = () => { window.clearTimeout(timer); timer = window.setTimeout(() => handle.current?.pick(want.current), 40); };
    stage.addEventListener('pointerleave', back);
    return () => {
      window.clearTimeout(timer);
      stage.removeEventListener('pointerleave', back);
      h.destroy();
      svg.remove();
      handle.current = null;
    };
  }, []);

  useEffect(() => {
    want.current = pick;
    handle.current?.pick(pick);
  }, [pick]);

  return (
    <div className="nx-welcome__plate">
      <span className="nx-welcome__tag" aria-hidden="true">rack</span>
      <span className="nx-welcome__tag nx-welcome__tag--read" aria-hidden="true">{read}</span>
      <div ref={stageRef} className="nx-welcome__stage" role="img" aria-label={sorter.means} />
    </div>
  );
}
