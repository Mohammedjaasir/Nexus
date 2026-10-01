import React, { useEffect, useRef, useState } from 'react';
import type { OfficeCharacterName } from '../scene/office/cast';
import { sceneFrameBufs, SCENE_W, SCENE_H } from '../scene/office/portraitArt';
import { useStore } from '../store/store';
import type { DomainId } from '@shared/domain';
import {
  DOMAIN_LAYOUTS,
  HQCharacterBehavior,
  type LiveAgentContext
} from './HQBehaviorEngine';

// ── Cache procedural sprite frames onto offscreen canvases ────────────────
interface CachedSpriteFrames {
  front: HTMLCanvasElement[];
  back: HTMLCanvasElement[];
}

const spriteCache = new Map<OfficeCharacterName, CachedSpriteFrames>();

export function getCachedSpriteFrames(charName: OfficeCharacterName): CachedSpriteFrames {
  let cached = spriteCache.get(charName);
  if (cached) return cached;

  const { front, back } = sceneFrameBufs(charName);

  const bufToCanvas = (buf: Uint8ClampedArray): HTMLCanvasElement => {
    const cvs = document.createElement('canvas');
    cvs.width = SCENE_W;
    cvs.height = SCENE_H;
    const ctx = cvs.getContext('2d')!;
    const imgData = ctx.createImageData(SCENE_W, SCENE_H);
    imgData.data.set(buf);
    ctx.putImageData(imgData, 0, 0);
    return cvs;
  };

  cached = {
    front: front.map(bufToCanvas),
    back: back.map(bufToCanvas)
  };
  spriteCache.set(charName, cached);
  return cached;
}

export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  char: HQCharacterBehavior
): void {
  const frames = getCachedSpriteFrames(char.layout.character);
  const isBack = char.facing === 'up';
  const frameList = isBack ? frames.back : frames.front;
  const frameCvs = frameList[char.animFrame] || frameList[0];

  ctx.save();
  const drawX = Math.round(char.x);
  const drawY = Math.round(char.y);

  if (char.facing === 'left') {
    ctx.translate(drawX, drawY);
    ctx.scale(-1, 1);
    ctx.drawImage(frameCvs, -Math.floor(SCENE_W / 2), -SCENE_H);
  } else {
    ctx.translate(drawX, drawY);
    ctx.drawImage(frameCvs, -Math.floor(SCENE_W / 2), -SCENE_H);
  }
  ctx.restore();
}

interface ActiveBubbleData {
  id: string;
  charName: string;
  xPct: number;
  yPct: number;
  text: string;
}

export function HQCharacterLayer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const agents = useStore((s) => s.agents);
  const projects = useStore((s) => s.projects);

  const behaviorsRef = useRef<HQCharacterBehavior[]>([]);
  const [activeBubbles, setActiveBubbles] = useState<ActiveBubbleData[]>([]);

  useEffect(() => {
    // Instantiate 12 domain character behaviors
    const domainIds = Object.keys(DOMAIN_LAYOUTS) as DomainId[];
    behaviorsRef.current = domainIds.map((domId, index) => {
      const layout = DOMAIN_LAYOUTS[domId];
      const behavior = new HQCharacterBehavior(layout);
      // Stagger initial timers
      behavior.stateTimer = (index % 4) * 3.0;
      return behavior;
    });
  }, []);

  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();
    let bubbleSyncTimer = 0;

    const renderLoop = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      bubbleSyncTimer += dt;

      const cvs = canvasRef.current;
      if (cvs) {
        const ctx = cvs.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, cvs.width, cvs.height);
          ctx.imageSmoothingEnabled = false;

          // Build live context map from Zustand store
          const liveContextMap = new Map<DomainId, LiveAgentContext>();

          for (const p of projects) {
            const agentForProject = agents.find(a => !a.isGod && !a.archived && a.project === p.id);
            if (agentForProject && p.domainId) {
              const isVerifying = agentForProject.action?.toLowerCase().includes('verif') ||
                                 agentForProject.action?.toLowerCase().includes('test');
              liveContextMap.set(p.domainId as DomainId, {
                character: agentForProject.character,
                status: agentForProject.status === 'working' ? 'working'
                  : agentForProject.status === 'thinking' ? 'thinking'
                  : agentForProject.status === 'blocked' ? 'blocked'
                  : agentForProject.status === 'success' ? 'success'
                  : 'idle',
                taskTitle: agentForProject.action,
                projectName: p.name,
                isVerifying
              });
            }
          }

          // Update & draw each character behavior
          const currentBubbles: ActiveBubbleData[] = [];

          for (const char of behaviorsRef.current) {
            const context = liveContextMap.get(char.layout.domainId);
            char.update(dt, context);
            drawCharacter(ctx, char);

            if (char.thoughtText) {
              currentBubbles.push({
                id: char.layout.domainId,
                charName: char.layout.displayName,
                xPct: (char.x / 1024) * 100,
                yPct: ((char.y - 34) / 655) * 100,
                text: char.thoughtText
              });
            }
          }

          // Sync high-resolution DOM bubbles at ~15 Hz
          if (bubbleSyncTimer >= 0.066) {
            bubbleSyncTimer = 0;
            // Limit to at most 3 simultaneous bubbles to avoid visual crowding
            setActiveBubbles(currentBubbles.slice(0, 3));
          }
        }
      }

      animId = requestAnimationFrame(renderLoop);
    };

    animId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(animId);
  }, [agents, projects]);

  return (
    <>
      {/* ── 60fps Character Sprite Layer ── */}
      <canvas
        ref={canvasRef}
        width={1024}
        height={655}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          imageRendering: 'pixelated',
          zIndex: 15
        }}
      />

      {/* ── Crisp Pixel-Art Character Speech & Activity Bubbles Overlay ── */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 35
        }}
      >
        {activeBubbles.map((b) => (
          <div
            key={b.id}
            style={{
              position: 'absolute',
              left: `${b.xPct}%`,
              top: `${b.yPct}%`,
              transform: 'translate(-50%, -100%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              maxWidth: 'clamp(100px, 14vw, 160px)',
              pointerEvents: 'none'
            }}
          >
            {/* Retro Pixel Speech Box — Cream fill, thin dark outline, crisp pixel font */}
            <div
              style={{
                background: '#FFFFFF',
                color: '#1E1B18',
                border: '1px solid #1E1B18',
                boxShadow: '1px 1px 0px rgba(30, 27, 24, 0.4)',
                borderRadius: '1px',
                padding: '2px 5px',
                fontSize: 'clamp(9px, 0.8vw, 11px)',
                fontWeight: 700,
                fontFamily: "'Courier New', 'Lucida Console', monospace",
                lineHeight: 1.2,
                textAlign: 'center',
                wordWrap: 'break-word',
                whiteSpace: 'normal',
                letterSpacing: '0.01em'
              }}
            >
              {b.text}
            </div>
            {/* Small Downward Pixel Pointer */}
            <div
              style={{
                width: 0,
                height: 0,
                borderLeft: '3px solid transparent',
                borderRight: '3px solid transparent',
                borderTop: '4px solid #1E1B18',
                marginTop: '-0.5px'
              }}
            />
          </div>
        ))}
      </div>

    </>
  );
}
