import { useEffect, useState } from 'react';
import type { DomainId } from '@shared/domain';
import { getDomainDefinition } from '@shared/domain';
import { useStore } from '../store/store';
import { DepartmentDetailModal } from './DepartmentDetailModal';
import { HQCharacterLayer } from './HQCharacterLayer';
import hqCampusImage from '@/assets/hq-campus-clean.png?url';

export interface HQWorldViewProps {
  onOpenProject: (projectId: string) => void;
  onNewProject: (domainId?: DomainId) => void;
  onImportProject: (domainId?: DomainId) => void;
  onSwitchToFloor: () => void;
}

interface RoomHotspot {
  domainId: DomainId;
  name: string;
  topPct: number;
  leftPct: number;
  widthPct: number;
  heightPct: number;
  accentColor: string;
  leadCharacter: string;
}

// ── 12 Departments — ONE authoritative list, zero duplicates ──
const ROOM_HOTSPOTS: RoomHotspot[] = [
  // ROW 1
  { domainId: 'software-engineering', name: 'Software Engineering',     topPct: 9.5,  leftPct: 2.0,  widthPct: 28.0, heightPct: 18.5, accentColor: '#2563EB', leadCharacter: 'jim' },
  { domainId: 'ai-ml',               name: 'AI / Machine Learning Lab', topPct: 9.5,  leftPct: 31.0, widthPct: 32.5, heightPct: 18.5, accentColor: '#7C3AED', leadCharacter: 'ryan' },
  { domainId: 'cybersecurity',       name: 'Cybersecurity Ops',         topPct: 9.5,  leftPct: 64.5, widthPct: 33.5, heightPct: 18.5, accentColor: '#DC2626', leadCharacter: 'creed' },
  // ROW 2
  { domainId: 'computer-vision',     name: 'Computer Vision Lab',       topPct: 34.5, leftPct: 8.5,  widthPct: 16.5, heightPct: 16.0, accentColor: '#0D9488', leadCharacter: 'pam' },
  { domainId: 'data-science',        name: 'Data Science Lab',          topPct: 34.5, leftPct: 26.0, widthPct: 18.0, heightPct: 16.0, accentColor: '#1E40AF', leadCharacter: 'oscar' },
  { domainId: 'data-analytics',      name: 'Data Analytics Room',       topPct: 34.5, leftPct: 45.0, widthPct: 23.5, heightPct: 16.0, accentColor: '#D97706', leadCharacter: 'kevin' },
  { domainId: 'devops-cloud',        name: 'DevOps / Cloud Room',       topPct: 34.5, leftPct: 69.5, widthPct: 27.0, heightPct: 16.0, accentColor: '#1D4ED8', leadCharacter: 'stanley' },
  // ROW 3
  { domainId: 'web-app-dev',         name: 'Web & App Dev Studio',      topPct: 54.0, leftPct: 8.5,  widthPct: 15.0, heightPct: 17.0, accentColor: '#BE185D', leadCharacter: 'jim' },
  { domainId: 'mobile-dev',          name: 'Mobile Dev Lab',            topPct: 54.0, leftPct: 24.5, widthPct: 15.0, heightPct: 17.0, accentColor: '#15803D', leadCharacter: 'andy' },
  { domainId: 'robotics-iot',        name: 'Robotics / IoT Workshop',   topPct: 54.0, leftPct: 40.5, widthPct: 16.0, heightPct: 17.0, accentColor: '#B91C1C', leadCharacter: 'dwight' },
  { domainId: 'game-dev',            name: 'Game Development Studio',   topPct: 54.0, leftPct: 57.5, widthPct: 15.5, heightPct: 17.0, accentColor: '#4C1D95', leadCharacter: 'jim' },
  { domainId: 'research-scientific', name: 'Research Lab / Scientific', topPct: 54.0, leftPct: 74.0, widthPct: 22.5, heightPct: 17.0, accentColor: '#1E3A8A', leadCharacter: 'michael' },
];

const LABEL_CSS = `
  .cth-hq-img {
    image-rendering: -webkit-optimize-contrast;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    -ms-interpolation-mode: nearest-neighbor;
    transform: translateZ(0);
  }
  @keyframes cthRoomPulse {
    0%, 100% { box-shadow: 0 0 10px rgba(37,99,235,0.5); }
    50%       { box-shadow: 0 0 18px rgba(37,99,235,0.9); }
  }
  .cth-room-hover { animation: cthRoomPulse 1.2s ease-in-out infinite; }

  /* ── Crisp DOM text layer — NOT inside the canvas ── */
  .cth-dept-label {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 2px 4px 3px 4px;
    background: linear-gradient(to top, rgba(0,0,0,0.70) 0%, rgba(0,0,0,0.0) 100%);
  }
  /* LEVEL 2 — Active mission title (medium) */
  .cth-dept-label-mission {
    font-family: 'Courier New', 'Lucida Console', monospace;
    font-weight: 600;
    font-size: clamp(5px, 0.85vw, 9px);
    color: #D1FAE5;
    text-shadow: 1px 1px 0 #000;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
    margin-top: 1px;
  }
  /* LEVEL 3 — Agent/percentage (smallest) */
  .cth-dept-label-agent {
    font-family: 'Courier New', 'Lucida Console', monospace;
    font-size: clamp(5px, 0.8vw, 8px);
    font-weight: 700;
    color: #FDE68A;
    text-shadow: 1px 1px 0 #000;
    margin-top: 1px;
  }
`;

export function HQWorldView({
  onOpenProject,
  onNewProject,
  onImportProject,
  onSwitchToFloor,
}: HQWorldViewProps) {
  const projects  = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);
  const agents    = useStore((s) => s.agents);
  const [selectedDepartment, setSelectedDepartment] = useState<DomainId | null>(null);
  const [hoveredRoom,        setHoveredRoom]         = useState<DomainId | null>(null);

  useEffect(() => {
    window.cth?.projectList?.().then((list) => { if (list) setProjects(list); });
  }, [setProjects]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'm' || e.key === 'M') {
        if (projects[0]) onOpenProject(projects[0].id); else onNewProject();
      } else if (e.key === 'o' || e.key === 'O') { onSwitchToFloor(); }
        else if (e.key === 'p' || e.key === 'P') { onNewProject(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [projects, onOpenProject, onSwitchToFloor, onNewProject]);

  return (
    <div
      style={{
        flex: 1, width: '100%', height: '100%', minHeight: 0, maxHeight: '100%',
        overflow: 'hidden', background: '#EAE5D9',
        padding: 0, margin: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxSizing: 'border-box', userSelect: 'none',
      }}
    >
      <style>{LABEL_CSS}</style>

      {/* ── Aspect-ratio container (1024 × 655) ── */}
      <div
        style={{
          position: 'relative',
          maxHeight: '100%', maxWidth: '100%',
          aspectRatio: '1024 / 655',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {/* ── Pixel-art base (one authoritative clean PNG, zero duplicates) ── */}
        <img
          src={hqCampusImage}
          alt="Munder Difflin HQ"
          className="cth-hq-img"
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />

        {/* ── Dynamic 60fps Animated NPC Layer ── */}
        <HQCharacterLayer />

        {/* ── 12 × Department hotspot + crisp text label (each rendered ONCE) ── */}
        {ROOM_HOTSPOTS.map((room) => {
          const isHovered    = hoveredRoom === room.domainId;
          const deptProjects = projects.filter((p) => p.domainId === room.domainId);
          const domDef       = getDomainDefinition(room.domainId);
          const activeProject = deptProjects[0];
          // Agent active in this department
          const deptAgent = agents.find(
            (a) => !a.isGod && !a.archived && deptProjects.some((p) => p.id === a.project),
          );
          const statusLabel =
            deptAgent?.status === 'working'   ? 'WORKING' :
            deptAgent?.status === 'thinking'  ? 'THINKING' :
            deptAgent?.status === 'blocked'   ? 'BLOCKED!' :
            deptAgent?.status === 'idle'      ? 'STANDBY'  : null;

          return (
            <div
              key={room.domainId}
              onClick={() => setSelectedDepartment(room.domainId)}
              onMouseEnter={() => setHoveredRoom(room.domainId)}
              onMouseLeave={() => setHoveredRoom(null)}
              title={`${room.name} — ${deptProjects.length} project${deptProjects.length !== 1 ? 's' : ''} — Click to enter`}
              className={isHovered ? 'cth-room-hover' : ''}
              style={{
                position: 'absolute',
                top:    `${room.topPct}%`,
                left:   `${room.leftPct}%`,
                width:  `${room.widthPct}%`,
                height: `${room.heightPct}%`,
                cursor: 'pointer',
                border: isHovered ? `2.5px solid ${room.accentColor}` : '2px solid transparent',
                backgroundColor: isHovered ? 'rgba(255,255,255,0.12)' : 'transparent',
                transition: 'all 0.12s ease',
                zIndex: isHovered ? 25 : 10,
              }}
            >
              {/* ── Crisp DOM text — mission + agent status only (no duplicate dept name) ── */}
              <div className="cth-dept-label">
                {/* LEVEL 2 — Active mission title */}
                {activeProject && (
                  <div className="cth-dept-label-mission" title={activeProject.name}>
                    {activeProject.name.length > 24
                      ? activeProject.name.slice(0, 22) + '…'
                      : activeProject.name}
                    {activeProject.health?.healthScore != null && activeProject.health.healthScore > 0
                      ? ` · ${Math.round(activeProject.health.healthScore)}%` : ''}
                  </div>
                )}

                {/* LEVEL 3 — Active agent + status */}
                {statusLabel && deptAgent && (
                  <div className="cth-dept-label-agent">
                    @{deptAgent.name.split(' ')[0].toLowerCase()} · {statusLabel}
                  </div>
                )}
              </div>

              {/* Hover detail tooltip */}
              {isHovered && (
                <div
                  style={{
                    position: 'absolute', top: 4, right: 4,
                    background: '#111827', color: '#F9FAFB',
                    border: `1.5px solid ${room.accentColor}`,
                    boxShadow: '2px 2px 0 #000',
                    padding: '3px 7px',
                    display: 'flex', flexDirection: 'column', gap: 1,
                    pointerEvents: 'none', borderRadius: 2,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span style={{ fontSize: 10 }}>{domDef?.icon || '🏢'}</span>
                    <span style={{ fontSize: 9, fontWeight: 900, fontFamily: 'monospace', color: '#FFF' }}>
                      {room.name.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontSize: 7, fontFamily: 'monospace', color: '#9CA3AF' }}>
                    @{room.leadCharacter} · {deptProjects.length} project{deptProjects.length !== 1 ? 's' : ''} · Click to enter
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* ── HUD hotspots (invisible click targets) ── */}
        <div onClick={() => onNewProject()} title="New project"
          style={{ position: 'absolute', top: '1.5%', left: '6.5%', width: '6.5%', height: '6.5%', cursor: 'pointer', zIndex: 20 }} />
        <div onClick={() => { if (projects[0]) onOpenProject(projects[0].id); else onNewProject(); }}
          title="View active missions"
          style={{ position: 'absolute', top: '1.5%', left: '14.5%', width: '6.5%', height: '6.5%', cursor: 'pointer', zIndex: 20 }} />

        {/* ── Amenities hotspots ── */}
        <div onClick={() => onNewProject()} title="Reception: create new project"
          style={{ position: 'absolute', top: '76.0%', left: '8.0%', width: '10.5%', height: '14.0%', cursor: 'pointer', zIndex: 20 }} />
        <div onClick={() => { if (projects[0]) onOpenProject(projects[0].id); else onNewProject(); }}
          title="Mission Board: view active missions"
          style={{ position: 'absolute', top: '76.0%', left: '56.0%', width: '13.0%', height: '14.0%', cursor: 'pointer', zIndex: 20 }} />
        <div onClick={() => onSwitchToFloor()} title="Switch to animated Office Floor"
          style={{ position: 'absolute', top: '76.0%', left: '82.5%', width: '14.0%', height: '18.0%', cursor: 'pointer', zIndex: 20 }} />
      </div>

      {/* ── Department detail modal ── */}
      {selectedDepartment && (
        <DepartmentDetailModal
          domainId={selectedDepartment}
          onClose={() => setSelectedDepartment(null)}
          onOpenProject={(id) => { setSelectedDepartment(null); onOpenProject(id); }}
          onNewProject={(dom) => { setSelectedDepartment(null); onNewProject(dom); }}
          onImportProject={(dom) => { setSelectedDepartment(null); onImportProject(dom); }}
        />
      )}
    </div>
  );
}
