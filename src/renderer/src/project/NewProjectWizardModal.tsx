import { useState } from 'react';
import type { DomainId } from '@shared/domain';
import type { Project } from '@shared/project';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';
import { useStore } from '../store/store';

export interface NewProjectWizardModalProps {
  isOpen: boolean;
  initialDomainId?: DomainId;
  onClose: () => void;
  onProjectCreated: (project: Project) => void;
}

export function NewProjectWizardModal({
  isOpen,
  initialDomainId = 'software-engineering',
  onClose,
  onProjectCreated
}: NewProjectWizardModalProps) {
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setProjects = useStore((s) => s.setProjects);

  const [step, setStep] = useState<1 | 2>(1);
  const [domainId, setDomainId] = useState<DomainId>(initialDomainId);
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [goal, setGoal] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handlePickDirectory = async () => {
    try {
      const res = await window.cth.chooseFolder();
      if (res && res.ok && res.path) {
        setRootPath(res.path);
        if (!name) {
          const parts = res.path.split(/[\\/]/).filter(Boolean);
          setName(parts[parts.length - 1] || 'my-project');
        }
      }
    } catch {
      // ignore
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Please provide a project name');
      return;
    }
    if (!rootPath.trim()) {
      setError('Please specify a project directory path');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      // 1. Create project via ProjectManager
      const res = await window.cth.projectCreate({
        name: name.trim(),
        rootPath: rootPath.trim(),
        domainId,
        description: goal.trim() || undefined
      });

      if (!res.ok || !res.project) {
        throw new Error(res.error || 'Failed to create project');
      }

      const created = res.project;

      // 2. If goal was provided, set the goal and derive capabilities
      if (goal.trim()) {
        await window.cth.projectGoalSet(created.id, goal.trim());
        await window.cth.projectGoalReconcile(created.id);
      }

      // 3. Update store and transition
      setActiveProject(created);
      const list = await window.cth.projectList();
      setProjects(list);

      onProjectCreated(created);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Error creating project');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(23, 20, 16, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 300,
        padding: 24
      }}
    >
      <div style={{ width: 620, maxWidth: '96vw' }}>
        <PixelPanel variant="dialog" title="NEW PROJECT" noPadding>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {step === 1 && (
              <>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--cth-ink-800)', display: 'block', marginBottom: 6 }}>
                    1. SELECT ENGINEERING DOMAIN
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                    {(['software-engineering', 'ai-ml', 'cybersecurity'] as DomainId[]).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDomainId(d)}
                        style={{
                          padding: 10,
                          textAlign: 'left',
                          background: domainId === d ? 'var(--cth-cream-200)' : '#fff',
                          border: `2px solid ${domainId === d ? 'var(--cth-ink-900)' : 'var(--cth-ink-200)'}`,
                          cursor: 'pointer',
                          fontFamily: 'inherit'
                        }}
                      >
                        <div style={{ fontSize: 14 }}>
                          {d === 'software-engineering' ? '💻' : d === 'ai-ml' ? '🧠' : '🛡️'}
                        </div>
                        <div style={{ fontSize: 11, fontWeight: 700, marginTop: 4 }}>
                          {d === 'software-engineering' ? 'Software' : d === 'ai-ml' ? 'AI / ML' : 'Security'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--cth-ink-800)', display: 'block', marginBottom: 4 }}>
                    2. PROJECT NAME
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. invoice-ocr-api"
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      fontSize: 12,
                      border: '1px solid var(--cth-ink-300)',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--cth-ink-800)', display: 'block', marginBottom: 4 }}>
                    3. WORKSPACE DIRECTORY PATH
                  </label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      value={rootPath}
                      onChange={(e) => setRootPath(e.target.value)}
                      placeholder="C:\projects\my-app"
                      style={{
                        flex: 1,
                        padding: '8px 10px',
                        fontSize: 12,
                        border: '1px solid var(--cth-ink-300)',
                        boxSizing: 'border-box'
                      }}
                    />
                    <PixelButton variant="secondary" size="sm" onClick={handlePickDirectory}>
                      Browse…
                    </PixelButton>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                  <PixelButton variant="secondary" size="md" onClick={onClose}>
                    Cancel
                  </PixelButton>
                  <PixelButton
                    variant="primary"
                    size="md"
                    onClick={() => {
                      if (!name.trim() || !rootPath.trim()) {
                        setError('Please specify project name and path');
                        return;
                      }
                      setError(null);
                      setStep(2);
                    }}
                  >
                    Next: Define Goal →
                  </PixelButton>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--cth-ink-800)', display: 'block', marginBottom: 6 }}>
                    4. WHAT ARE YOU BUILDING? (PROJECT GOAL)
                  </label>
                  <textarea
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder="e.g. Build a production OCR API with FastAPI, image preprocessing, and unit tests."
                    rows={3}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      fontSize: 12,
                      border: '1px solid var(--cth-ink-300)',
                      fontFamily: 'inherit',
                      boxSizing: 'border-box'
                    }}
                  />
                  <div style={{ fontSize: 10, color: 'var(--cth-ink-500)', marginTop: 4 }}>
                    The system will automatically derive domain capabilities, analyze gaps, and build the initial milestone DAG.
                  </div>
                </div>

                {error && (
                  <div style={{ fontSize: 11, color: '#E53E3E', background: '#FFF0F0', padding: 8, border: '1px solid #E53E3E' }}>
                    {error}
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <PixelButton variant="secondary" size="md" onClick={() => setStep(1)} disabled={creating}>
                    ← Back
                  </PixelButton>
                  <PixelButton variant="primary" size="md" onClick={handleCreate} disabled={creating}>
                    {creating ? 'Creating & Initializing…' : 'Create & Enter Project →'}
                  </PixelButton>
                </div>
              </>
            )}
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
