import { useStore } from '@/store/store';
import { useNexusUi } from '../state/uiStore';
import { recentProjects } from '../data/selectors';
import { workspaceForDomain } from '../workspaces/mapping';
import { navigate } from '../router/useRoute';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { Button } from '../ui/Button';

export function ContinueLine() {
  const projects = useStore((s) => s.projects);
  const lastId = useNexusUi((s) => s.lastProject);
  const p = projects.find((x) => x.id === lastId) ?? recentProjects(projects, 1)[0];
  if (!p) return null;
  const ws = workspaceForDomain(p.domainId);
  return (
    <div className="nx-continue">
      <div><p className="nx-continue__k">Continue</p>
        <p className="nx-continue__name"><ProvenanceMark slot={ws?.hueSlot ?? null} /> {p.name}</p></div>
      <Button onClick={() => navigate({ name: 'project', id: p.id, tool: 'bench' })}>Open</Button>
    </div>
  );
}
