import { usePlatform } from '../data/platformStore';
import { unavailableNotice } from '../data/errorCopy';
import { loadParticipations } from '../data/useParticipations';
import { Button } from '../ui/Button';

/** The one non-fatal platform banner. While the platform is unavailable it says
 *  why and that projects are grouped by their detected domain; after a passing
 *  failure (a busy database) it offers to try again. Otherwise it renders nothing. */
export function PlatformNotice() {
  const unavailable = usePlatform((s) => s.unavailable);
  const retry = usePlatform((s) => s.retry);
  if (unavailable) {
    return <p className="nx-platform-notice" role="status">{unavailableNotice(unavailable.reason)}</p>;
  }
  if (retry) {
    return (
      <div className="nx-platform-notice" role="status">
        <span className="nx-platform-notice__text">{retry.text}</span>
        <Button variant="quiet" icon="refresh" onClick={() => { void loadParticipations(); }}>Try again</Button>
      </div>
    );
  }
  return null;
}
