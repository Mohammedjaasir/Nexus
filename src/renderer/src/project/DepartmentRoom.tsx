import { useState } from 'react';
import type { DomainDefinition } from '@shared/domain';
import type { Project } from '@shared/project';
import { getDepartmentVisual } from './DepartmentProps';

export interface DepartmentRoomProps {
  domain: DomainDefinition;
  projects: Project[];
  plan?: any;
  onEnter: () => void;
}

export function DepartmentRoom({ domain, projects, plan, onEnter }: DepartmentRoomProps) {
  const [hovered, setHovered] = useState(false);
  const visual = getDepartmentVisual(domain.id);

  const missionCount = projects.length;
  const completedTasks = plan?.tasks?.filter((t: any) => t.status === 'completed')?.length ?? 0;
  const totalTasks = plan?.tasks?.length ?? 1;
  const progressPct = missionCount > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // Determine real activity status
  const isWorking = plan?.tasks?.some((t: any) => t.status === 'in_progress');
  const isVerifying = plan?.tasks?.some((t: any) => t.status === 'verifying');
  const isBlocked = plan?.tasks?.some((t: any) => t.status === 'blocked');

  const statusLabel = isVerifying
    ? '⚡ VERIFYING'
    : isWorking
    ? '● WORKING'
    : isBlocked
    ? '⚠️ BLOCKED'
    : missionCount > 0
    ? `🎯 ${missionCount} ${missionCount === 1 ? 'MISSION' : 'MISSIONS'}`
    : 'IDLE';

  const statusBg = isVerifying
    ? '#FFB300'
    : isWorking
    ? 'var(--cth-mint-dark, #2E7D32)'
    : isBlocked
    ? '#D32F2F'
    : missionCount > 0
    ? domain.badgeColor
    : 'var(--cth-ink-300)';

  return (
    <div
      onClick={onEnter}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: '#fff',
        border: '3px solid var(--cth-ink-900)',
        boxShadow: hovered ? '6px 6px 0px var(--cth-ink-900)' : '3px 3px 0px var(--cth-ink-900)',
        transform: hovered ? 'translate(-2px, -2px)' : 'none',
        transition: 'all 0.12s cubic-bezier(0.2, 0, 0, 1)',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      {/* ── Room Signboard (Header) ── */}
      <div
        style={{
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '2px solid var(--cth-ink-900)',
          padding: '8px 12px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              fontSize: 9,
              fontFamily: 'monospace',
              fontWeight: 800,
              padding: '1px 5px',
              background: 'var(--cth-ink-900)',
              color: '#fff',
              borderRadius: 1
            }}
          >
            {visual.signCode}
          </span>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--cth-ink-900)' }}>
            {domain.name.toUpperCase()}
          </span>
        </div>

        <span
          style={{
            fontSize: 8,
            fontFamily: 'monospace',
            fontWeight: 800,
            padding: '2px 6px',
            background: statusBg,
            color: '#fff',
            borderRadius: 2
          }}
        >
          {statusLabel}
        </span>
      </div>

      {/* ── Room Floor Simulation Area ── */}
      <div
        style={{
          padding: 12,
          background: visual.floorColor,
          backgroundImage: `
            linear-gradient(to right, rgba(0,0,0,0.04) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(0,0,0,0.04) 1px, transparent 1px)
          `,
          backgroundSize: '16px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          minHeight: 140,
          justifyContent: 'space-between'
        }}
      >
        {/* Department Props / Stations Bay */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {visual.props.map((p) => (
              <div
                key={p.name}
                title={p.name}
                style={{
                  background: '#fff',
                  border: '1px solid var(--cth-ink-900)',
                  boxShadow: '1px 1px 0px var(--cth-ink-900)',
                  padding: '2px 6px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 10
                }}
              >
                <span style={{ fontSize: 13 }}>{p.icon}</span>
                <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'var(--cth-ink-700)', fontWeight: 600 }}>
                  {p.name}
                </span>
              </div>
            ))}
          </div>

          <span style={{ fontSize: 24 }}>{domain.icon}</span>
        </div>

        {/* Lead Specialist Character Badge & Quote */}
        <div
          style={{
            background: 'rgba(255, 255, 255, 0.92)',
            border: '1.5px solid var(--cth-ink-900)',
            padding: '6px 8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: domain.badgeColor,
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 900,
                fontSize: 11,
                border: '1px solid var(--cth-ink-900)'
              }}
            >
              {domain.leadCharacter[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--cth-ink-900)' }}>
                @{domain.leadCharacter}
              </div>
              <div style={{ fontSize: 8, color: 'var(--cth-ink-500)', fontFamily: 'monospace' }}>
                Lead Specialist • {domain.agentRoles.length} agents
              </div>
            </div>
          </div>

          <span
            style={{
              fontSize: 9,
              fontWeight: 800,
              color: domain.badgeColor,
              fontFamily: 'monospace'
            }}
          >
            {hovered ? 'ENTER ➔' : 'OPEN'}
          </span>
        </div>

        {/* Active Mission Quest Bar (if exists) */}
        {missionCount > 0 ? (
          <div
            style={{
              background: '#fff',
              border: '1px solid var(--cth-ink-900)',
              padding: '4px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 3
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, fontFamily: 'monospace', fontWeight: 700 }}>
              <span style={{ color: 'var(--cth-ink-800)' }}>ACTIVE: {projects[0].name}</span>
              <span style={{ color: domain.badgeColor }}>{progressPct}%</span>
            </div>
            <div
              style={{
                width: '100%',
                height: 6,
                background: 'var(--cth-ink-100)',
                border: '1px solid var(--cth-ink-900)',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  width: `${progressPct}%`,
                  height: '100%',
                  background: domain.badgeColor
                }}
              />
            </div>
          </div>
        ) : hovered ? (
          <div
            style={{
              fontSize: 9,
              color: 'var(--cth-ink-600)',
              fontStyle: 'italic',
              background: 'rgba(255,255,255,0.7)',
              padding: '3px 6px',
              border: '1px dashed var(--cth-ink-300)'
            }}
          >
            "{visual.leadQuote}"
          </div>
        ) : null}
      </div>
    </div>
  );
}
