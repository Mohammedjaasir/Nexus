import { useEffect, useState } from 'react';
import type { DomainId } from '@shared/domain';
import type { Project } from '@shared/project';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';
import { useStore } from '../store/store';

export interface ProjectHomeViewProps {
  onOpenProject: (projectId: string) => void;
  onNewProject: (domainId?: DomainId) => void;
  onImportProject: () => void;
}

export function ProjectHomeView({ onOpenProject, onNewProject, onImportProject }: ProjectHomeViewProps) {
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.cth.projectList().then((list) => {
      setProjects(list);
      setLoading(false);
    });
  }, [setProjects]);

  const domainCards: Array<{
    id: DomainId;
    title: string;
    icon: string;
    color: string;
    description: string;
    roles: string[];
  }> = [
    {
      id: 'software-engineering',
      title: 'Software Engineering',
      icon: '💻',
      color: '#4A90E2',
      description: 'Full-stack applications, microservices, CLI tools, refactoring & verified test suites.',
      roles: ['@jim (Software Eng)', '@angela (Reviewer)', '@dwight (Tester)', '@michael (Architect)']
    },
    {
      id: 'ai-ml',
      title: 'AI / Machine Learning',
      icon: '🧠',
      color: '#9B51E0',
      description: 'OCR pipelines, model inference, dataset preprocessing, evaluation benchmarks & embeddings.',
      roles: ['@ryan (ML Eng)', '@pam (Data Scientist)', '@oscar (Evaluator)', '@toby (Data Pipeline)']
    },
    {
      id: 'cybersecurity',
      title: 'Cybersecurity',
      icon: '🛡️',
      color: '#E65100',
      description: 'Vulnerability analysis, authentication hardening, CSRF/XSS defense, fuzzing & audits.',
      roles: ['@creed (Security Analyst)', '@meredith (Secure Coder)', '@kevin (Pentester)', '@phyllis (Compliance)']
    }
  ];

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      {/* Hero Welcome Banner */}
      <PixelPanel variant="default" style={{ padding: 20, background: 'linear-gradient(135deg, var(--cth-cream-100) 0%, #FFFFFF 100%)', border: '1px solid var(--cth-ink-300)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 24 }}>🏢</span>
              <h1 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-900)' }}>
                WHAT ARE YOU WORKING ON?
              </h1>
            </div>
            <p style={{ margin: '6px 0 0 0', fontSize: 12, color: 'var(--cth-ink-600)', fontFamily: 'var(--cth-font-ui)' }}>
              Domain-specialized AI agent teams executing verified engineering milestones and goals.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <PixelButton variant="secondary" size="md" onClick={onImportProject}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Icon name="folder" /> Import Existing Project
              </span>
            </PixelButton>
            <PixelButton variant="primary" size="md" onClick={() => onNewProject()}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Icon name="plus" /> New Project
              </span>
            </PixelButton>
          </div>
        </div>
      </PixelPanel>

      {/* Domain Cards Selection */}
      <div>
        <div style={{ fontSize: 11, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-500)', marginBottom: 10 }}>
          SPECIALIZED DOMAINS
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
          {domainCards.map((dom) => (
            <PixelPanel
              key={dom.id}
              variant="default"
              style={{
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 12,
                background: '#fff',
                borderLeft: `4px solid ${dom.color}`
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{dom.icon}</span>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                    {dom.title}
                  </div>
                </div>
                <p style={{ margin: '8px 0 0 0', fontSize: 11, color: 'var(--cth-ink-600)', lineHeight: '16px' }}>
                  {dom.description}
                </p>

                <div style={{ marginTop: 10, fontSize: 9, color: 'var(--cth-ink-500)' }}>
                  <span style={{ fontWeight: 700 }}>ROSTER: </span>
                  {dom.roles.join(' • ')}
                </div>
              </div>

              <PixelButton variant="secondary" size="sm" onClick={() => onNewProject(dom.id)}>
                Start {dom.title} Project →
              </PixelButton>
            </PixelPanel>
          ))}
        </div>
      </div>

      {/* Recent Projects List */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 11, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-500)' }}>
            RECENT PROJECTS ({projects.length})
          </span>
        </div>

        {loading ? (
          <PixelPanel variant="default" style={{ padding: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>Loading projects...</div>
          </PixelPanel>
        ) : projects.length === 0 ? (
          <PixelPanel variant="default" style={{ padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-800)' }}>
              No projects created yet
            </div>
            <p style={{ margin: '6px 0 14px 0', fontSize: 11, color: 'var(--cth-ink-500)' }}>
              Create a new project or import a local codebase to begin verified execution.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
              <PixelButton variant="primary" size="md" onClick={() => onNewProject()}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="plus" /> New Project
                </span>
              </PixelButton>
              <PixelButton variant="secondary" size="md" onClick={onImportProject}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="folder" /> Import Folder
                </span>
              </PixelButton>
            </div>
          </PixelPanel>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {projects.map((proj) => (
              <PixelPanel
                key={proj.id}
                variant="default"
                style={{
                  padding: 14,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: '#fff'
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                      {proj.name}
                    </span>
                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: 'monospace',
                        padding: '2px 6px',
                        background: 'var(--cth-ink-100)',
                        color: 'var(--cth-ink-700)',
                        borderRadius: 2
                      }}
                    >
                      {proj.domainId}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--cth-ink-500)', marginTop: 4 }}>
                    Path: {proj.rootPath}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <PixelButton variant="primary" size="sm" onClick={() => onOpenProject(proj.id)}>
                    Open Command Center →
                  </PixelButton>
                </div>
              </PixelPanel>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
