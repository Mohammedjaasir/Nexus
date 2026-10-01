import { useState } from 'react';
import type { DomainId } from '@shared/domain';
import { getDomainDefinition, listDomainDefinitions } from '@shared/domain';
import type { ProjectScanResult } from '@shared/project';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';
import { useStore } from '../store/store';

export interface ProjectImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportSuccess?: () => void;
}

export function ProjectImportModal({ isOpen, onClose, onImportSuccess }: ProjectImportModalProps) {
  const [folderPath, setFolderPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [selectedDomain, setSelectedDomain] = useState<DomainId>('software-engineering');
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [scanResult, setScanResult] = useState<ProjectScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setActiveProject = useStore((s) => s.setActiveProject);
  const setProjects = useStore((s) => s.setProjects);

  if (!isOpen) return null;

  const handleBrowseFolder = async () => {
    setError(null);
    try {
      const res = await window.cth.chooseFolder();
      if (res.ok && res.path) {
        setFolderPath(res.path);
        await triggerScan(res.path);
      } else if (!res.ok && res.error && res.error !== 'cancelled') {
        setError(res.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const triggerScan = async (path: string) => {
    if (!path.trim()) return;
    setScanning(true);
    setError(null);
    try {
      const res = await window.cth.projectScan(path.trim());
      if (res.ok && res.scanResult) {
        setScanResult(res.scanResult);
        setProjectName(res.scanResult.suggestedName);
        setSelectedDomain(res.scanResult.primaryDomain as DomainId);
      } else {
        setError(res.error ?? 'Failed to analyze project directory');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!folderPath.trim()) {
      setError('Please select a project folder.');
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await window.cth.projectImport(
        folderPath.trim(),
        selectedDomain,
        projectName.trim() || undefined
      );

      if (res.ok && res.project) {
        setActiveProject(res.project);
        const updatedList = await window.cth.projectList();
        setProjects(updatedList);
        onImportSuccess?.();
        onClose();
      } else {
        setError(res.error ?? 'Failed to import project.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const domainOptions = listDomainDefinitions();

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
        padding: 20
      }}
    >
      <div style={{ width: 620, maxWidth: '95vw' }}>
        <PixelPanel variant="dialog" noPadding>
          <div
            style={{
              padding: '10px 16px',
              background: 'var(--cth-cream-200)',
              borderBottom: '1.5px solid var(--cth-ink-900)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}
          >
            <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 12, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
              IMPORT EXISTING PROJECT
            </span>
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 16,
                lineHeight: 1,
                padding: '2px 6px',
                color: 'var(--cth-ink-700)'
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-700)' }}>
              Select a local repository or project folder. Munder Difflin will perform deterministic local analysis to detect its domain, languages, frameworks, and architecture.
            </p>

            {/* Folder Selection Row */}
            <div>
              <label
                style={{
                  display: 'block',
                  fontFamily: 'var(--cth-font-display)',
                  fontSize: 10,
                  color: 'var(--cth-ink-500)',
                  marginBottom: 4
                }}
              >
                PROJECT FOLDER PATH
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                  onBlur={() => folderPath.trim() && triggerScan(folderPath.trim())}
                  placeholder="e.g. C:\projects\my-app or /home/user/my-app"
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    fontFamily: 'var(--cth-font-ui)',
                    fontSize: 12,
                    background: 'var(--cth-cream-100)',
                    border: '1.5px solid var(--cth-ink-500)',
                    color: 'var(--cth-ink-900)'
                  }}
                />
                <PixelButton variant="secondary" onClick={handleBrowseFolder}>
                  Browse…
                </PixelButton>
              </div>
            </div>

            {/* Scanning Indicator */}
            {scanning && (
              <div
                style={{
                  padding: 12,
                  background: 'var(--cth-cream-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-lemon)',
                  fontSize: 12,
                  fontFamily: 'var(--cth-font-ui)',
                  color: 'var(--cth-ink-700)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8
                }}
              >
                <span>⏳ Running deterministic project analysis…</span>
              </div>
            )}

            {/* Analysis Preview Card */}
            {scanResult && !scanning && (
              <div
                style={{
                  padding: 14,
                  background: 'var(--cth-cream-100)',
                  boxShadow: 'inset 0 0 0 1.5px var(--cth-mint)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span
                    style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 10,
                      color: 'var(--cth-ink-500)'
                    }}
                  >
                    ANALYSIS PREVIEW
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 11,
                      fontWeight: 700,
                      color: 'var(--cth-mint-dark)'
                    }}
                  >
                    HEALTH: {scanResult.health.healthScore}%
                  </span>
                </div>

                {/* Name override */}
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 9,
                      color: 'var(--cth-ink-500)',
                      marginBottom: 2
                    }}
                  >
                    PROJECT NAME
                  </label>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '6px 8px',
                      fontFamily: 'var(--cth-font-ui)',
                      fontSize: 12,
                      background: 'var(--cth-cream-50)',
                      border: '1px solid var(--cth-ink-300)',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                {/* Domain Selector */}
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 9,
                      color: 'var(--cth-ink-500)',
                      marginBottom: 4
                    }}
                  >
                    PRIMARY DOMAIN (AUTO-DETECTED: {getDomainDefinition(scanResult.primaryDomain).name})
                  </label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {domainOptions.map((dom) => {
                      const isSelected = selectedDomain === dom.id;
                      return (
                        <button
                          key={dom.id}
                          type="button"
                          onClick={() => setSelectedDomain(dom.id)}
                          style={{
                            padding: '6px 10px',
                            background: isSelected ? 'var(--cth-mint-light)' : 'var(--cth-cream-200)',
                            boxShadow: isSelected
                              ? 'inset 0 0 0 2px var(--cth-mint)'
                              : 'inset 0 0 0 1px var(--cth-ink-200)',
                            border: 'none',
                            fontFamily: 'var(--cth-font-ui)',
                            fontSize: 11,
                            fontWeight: isSelected ? 700 : 400,
                            cursor: 'pointer'
                          }}
                        >
                          {isSelected ? '✓ ' : ''}{dom.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Detected Details Chips */}
                <div style={{ fontSize: 11, color: 'var(--cth-ink-700)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <span>🔤 Languages: {scanResult.languages.map((l) => l.language).join(', ') || 'None'}</span>
                  {scanResult.frameworks.length > 0 && (
                    <span>• 📦 Frameworks: {scanResult.frameworks.join(', ')}</span>
                  )}
                  <span>• 🧪 Tests: {scanResult.testSuites.length > 0 ? 'Detected' : 'None'}</span>
                  {scanResult.gitInfo?.isRepo && (
                    <span>• 🌿 Branch: {scanResult.gitInfo.branch ?? 'HEAD'}</span>
                  )}
                </div>
              </div>
            )}

            {/* Error Banner */}
            {error && (
              <div
                style={{
                  padding: 10,
                  background: 'var(--cth-coral-light)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                  fontSize: 12,
                  color: 'var(--cth-coral-dark)'
                }}
              >
                {error}
              </div>
            )}

            {/* Actions */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                paddingTop: 8,
                borderTop: '1px solid var(--cth-ink-100)'
              }}
            >
              <PixelButton variant="secondary" onClick={onClose}>
                Cancel
              </PixelButton>
              <PixelButton
                variant="primary"
                onClick={handleConfirmImport}
                disabled={!folderPath.trim() || scanning || importing}
              >
                {importing ? 'Importing…' : 'Confirm & Import Project →'}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
