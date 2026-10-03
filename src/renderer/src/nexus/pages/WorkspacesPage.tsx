// WorkspacesPage.tsx
import { useStore } from '@/store/store';
import { WORKSPACES } from '../workspaces/registry';
import { countsByWorkspace } from '../workspaces/mapping';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';

export function WorkspacesPage() {
  const projects = useStore((s) => s.projects);
  const counts = countsByWorkspace(projects);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  return (
    <div className="nx-page">
      <header className="nx-pagehead"><h1 tabIndex={-1}>Workspaces</h1></header>
      <p className="nx-lead">Each workspace groups projects by the kind of work. Projects join a workspace by the domain the analyzer detects.</p>
      <div className="nx-grid">
        {WORKSPACES.map((w) => (
          <button key={w.id} type="button" className="nx-card nx-card--link nx-focusable" onClick={() => { setLast(w.id); navigate({ name: 'workspace', id: w.id }); }}>
            <span className="nx-card__title"><ProvenanceMark slot={w.hueSlot} /> {w.name}</span>
            <span className="nx-card__body">{w.description}</span>
            <span className="nx-card__meta">
              {counts[w.id] > 0 ? `${counts[w.id]} project${counts[w.id] === 1 ? '' : 's'}` : 'No projects yet'}
              {w.domainIds.length > 0 && <> · <span className="nx-mono">{w.domainIds.join(', ')}</span></>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
