import { useAssistant } from '../assistant/useAssistant';
import { useNexusUi } from '../state/uiStore';
import { RunStrip } from './RunStrip';
import { useRuns } from './useRuns';

/** Requests sent from this project in this session, newest first. */
export function ProjectRuns({ projectId }: { projectId: string }) {
  const port = useAssistant();
  const setDraft = useNexusUi((s) => s.setDraft);
  const focusIntent = useNexusUi((s) => s.focusIntent);
  const entries = useRuns().filter((e) => e.request.projectId === projectId).reverse();
  return (
    <section className="nx-surface" aria-labelledby="nx-surface-title">
      <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>Runs</h1>
      {entries.length === 0 ? (
        <p className="nx-muted">No requests sent from this project in this session. Requests you send with the intent line appear here.</p>
      ) : (
        <ul className="nx-runs">
          {entries.map(({ request, run }) => (
            <li key={request.id}>
              <RunStrip
                run={run}
                onOpenConversation={port.openConversation}
                // Prefill only: the user reviews and sends it themselves.
                onRetry={() => { setDraft(request.text); focusIntent(); }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
