import { useEffect, useState } from 'react';
import { useStore, selectedAgent } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { OfficeFloor } from '@/scene/office/OfficeFloor';
import { MemoryPanel } from '@/components/MemoryPanel';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { AgentStrip } from '@/components/AgentStrip';
import { MichaelBooting } from '@/components/MichaelBooting';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon as PixelIcon } from '@/components/Icon';
import { SidebarSplitter } from '@/components/SidebarSplitter';
import { Icon } from '../icons';

/** The legacy agents floor, hosted unchanged inside the Nexus shell. This is
 *  the one Nexus file allowed to use Pixel* components: it wraps the legacy
 *  view verbatim until the Agents view is redesigned. */
export function AgentsView({ config }: { config: HarnessConfig }) {
  const agent = useStore(selectedAgent);
  const agentCount = useStore((s) => s.agents.length);
  const godStatus = useStore((s) => s.godStatus);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const [vpWidth, setVpWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setVpWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleFullscreen = () => {
    const s = useStore.getState();
    if (fullscreenAgentId) { s.setFullscreen(null); return; }
    const target = s.agents.find((x) => x.id === s.selectedId && x.ptyId) ?? s.agents.find((x) => x.isGod && x.ptyId) ?? s.agents.find((x) => x.ptyId);
    if (target) s.setFullscreen(target.id);
  };

  return (
    <div className="nx-agents">
      <div className="nx-agents__bar">
        <h1 className="nx-agents__title">Agents</h1>
        <span className="nx-badge nx-badge--neutral">{config.autoMode ? 'Auto mode on' : 'Auto mode off'}</span>
        <button type="button" className="nx-iconbtn nx-focusable" onClick={toggleFullscreen} aria-label="Toggle fullscreen terminal" title="Fullscreen terminal (selected agent)">
          <Icon name="panel" />
        </button>
      </div>
      {/* moved verbatim from App.tsx: floor + splitter + detail sidebar */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex',
        padding: 16,
        gap: 0
      }}>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', display: 'flex' }}>
          <>
              <OfficeFloor />
              <MemoryPanel />
              {agentCount === 0 && godStatus === 'booting' && <MichaelBooting />}
              {agentCount === 0 && godStatus !== 'booting' && (
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  pointerEvents: 'none'
                }}>
                  <div style={{ pointerEvents: 'auto', width: 360 }}>
                    <PixelPanel variant="dialog" title="No agents yet" noPadding>
                      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <p style={{ margin: 0, fontSize: 13, lineHeight: '20px' }}>
                          No agents are running. Add one to see its terminal output here.
                        </p>
                        <PixelButton variant="primary" size="md" onClick={() => setAddAgentOpen(true)}>
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <PixelIcon name="plus" /> add agent
                          </span>
                        </PixelButton>
                      </div>
                    </PixelPanel>
                  </div>
                </div>
              )}
          </>
        </div>

        <SidebarSplitter
          width={sidebarWidth}
          onChange={setSidebarWidth}
          viewportWidth={vpWidth}
        />

        <div style={{
          width: sidebarWidth, flexShrink: 0,
          minHeight: 0, display: 'flex', flexDirection: 'column'
        }}>
          {agent ? (
            <AgentDetailPanel agent={agent} />
          ) : godStatus === 'booting' ? (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>STARTING</div>
              <p style={{ margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                The lead agent is starting.<br />
                Its terminal will appear here once it is ready.
              </p>
            </PixelPanel>
          ) : (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>NO AGENT SELECTED</div>
              <p style={{ margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                Add an agent from the strip below.<br />
                The terminal and command bar will land here.
              </p>
              <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <PixelIcon name="plus" /> add agent
                </span>
              </PixelButton>
            </PixelPanel>
          )}
        </div>
      </div>
      <AgentStrip config={config} />
    </div>
  );
}
