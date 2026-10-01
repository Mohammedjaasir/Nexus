'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Pure Simulation Logic for Testing Movement State Machine ──

function createTestNPC(config = {}) {
  const homeDesk = config.homeDesk || { name: 'AI Workstation', x: 494, y: 145, facing: 'down' };
  const waypoints = config.waypoints || [
    { name: 'AI Lab Corridor', x: 494, y: 195, facing: 'down', waitSec: 2.0, thought: 'Optimizing weights' }
  ];

  return {
    config: {
      id: config.id || 'ryan-ai',
      character: config.character || 'ryan',
      displayName: config.displayName || 'Ryan',
      domainId: config.domainId || 'ai-ml',
      homeDesk,
      waypoints,
      speed: config.speed || 50
    },
    state: 'desk',
    x: homeDesk.x,
    y: homeDesk.y,
    targetX: homeDesk.x,
    targetY: homeDesk.y,
    facing: homeDesk.facing || 'down',
    currentWaypoint: null,
    idleTimer: 0,
    idleDuration: config.idleDuration || 3.0,
    animTimer: 0,
    animFrame: 0,
    thoughtText: null,
    thoughtTimer: 0
  };
}

function updateTestNPC(npc, dt, isTaskBusy = false) {
  if (isTaskBusy) {
    if (npc.state !== 'desk') {
      npc.targetX = npc.config.homeDesk.x;
      npc.targetY = npc.config.homeDesk.y;
      npc.state = 'walking_to_desk';
    }
  }

  if (npc.thoughtText) {
    npc.thoughtTimer -= dt;
    if (npc.thoughtTimer <= 0) {
      npc.thoughtText = null;
    }
  }

  const speed = npc.config.speed || 50;

  switch (npc.state) {
    case 'desk': {
      npc.facing = npc.config.homeDesk.facing || 'down';
      npc.animFrame = 0;
      npc.idleTimer += dt;

      if (isTaskBusy) return;

      if (npc.idleTimer >= npc.idleDuration) {
        npc.idleTimer = 0;
        const wps = npc.config.waypoints;
        if (wps.length > 0) {
          const chosen = wps[0];
          npc.currentWaypoint = chosen;
          npc.targetX = chosen.x;
          npc.targetY = chosen.y;
          npc.state = 'walking_to_dest';
        }
      }
      break;
    }

    case 'walking_to_dest':
    case 'walking_to_desk': {
      const dx = npc.targetX - npc.x;
      const dy = npc.targetY - npc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = Math.min(speed * dt, dist);

      if (dist <= step || dist < 1.5) {
        npc.x = npc.targetX;
        npc.y = npc.targetY;

        if (npc.state === 'walking_to_dest') {
          npc.state = 'waiting_at_dest';
          npc.idleTimer = 0;
          npc.idleDuration = npc.currentWaypoint?.waitSec || 2.0;
          if (npc.currentWaypoint?.facing) {
            npc.facing = npc.currentWaypoint.facing;
          }
          if (npc.currentWaypoint?.thought) {
            npc.thoughtText = npc.currentWaypoint.thought;
            npc.thoughtTimer = 2.0;
          }
        } else {
          npc.state = 'desk';
          npc.idleTimer = 0;
          npc.idleDuration = 3.0;
          npc.facing = npc.config.homeDesk.facing || 'down';
        }
        npc.animFrame = 0;
        return;
      }

      npc.x += (dx / dist) * step;
      npc.y += (dy / dist) * step;

      if (Math.abs(dx) > Math.abs(dy)) {
        npc.facing = dx > 0 ? 'right' : 'left';
      } else {
        npc.facing = dy > 0 ? 'down' : 'up';
      }

      npc.animTimer += dt;
      const animSpeed = 0.14;
      const frameIndex = Math.floor(npc.animTimer / animSpeed) % 4;
      npc.animFrame = frameIndex === 0 ? 0 : frameIndex === 1 ? 1 : frameIndex === 2 ? 0 : 2;
      break;
    }


    case 'waiting_at_dest': {
      npc.animFrame = 0;
      npc.idleTimer += dt;
      if (npc.idleTimer >= npc.idleDuration) {
        npc.idleTimer = 0;
        npc.targetX = npc.config.homeDesk.x;
        npc.targetY = npc.config.homeDesk.y;
        npc.state = 'walking_to_desk';
      }
      break;
    }
  }
}

// ── Tests ──

test('HQ NPC Movement: 1. NPC receives destination when idle time elapses', () => {
  const npc = createTestNPC({ idleDuration: 1.0 });
  assert.equal(npc.state, 'desk');
  assert.equal(npc.x, 494);
  assert.equal(npc.y, 145);

  // Advance time past idle threshold
  updateTestNPC(npc, 1.1, false);

  assert.equal(npc.state, 'walking_to_dest');
  assert.equal(npc.targetX, 494);
  assert.equal(npc.targetY, 195);
  assert.ok(npc.currentWaypoint !== null);
});

test('HQ NPC Movement: 2. NPC position changes continuously over time without teleporting', () => {
  const npc = createTestNPC({ idleDuration: 0.1, speed: 50 });
  updateTestNPC(npc, 0.2, false); // Trigger walk to (494, 195)

  assert.equal(npc.state, 'walking_to_dest');
  const initialY = npc.y;

  // Advance 0.5s at 50px/s => ~25px moved
  updateTestNPC(npc, 0.5, false);

  assert.ok(npc.y > initialY, 'Y coordinate should advance toward destination');
  assert.ok(npc.y < 195, 'Y should not snap or teleport instantly to destination');
  assert.equal(npc.x, 494, 'X should remain constant during straight vertical walk');
});

test('HQ NPC Movement: 3. NPC reaches target waypoint smoothly and transitions to waiting', () => {
  const npc = createTestNPC({ idleDuration: 0.1, speed: 50 });
  updateTestNPC(npc, 0.2, false); // Trigger walk (distance = 50px)

  // 50px / 50px/s = 1.0s to arrive. Advance 1.2s
  updateTestNPC(npc, 1.2, false);

  assert.equal(npc.state, 'waiting_at_dest');
  assert.equal(npc.x, 494);
  assert.equal(npc.y, 195);
  assert.equal(npc.animFrame, 0, 'Should stop walking animation on arrival');
});

test('HQ NPC Movement: 4. Complete lifecycle: Desk -> Walk -> Destination -> Wait -> Return -> Desk', () => {
  const npc = createTestNPC({ idleDuration: 0.5, speed: 100 });

  // 1. Idle at desk
  assert.equal(npc.state, 'desk');

  // 2. Trigger walk to dest (50px distance => 0.5s at 100px/s)
  updateTestNPC(npc, 0.6, false);
  assert.equal(npc.state, 'walking_to_dest');

  // 3. Arrive at destination
  updateTestNPC(npc, 0.6, false);
  assert.equal(npc.state, 'waiting_at_dest');

  // 4. Wait at destination (waitSec = 2.0s)
  updateTestNPC(npc, 2.1, false);
  assert.equal(npc.state, 'walking_to_desk');

  // 5. Walk back to desk (50px distance => 0.5s)
  updateTestNPC(npc, 0.6, false);
  assert.equal(npc.state, 'desk');
  assert.equal(npc.x, 494);
  assert.equal(npc.y, 145);
});

test('HQ NPC Movement: 5. Walking animation cycles through frames during motion', () => {
  const npc = createTestNPC({ idleDuration: 0.1, speed: 10 });
  updateTestNPC(npc, 0.2, false); // Walk started

  assert.equal(npc.state, 'walking_to_dest');

  const framesSeen = new Set();
  for (let i = 0; i < 10; i++) {
    updateTestNPC(npc, 0.08, false);
    framesSeen.add(npc.animFrame);
  }

  assert.ok(framesSeen.size > 1, 'Should alternate walk animation frames while moving');
});

test('HQ NPC Movement: 6. Real task status (working/thinking/blocked) overrides and forces agent to desk', () => {
  const npc = createTestNPC({ idleDuration: 0.1, speed: 100 });
  updateTestNPC(npc, 0.2, false); // Idle timer triggers walk to dest
  updateTestNPC(npc, 0.2, false); // Physically walks 20px away (y: 165)

  assert.equal(npc.state, 'walking_to_dest');
  assert.ok(npc.y > 145);

  // Real task starts!
  updateTestNPC(npc, 0.05, true);

  assert.equal(npc.state, 'walking_to_desk', 'Must immediately redirect back to desk');
  assert.equal(npc.targetX, 494);
  assert.equal(npc.targetY, 145);


  // Arrive back at desk
  updateTestNPC(npc, 1.0, true);
  assert.equal(npc.state, 'desk');

  // While busy, subsequent ticks must NEVER trigger wandering
  updateTestNPC(npc, 10.0, true);
  assert.equal(npc.state, 'desk', 'Must remain at desk while task is busy');
});


test('HQ NPC Movement: 7. Completed task allows agent to resume ambient movement', () => {
  const npc = createTestNPC({ idleDuration: 0.5, speed: 100 });

  // Task was busy
  updateTestNPC(npc, 1.0, true);
  assert.equal(npc.state, 'desk');

  // Task completes => isTaskBusy = false
  updateTestNPC(npc, 0.6, false);
  assert.equal(npc.state, 'walking_to_dest', 'Should resume ambient roaming after task completion');
});
