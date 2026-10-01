'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  HQCharacterBehavior,
  DOMAIN_LAYOUTS,
  COMMON_STATIONS,
  SOCIAL_DIALOGUES
} = loadTs('src/renderer/src/project/HQBehaviorEngine.ts');

// ── Test Helper: Deterministic PRNG ──
function createLcgRng(seed = 123456789) {
  let s = seed;
  return function lcg() {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

test('HQ Behavior Engine: 1. Role-specific destination selection', () => {
  const ryanLayout = DOMAIN_LAYOUTS['ai-ml'];
  assert.equal(ryanLayout.character, 'ryan');
  assert.equal(ryanLayout.primaryWorkstation.name, 'ML Model Workstation');
  assert.equal(ryanLayout.primaryWorkstation.x, 494);
  assert.equal(ryanLayout.primaryWorkstation.y, 145);

  const ryan = new HQCharacterBehavior(ryanLayout);
  assert.equal(ryan.currentStation.id, 'ai_desk');
  assert.equal(ryan.state, 'working');

  const jimLayout = DOMAIN_LAYOUTS['software-engineering'];
  assert.equal(jimLayout.character, 'jim');
  assert.equal(jimLayout.primaryWorkstation.name, 'SWE Coding Workstation');
  assert.equal(jimLayout.primaryWorkstation.x, 215);

  const jim = new HQCharacterBehavior(jimLayout);
  assert.equal(jim.currentStation.id, 'swe_desk');
});

test('HQ Behavior Engine: 2. Domain-specific activities and stations exist for all 12 domains', () => {
  const domainIds = [
    'software-engineering', 'ai-ml', 'cybersecurity', 'computer-vision',
    'data-science', 'data-analytics', 'devops-cloud', 'web-app-dev',
    'mobile-dev', 'robotics-iot', 'game-dev', 'research-scientific'
  ];

  for (const domId of domainIds) {
    const layout = DOMAIN_LAYOUTS[domId];
    assert.ok(layout, `Layout must exist for domain ${domId}`);
    assert.ok(layout.primaryWorkstation.activities.length > 0, `${domId} primary workstation must have activities`);
    assert.ok(layout.primaryWorkstation.contextualThoughts.length > 0, `${domId} primary workstation must have thoughts`);
    assert.ok(layout.verificationStation, `${domId} must have a verification station`);
    assert.ok(layout.secondaryStations.length > 0, `${domId} must have secondary stations`);
  }
});

test('HQ Behavior Engine: 3. Active-task override keeps agent focused on workstation & related domain hardware', () => {
  const ryanLayout = DOMAIN_LAYOUTS['ai-ml'];
  const rng = createLcgRng(42);
  const ryan = new HQCharacterBehavior(ryanLayout, rng);

  // Agent is actively working on real task
  const liveContext = {
    character: 'ryan',
    status: 'working',
    taskTitle: 'Train fraud detection model',
    projectName: 'Fraud Detector'
  };

  // Run for 30 seconds
  for (let i = 0; i < 30; i++) {
    ryan.update(1.0, liveContext);
  }

  // Must only visit AI desk or AI secondary stations (GPU cluster / experiment board), NEVER generic coffee
  const validAiStationIds = [
    ryanLayout.primaryWorkstation.id,
    ...ryanLayout.secondaryStations.map(s => s.id)
  ];
  assert.ok(
    validAiStationIds.includes(ryan.currentStation.id) || validAiStationIds.includes(ryan.targetStation.id),
    `Working agent must stay at domain stations, was at: ${ryan.currentStation.id}`
  );
});

test('HQ Behavior Engine: 4. Verification override navigates to domain verification station', () => {
  const creedLayout = DOMAIN_LAYOUTS['cybersecurity'];
  const creed = new HQCharacterBehavior(creedLayout);

  const liveContext = {
    character: 'creed',
    status: 'working',
    isVerifying: true,
    taskTitle: 'Verify firewall compliance'
  };

  // Trigger activity selection under verifying context
  creed.selectNextActivity(liveContext);

  assert.equal(creed.state, 'walking_to_station');
  assert.equal(creed.targetStation.id, creedLayout.verificationStation.id);

  // Arrive at verification station
  for (let i = 0; i < 10; i++) {
    creed.update(1.0, liveContext);
  }

  assert.equal(creed.state, 'verifying');
  assert.equal(creed.currentStation.id, creedLayout.verificationStation.id);
});

test('HQ Behavior Engine: 5. Task completion triggers celebration and returns to ambient', () => {
  const dwightLayout = DOMAIN_LAYOUTS['robotics-iot'];
  const dwight = new HQCharacterBehavior(dwightLayout);

  const completedContext = {
    character: 'dwight',
    status: 'success',
    taskTitle: 'Robotic arm calibration complete'
  };

  dwight.selectNextActivity(completedContext);
  assert.equal(dwight.state, 'celebrating');
  assert.ok(dwight.thoughtText.includes('done') || dwight.thoughtText.includes('Task completed'));

  // After celebration duration elapses (3.5s)
  dwight.update(4.0, completedContext);
  assert.equal(dwight.state, 'working');
});



test('HQ Behavior Engine: 6. Destination cooldown prevents immediate repetitive visits', () => {
  const stanleyLayout = DOMAIN_LAYOUTS['devops-cloud'];
  const stanley = new HQCharacterBehavior(stanleyLayout);

  const secStation = stanleyLayout.secondaryStations[0];
  stanley.navigateTo(secStation, 'performing_activity');

  // Cooldown is set
  assert.equal(stanley.targetStation.id, secStation.id);

  // Arrive at secondary station
  for (let i = 0; i < 5; i++) stanley.update(1.0);

  // When next activity is selected, it must return to primary desk rather than looping
  stanley.selectNextActivity();
  assert.equal(stanley.targetStation.id, stanleyLayout.primaryWorkstation.id);
});

test('HQ Behavior Engine: 7. Social interactions exist between complementary engineering roles', () => {
  assert.ok(SOCIAL_DIALOGUES.length >= 3, 'Must have at least 3 social dialogues');

  for (const dialogue of SOCIAL_DIALOGUES) {
    assert.equal(dialogue.pair.length, 2);
    assert.ok(COMMON_STATIONS[dialogue.stationId], `Station ${dialogue.stationId} must exist`);
    assert.ok(dialogue.speaker1Line.length > 0);
    assert.ok(dialogue.speaker2Line.length > 0);
    assert.ok(dialogue.durationSec > 0);
  }
});

test('HQ Behavior Engine: 8. Ambient behavior selection matches realistic office distribution', () => {
  const pamLayout = DOMAIN_LAYOUTS['computer-vision'];
  const rng = createLcgRng(999);
  const pam = new HQCharacterBehavior(pamLayout, rng);

  let primaryWorkstationCount = 0;

  for (let cycle = 0; cycle < 100; cycle++) {
    // Reset to desk
    pam.currentStation = pamLayout.primaryWorkstation;
    pam.selectNextActivity();
    if (pam.state === 'working' && pam.currentStation.kind === 'primary_workstation') {
      primaryWorkstationCount++;
    }
  }

  // Workstation should be dominant (~70% of selections)
  assert.ok(
    primaryWorkstationCount >= 50,
    `Primary workstation should dominate ambient selection, got ${primaryWorkstationCount}/100`
  );
});


test('HQ Behavior Engine: 9. Deterministic behavior under fixed pseudo-random seed', () => {
  const layout = DOMAIN_LAYOUTS['ai-ml'];

  const rng1 = createLcgRng(777);
  const ryan1 = new HQCharacterBehavior(layout, rng1);

  const rng2 = createLcgRng(777);
  const ryan2 = new HQCharacterBehavior(layout, rng2);

  for (let step = 0; step < 50; step++) {
    ryan1.update(0.5);
    ryan2.update(0.5);

    assert.equal(Math.round(ryan1.x), Math.round(ryan2.x));
    assert.equal(Math.round(ryan1.y), Math.round(ryan2.y));
    assert.equal(ryan1.state, ryan2.state);
    assert.equal(ryan1.facing, ryan2.facing);
  }
});
