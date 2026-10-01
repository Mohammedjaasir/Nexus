import { useStore } from '@/store/store';
import { Icon } from '../icons';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { useNexusUi } from '../state/uiStore';
import { setupProgress, setupSteps } from '../data/selectors';

export function SetupCard() {
  const projectCount = useStore((s) => s.projects.length);
  const lastWorkspace = useNexusUi((s) => s.lastWorkspace);
  const dismissed = useNexusUi((s) => s.setupDismissed);
  const dismiss = useNexusUi((s) => s.dismissSetup);
  const actions = useShellActions();
  const steps = setupSteps({ lastWorkspace, projectCount });
  const p = setupProgress(steps);
  if (dismissed) return null;
  if (p.done === p.available) {
    return (
      <div className="nx-setup nx-setup--done">
        <span>Setup complete for now · {p.total - p.available} steps arrive later</span>
        <button type="button" className="nx-linkbtn nx-focusable" onClick={dismiss}>Hide</button>
      </div>
    );
  }
  const act = { workspace: () => navigate({ name: 'home' }), project: () => actions.openNewProject() } as const;
  return (
    <section className="nx-setup" aria-labelledby="nx-setup-title">
      <header className="nx-setup__head"><h2 id="nx-setup-title">Get set up</h2><span>{p.done} of {p.available}</span></header>
      <ol className="nx-setup__list">
        {steps.map((s) => (
          <li key={s.id} className={`nx-setup__step is-${s.state}`} title={s.hint}>
            <Icon name={s.state === 'done' ? 'check' : s.state === 'locked' ? 'lock' : 'circle'} size={15} />
            {s.state === 'todo' && (s.id === 'workspace' || s.id === 'project')
              ? <button type="button" className="nx-linkbtn nx-focusable" onClick={act[s.id]}>{s.label}</button>
              : <span>{s.label}</span>}
            {s.state === 'locked' && <span className="nx-sr-only">— available in a later phase</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
