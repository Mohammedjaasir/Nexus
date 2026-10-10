import type { ExecAvailability } from '../data/executionModel';
import { noticeFor } from '../data/executionModel';
import { Button } from '../ui/Button';

/** One role="status" line while jobs cannot run here (a held upgrade, execution off, Docker stopped, disk below
 *  the gate), with "How to set up" when the fix is on this computer. Renders nothing when jobs can run. */
export function ExecutionNotice({ availability, onSetup }: { availability: ExecAvailability; onSetup?: () => void }) {
  const n = noticeFor(availability);
  if (!n) return null;
  return (
    <div className="nx-platform-notice nx-exn" role="status">
      <span className="nx-platform-notice__text">{n.text}</span>
      {n.setup && onSetup && <Button variant="quiet" onClick={onSetup}>How to set up</Button>}
    </div>
  );
}
