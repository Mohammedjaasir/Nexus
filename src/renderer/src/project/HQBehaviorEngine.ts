import type { OfficeCharacterName } from '../scene/office/cast';
import type { DomainId } from '@shared/domain';
import type {
  BehaviorState,
  DomainOfficeLayout,
  OfficeStation,
  SocialDialogue,
  StationKind
} from './HQBehaviorTypes';

// ── Common Shared Office Stations ──────────────────────────────────────────
export const COMMON_STATIONS: Record<string, OfficeStation> = {
  meeting_table: {
    id: 'meeting_table',
    name: 'Architecture Meeting Table',
    kind: 'meeting_table',
    x: 380,
    y: 195,
    facing: 'left',
    defaultDurationSec: 5.0,
    activities: ['Design sync', 'Spec review', 'API alignment'],
    contextualThoughts: ['design sync', 'reviewing specs', 'team discussion']
  },
  mission_board: {
    id: 'mission_board',
    name: 'Sprint Mission Board',
    kind: 'mission_board',
    x: 630,
    y: 540,
    facing: 'up',
    defaultDurationSec: 4.0,
    activities: ['Checking backlog', 'Claiming ticket', 'Status update'],
    contextualThoughts: ["what's next?", 'checking queue', 'reviewing board']
  },
  coffee_lounge: {
    id: 'coffee_lounge',
    name: 'Lounge Coffee Bar',
    kind: 'coffee_lounge',
    x: 275,
    y: 545,
    facing: 'up',
    defaultDurationSec: 4.5,
    activities: ['Coffee break', 'Quick breather'],
    contextualThoughts: ['need coffee', 'quick breather', 'almost done']
  },
  water_cooler: {
    id: 'water_cooler',
    name: 'Hall Water Cooler',
    kind: 'water_cooler',
    x: 770,
    y: 545,
    facing: 'down',
    defaultDurationSec: 3.5,
    activities: ['Hydration', 'Casual check-in'],
    contextualThoughts: ['hydration break', 'quick water']
  }
};

// ── All 12 Domain Office Layouts with Specific Hardware & Interaction Stations ──
export const DOMAIN_LAYOUTS: Record<string, DomainOfficeLayout> = {
  'software-engineering': {
    domainId: 'software-engineering',
    character: 'jim',
    displayName: 'Jim',
    roleTitle: 'Software Engineer',
    primaryWorkstation: {
      id: 'swe_desk',
      name: 'SWE Coding Workstation',
      kind: 'primary_workstation',
      domainId: 'software-engineering',
      x: 215,
      y: 145,
      facing: 'down',
      defaultDurationSec: 14.0,
      activities: ['Writing code', 'Refactoring API', 'Reviewing PRs'],
      contextualThoughts: ['writing code', 'refactoring API', 'back to work']
    },
    secondaryStations: [
      {
        id: 'swe_whiteboard',
        name: 'Architecture Whiteboard',
        kind: 'secondary_station',
        domainId: 'software-engineering',
        x: 135,
        y: 135,
        facing: 'up',
        defaultDurationSec: 4.5,
        activities: ['Reviewing schema', 'System architecture'],
        contextualThoughts: ['checking schema', 'reviewing specs']
      },
      {
        id: 'swe_terminal',
        name: 'Debugging Terminal Station',
        kind: 'secondary_station',
        domainId: 'software-engineering',
        x: 105,
        y: 145,
        facing: 'left',
        defaultDurationSec: 4.0,
        activities: ['Log inspection', 'Grep traces'],
        contextualThoughts: ['checking logs', 'debugging error']
      }
    ],
    verificationStation: {
      id: 'swe_test_rig',
      name: 'Unit Test Runner Station',
      kind: 'verification_station',
      domainId: 'software-engineering',
      x: 160,
      y: 195,
      facing: 'down',
      defaultDurationSec: 3.5,
      activities: ['Running integration tests', 'Verifying build'],
      contextualThoughts: ['running tests', 'verifying build']
    }
  },

  'ai-ml': {
    domainId: 'ai-ml',
    character: 'ryan',
    displayName: 'Ryan',
    roleTitle: 'Machine Learning Engineer',
    primaryWorkstation: {
      id: 'ai_desk',
      name: 'ML Model Workstation',
      kind: 'primary_workstation',
      domainId: 'ai-ml',
      x: 494,
      y: 145,
      facing: 'down',
      defaultDurationSec: 15.0,
      activities: ['Training model', 'Hyperparameter tuning', 'Feature engineering'],
      contextualThoughts: ['running model', 'tuning weights', 'back to work']
    },
    secondaryStations: [
      {
        id: 'ai_gpu_rack',
        name: 'GPU Cluster Rack',
        kind: 'secondary_station',
        domainId: 'ai-ml',
        x: 435,
        y: 145,
        facing: 'up',
        defaultDurationSec: 4.5,
        activities: ['GPU telemetry inspection', 'VRAM allocation'],
        contextualThoughts: ['checking GPU', 'inspecting cluster']
      },
      {
        id: 'ai_experiment_board',
        name: 'Experiment Tracking Board',
        kind: 'secondary_station',
        domainId: 'ai-ml',
        x: 505,
        y: 125,
        facing: 'up',
        defaultDurationSec: 4.0,
        activities: ['Experiment comparison', 'Benchmark review'],
        contextualThoughts: ['comparing runs', 'reviewing stats']
      }
    ],
    verificationStation: {
      id: 'ai_eval_station',
      name: 'Model Evaluation Station',
      kind: 'verification_station',
      domainId: 'ai-ml',
      x: 535,
      y: 145,
      facing: 'right',
      defaultDurationSec: 4.0,
      activities: ['Inference validation', 'F1-score verification'],
      contextualThoughts: ['evaluating model', 'checking metrics']
    }
  },

  'cybersecurity': {
    domainId: 'cybersecurity',
    character: 'creed',
    displayName: 'Creed',
    roleTitle: 'Security Specialist',
    primaryWorkstation: {
      id: 'cyber_desk',
      name: 'SOC Security Console',
      kind: 'primary_workstation',
      domainId: 'cybersecurity',
      x: 686,
      y: 145,
      facing: 'down',
      defaultDurationSec: 14.0,
      activities: ['Threat monitoring', 'Vulnerability scanning', 'IAM auditing'],
      contextualThoughts: ['monitoring threats', 'auditing logs', 'back to work']
    },
    secondaryStations: [
      {
        id: 'cyber_threat_wall',
        name: 'Global Threat Monitor Wall',
        kind: 'secondary_station',
        domainId: 'cybersecurity',
        x: 740,
        y: 145,
        facing: 'up',
        defaultDurationSec: 4.5,
        activities: ['Threat telemetry analysis', 'Zero-day investigation'],
        contextualThoughts: ['checking alerts', 'inspecting traffic']
      },
      {
        id: 'cyber_firewall_rack',
        name: 'Hardware Firewall Gateway',
        kind: 'secondary_station',
        domainId: 'cybersecurity',
        x: 865,
        y: 145,
        facing: 'up',
        defaultDurationSec: 4.0,
        activities: ['Firewall rule inspection', 'TLS certificate check'],
        contextualThoughts: ['updating firewall', 'checking certs']
      }
    ],
    verificationStation: {
      id: 'cyber_audit_station',
      name: 'Security Verification Console',
      kind: 'verification_station',
      domainId: 'cybersecurity',
      x: 740,
      y: 195,
      facing: 'right',
      defaultDurationSec: 3.5,
      activities: ['Automated penetration testing', 'Compliance validation'],
      contextualThoughts: ['running audit', 'verifying patches']
    }
  },

  'computer-vision': {
    domainId: 'computer-vision',
    character: 'pam',
    displayName: 'Pam',
    roleTitle: 'Computer Vision Engineer',
    primaryWorkstation: {
      id: 'cv_desk',
      name: 'Vision Model Desk',
      kind: 'primary_workstation',
      domainId: 'computer-vision',
      x: 175,
      y: 285,
      facing: 'down',
      defaultDurationSec: 13.0,
      activities: ['Image segmentation', 'Object detection training', 'Video pipeline'],
      contextualThoughts: ['inspecting frames', 'training detector', 'back to work']
    },
    secondaryStations: [
      {
        id: 'cv_camera_rig',
        name: 'Optical Sensor Rig',
        kind: 'secondary_station',
        domainId: 'computer-vision',
        x: 115,
        y: 285,
        facing: 'left',
        defaultDurationSec: 4.5,
        activities: ['Camera calibration', 'Lighting test'],
        contextualThoughts: ['calibrating camera', 'testing sensors']
      }
    ],
    verificationStation: {
      id: 'cv_eval_rig',
      name: 'Vision Benchmark Unit',
      kind: 'verification_station',
      domainId: 'computer-vision',
      x: 175,
      y: 340,
      facing: 'down',
      defaultDurationSec: 3.5,
      activities: ['mAP calculation', 'Realtime frame verification'],
      contextualThoughts: ['verifying mAP', 'checking accuracy']
    }
  },

  'data-science': {
    domainId: 'data-science',
    character: 'oscar',
    displayName: 'Oscar',
    roleTitle: 'Data Scientist',
    primaryWorkstation: {
      id: 'ds_desk',
      name: 'Data Science Analysis Desk',
      kind: 'primary_workstation',
      domainId: 'data-science',
      x: 320,
      y: 285,
      facing: 'down',
      defaultDurationSec: 14.0,
      activities: ['Exploratory data analysis', 'Statistical modeling', 'Pipeline design'],
      contextualThoughts: ['checking the data', 'fitting model', 'back to work']
    },
    secondaryStations: [
      {
        id: 'ds_chart_wall',
        name: 'Statistical Distribution Board',
        kind: 'secondary_station',
        domainId: 'data-science',
        x: 360,
        y: 275,
        facing: 'up',
        defaultDurationSec: 4.5,
        activities: ['Chart review', 'Correlation matrix analysis'],
        contextualThoughts: ['reviewing charts', 'checking p-values']
      }
    ],
    verificationStation: {
      id: 'ds_verify_terminal',
      name: 'Hypothesis Verification Terminal',
      kind: 'verification_station',
      domainId: 'data-science',
      x: 320,
      y: 340,
      facing: 'down',
      defaultDurationSec: 3.5,
      activities: ['Cross-validation', 'Data leakage check'],
      contextualThoughts: ['running validation', 'checking holdout']
    }
  },

  'data-analytics': {
    domainId: 'data-analytics',
    character: 'kevin',
    displayName: 'Kevin',
    roleTitle: 'Data Analyst',
    primaryWorkstation: {
      id: 'analytics_desk',
      name: 'Analytics Dashboard Desk',
      kind: 'primary_workstation',
      domainId: 'data-analytics',
      x: 550,
      y: 285,
      facing: 'down',
      defaultDurationSec: 13.0,
      activities: ['Writing SQL queries', 'Building KPI reports', 'Funnel analysis'],
      contextualThoughts: ['writing SQL', 'building report', 'back to work']
    },
    secondaryStations: [
      {
        id: 'analytics_kpi_wall',
        name: 'Executive KPI Monitor',
        kind: 'secondary_station',
        domainId: 'data-analytics',
        x: 515,
        y: 275,
        facing: 'up',
        defaultDurationSec: 4.5,
        activities: ['Dashboard inspection', 'Metric tracking'],
        contextualThoughts: ['checking KPI', 'updating metrics']
      }
    ],
    verificationStation: {
      id: 'analytics_verify',
      name: 'Report Verification Station',
      kind: 'verification_station',
      domainId: 'data-analytics',
      x: 550,
      y: 340,
      facing: 'down',
      defaultDurationSec: 3.5,
      activities: ['Data reconciliation', 'Metric integrity check'],
      contextualThoughts: ['verifying numbers', 'reconciling data']
    }
  },

  'devops-cloud': {
    domainId: 'devops-cloud',
    character: 'stanley',
    displayName: 'Stanley',
    roleTitle: 'DevOps & Cloud Engineer',
    primaryWorkstation: {
      id: 'devops_desk',
      name: 'DevOps Cloud Console',
      kind: 'primary_workstation',
      domainId: 'devops-cloud',
      x: 810,
      y: 285,
      facing: 'down',
      defaultDurationSec: 14.0,
      activities: ['Kubernetes management', 'Terraform rollout', 'CI/CD pipeline'],
      contextualThoughts: ['deploying cluster', 'managing pods', 'back to work']
    },
    secondaryStations: [
      {
        id: 'devops_server_rack',
        name: 'Edge Server Rack',
        kind: 'secondary_station',
        domainId: 'devops-cloud',
        x: 735,
        y: 285,
        facing: 'left',
        defaultDurationSec: 4.5,
        activities: ['Server health check', 'Network switch config'],
        contextualThoughts: ['checking servers', 'inspecting nodes']
      }
    ],
    verificationStation: {
      id: 'devops_verify',
      name: 'Canary Deployment Station',
      kind: 'verification_station',
      domainId: 'devops-cloud',
      x: 810,
      y: 340,
      facing: 'down',
      defaultDurationSec: 3.5,
      activities: ['Canary smoke test', 'Zero-downtime health check'],
      contextualThoughts: ['testing canary', 'verifying rollout']
    }
  },

  'web-app-dev': {
    domainId: 'web-app-dev',
    character: 'jim',
    displayName: 'Jim',
    roleTitle: 'Frontend & Web Developer',
    primaryWorkstation: {
      id: 'web_desk',
      name: 'Frontend Workstation',
      kind: 'primary_workstation',
      domainId: 'web-app-dev',
      x: 155,
      y: 420,
      facing: 'down',
      defaultDurationSec: 13.0,
      activities: ['UI development', 'React component design', 'CSS styling'],
      contextualThoughts: ['building UI', 'styling layout', 'back to work']
    },
    secondaryStations: [
      {
        id: 'web_ui_screen',
        name: 'Browser Testing Display',
        kind: 'secondary_station',
        domainId: 'web-app-dev',
        x: 120,
        y: 420,
        facing: 'left',
        defaultDurationSec: 4.0,
        activities: ['Cross-browser preview', 'Accessibility audit'],
        contextualThoughts: ['browser testing', 'previewing UI']
      }
    ],
    verificationStation: {
      id: 'web_verify',
      name: 'E2E Playwright Station',
      kind: 'verification_station',
      domainId: 'web-app-dev',
      x: 155,
      y: 470,
      facing: 'down',
      defaultDurationSec: 3.5,
      activities: ['End-to-end browser test', 'Visual regression check'],
      contextualThoughts: ['running E2E tests', 'verifying components']
    }
  },

  'mobile-dev': {
    domainId: 'mobile-dev',
    character: 'andy',
    displayName: 'Andy',
    roleTitle: 'Mobile Developer',
    primaryWorkstation: {
      id: 'mobile_desk',
      name: 'Mobile App Workstation',
      kind: 'primary_workstation',
      domainId: 'mobile-dev',
      x: 300,
      y: 420,
      facing: 'down',
      defaultDurationSec: 13.0,
      activities: ['iOS / Android coding', 'React Native module', 'Native bridge'],
      contextualThoughts: ['mobile coding', 'compiling build', 'back to work']
    },
    secondaryStations: [
      {
        id: 'mobile_test_rack',
        name: 'Physical Device Testing Rack',
        kind: 'secondary_station',
        domainId: 'mobile-dev',
        x: 275,
        y: 420,
        facing: 'left',
        defaultDurationSec: 4.5,
        activities: ['Device test run', 'Touch gesture calibration'],
        contextualThoughts: ['testing device', 'checking touches']
      }
    ],
    verificationStation: {
      id: 'mobile_verify',
      name: 'App Store Verification Rig',
      kind: 'verification_station',
      domainId: 'mobile-dev',
      x: 300,
      y: 470,
      facing: 'down',
      defaultDurationSec: 3.5,
      activities: ['Release binary check', 'Crash-free session test'],
      contextualThoughts: ['verifying build', 'running tests']
    }
  },

  'robotics-iot': {
    domainId: 'robotics-iot',
    character: 'dwight',
    displayName: 'Dwight',
    roleTitle: 'Robotics & Hardware Specialist',
    primaryWorkstation: {
      id: 'robotics_desk',
      name: 'Hardware Control Bench',
      kind: 'primary_workstation',
      domainId: 'robotics-iot',
      x: 480,
      y: 420,
      facing: 'down',
      defaultDurationSec: 14.0,
      activities: ['Firmware programming', 'Kinematics solver', 'Sensor fusion'],
      contextualThoughts: ['coding firmware', 'tuning servos', 'back to work']
    },
    secondaryStations: [
      {
        id: 'robotics_arm_bench',
        name: '6-DOF Robotic Arm Bench',
        kind: 'secondary_station',
        domainId: 'robotics-iot',
        x: 435,
        y: 420,
        facing: 'left',
        defaultDurationSec: 5.0,
        activities: ['Inverse kinematics test', 'Gripper calibration'],
        contextualThoughts: ['testing arm', 'calibrating gripper']
      }
    ],
    verificationStation: {
      id: 'robotics_verify',
      name: 'Hardware Telemetry Unit',
      kind: 'verification_station',
      domainId: 'robotics-iot',
      x: 480,
      y: 470,
      facing: 'down',
      defaultDurationSec: 3.5,
      activities: ['Stress test cycle', 'Safety interlock verification'],
      contextualThoughts: ['checking safety', 'verifying hardware']
    }
  },

  'game-dev': {
    domainId: 'game-dev',
    character: 'jim',
    displayName: 'Jim',
    roleTitle: 'Game Developer',
    primaryWorkstation: {
      id: 'game_desk',
      name: 'Game Engine Workstation',
      kind: 'primary_workstation',
      domainId: 'game-dev',
      x: 650,
      y: 420,
      facing: 'down',
      defaultDurationSec: 14.0,
      activities: ['Gameplay physics', 'Shader programming', 'Level design'],
      contextualThoughts: ['tuning gameplay', 'shader coding', 'back to work']
    },
    secondaryStations: [
      {
        id: 'game_arcade_rig',
        name: 'Arcade Playtest Unit',
        kind: 'secondary_station',
        domainId: 'game-dev',
        x: 615,
        y: 420,
        facing: 'left',
        defaultDurationSec: 4.5,
        activities: ['Gamepad playtesting', 'Frame rate profiling'],
        contextualThoughts: ['playtesting level', 'checking 60fps']
      }
    ],
    verificationStation: {
      id: 'game_verify',
      name: 'Collision & Physics Test Unit',
      kind: 'verification_station',
      domainId: 'game-dev',
      x: 650,
      y: 470,
      facing: 'down',
      defaultDurationSec: 3.5,
      activities: ['Physics collision sweep', 'Memory leak check'],
      contextualThoughts: ['checking collisions', 'verifying build']
    }
  },

  'research-scientific': {
    domainId: 'research-scientific',
    character: 'michael',
    displayName: 'Michael',
    roleTitle: 'Research Scientist',
    primaryWorkstation: {
      id: 'research_desk',
      name: 'Scientific Research Desk',
      kind: 'primary_workstation',
      domainId: 'research-scientific',
      x: 830,
      y: 420,
      facing: 'down',
      defaultDurationSec: 15.0,
      activities: ['Simulation modeling', 'Literature review', 'Paper writing'],
      contextualThoughts: ['researching', 'drafting report', 'back to work']
    },
    secondaryStations: [
      {
        id: 'research_blackboard',
        name: 'Equation Blackboard',
        kind: 'secondary_station',
        domainId: 'research-scientific',
        x: 875,
        y: 420,
        facing: 'right',
        defaultDurationSec: 5.0,
        activities: ['Formula derivation', 'Model formulation'],
        contextualThoughts: ['checking equations', 'reviewing formulas']
      }
    ],
    verificationStation: {
      id: 'research_verify',
      name: 'Monte Carlo Simulator',
      kind: 'verification_station',
      domainId: 'research-scientific',
      x: 830,
      y: 470,
      facing: 'down',
      defaultDurationSec: 3.5,
      activities: ['Monte Carlo convergence', 'Error bound validation'],
      contextualThoughts: ['running simulation', 'verifying results']
    }
  }
};


// ── Meaningful Cross-Department Social Dialogues ────────────────────────────
export const SOCIAL_DIALOGUES: SocialDialogue[] = [
  {
    pair: ['ryan', 'jim'],
    stationId: 'meeting_table',
    speaker1Line: 'ML API endpoints are ready for integration.',
    speaker2Line: 'Awesome, running the client test suite now.',
    durationSec: 6.0
  },
  {
    pair: ['oscar', 'kevin'],
    stationId: 'meeting_table',
    speaker1Line: 'Statistical distributions show clean trends.',
    speaker2Line: 'Great, updating the executive KPI charts.',
    durationSec: 5.5
  },
  {
    pair: ['creed', 'stanley'],
    stationId: 'meeting_table',
    speaker1Line: 'Firewall security audit passed with zero alerts.',
    speaker2Line: 'Deploying the cluster update now.',
    durationSec: 5.5
  }
];

// ── Agent Live Context ──────────────────────────────────────────────────────
export interface LiveAgentContext {
  character: OfficeCharacterName;
  status: 'idle' | 'working' | 'thinking' | 'blocked' | 'success';
  taskTitle?: string;
  projectName?: string;
  isVerifying?: boolean;
}

// ── Character Behavior Instance ─────────────────────────────────────────────
export class HQCharacterBehavior {
  readonly layout: DomainOfficeLayout;
  state: BehaviorState = 'working';
  currentStation: OfficeStation;
  targetStation: OfficeStation;
  x: number;
  y: number;
  facing: 'down' | 'up' | 'left' | 'right';
  animTimer = 0;
  animFrame = 0;
  stateTimer = 0;
  stateDuration = 10;
  speed = 46;
  thoughtText: string | null = null;
  thoughtTimer = 0;
  private stationCooldowns = new Map<string, number>();
  private rng: () => number;

  constructor(layout: DomainOfficeLayout, customRng?: () => number) {
    this.layout = layout;
    this.rng = customRng || Math.random;
    this.currentStation = layout.primaryWorkstation;
    this.targetStation = layout.primaryWorkstation;
    this.x = layout.primaryWorkstation.x;
    this.y = layout.primaryWorkstation.y;
    this.facing = layout.primaryWorkstation.facing;
    this.state = 'working';
    this.stateDuration = layout.primaryWorkstation.defaultDurationSec * (0.8 + this.rng() * 0.4);
  }

  /** Select next role- and task-appropriate destination based on real context */
  selectNextActivity(context?: LiveAgentContext): void {
    // ── TASK-DRIVEN OVERRIDES ──
    if (context) {
      if (context.status === 'blocked') {
        this.state = 'blocked';
        this.thoughtText = 'waiting on input';
        this.thoughtTimer = 4.0;
        this.stateDuration = 6.0;
        return;
      }

      if (context.isVerifying) {
        this.navigateTo(this.layout.verificationStation, 'verifying');
        this.thoughtText = 'running tests';
        this.thoughtTimer = 3.5;
        return;
      }

      if (context.status === 'success') {
        this.state = 'celebrating';
        this.thoughtText = 'done!';
        this.thoughtTimer = 3.5;
        this.stateDuration = 3.5;
        return;
      }

      if (context.status === 'working' || context.status === 'thinking') {
        // While busy on a real task, 80% stay at primary desk, 20% visit domain-specific secondary
        if (this.currentStation.id !== this.layout.primaryWorkstation.id) {
          // Return to desk
          this.navigateTo(this.layout.primaryWorkstation, 'working');
          return;
        }

        const roll = this.rng();
        if (roll < 0.25 && this.layout.secondaryStations.length > 0) {
          const eligible = this.layout.secondaryStations.filter(s => (this.stationCooldowns.get(s.id) ?? 0) <= 0);
          const chosen = eligible.length > 0 ? eligible[Math.floor(this.rng() * eligible.length)] : this.layout.secondaryStations[0];
          this.navigateTo(chosen, 'performing_activity');
        } else {
          // Remain at primary desk
          this.state = 'working';
          this.stateDuration = this.layout.primaryWorkstation.defaultDurationSec;
          if (context.taskTitle) {
            const raw = context.taskTitle.trim();
            const lower = raw.toLowerCase();
            let shortText = lower;
            if (lower.startsWith('fix ') || lower.startsWith('fixing ')) shortText = `fixing ${raw.replace(/^fix(ing)?\s+/i, '')}`;
            else if (lower.startsWith('improve ') || lower.startsWith('improving ')) shortText = `working on ${raw.replace(/^improv(e|ing)\s+/i, '')}`;
            else if (lower.startsWith('run ') || lower.startsWith('running ')) shortText = `running ${raw.replace(/^run(ning)?\s+/i, '')}`;
            else if (lower.startsWith('test ') || lower.startsWith('testing ')) shortText = `testing ${raw.replace(/^test(ing)?\s+/i, '')}`;
            else if (lower.startsWith('build ') || lower.startsWith('building ')) shortText = `building ${raw.replace(/^build(ing)?\s+/i, '')}`;
            else if (raw.length > 20) shortText = raw.slice(0, 18) + '…';

            this.thoughtText = shortText.toLowerCase();
            this.thoughtTimer = 3.5;
          } else {
            this.pickContextualThought(this.layout.primaryWorkstation);
          }
        }
        return;
      }
    }



    // ── AMBIENT BEHAVIOR (Weighted distribution) ──
    // If away from primary desk, always navigate back first
    if (this.currentStation.id !== this.layout.primaryWorkstation.id) {
      this.navigateTo(this.layout.primaryWorkstation, 'working');
      return;
    }

    const rand = this.rng();
    if (rand < 0.70) {
      // 70%: Primary Workstation
      this.state = 'working';
      this.stateDuration = this.layout.primaryWorkstation.defaultDurationSec * (0.8 + this.rng() * 0.4);
      this.pickContextualThought(this.layout.primaryWorkstation);
    } else if (rand < 0.80 && this.layout.secondaryStations.length > 0) {
      // 10%: Domain-Specific Secondary Station
      const eligible = this.layout.secondaryStations.filter(s => (this.stationCooldowns.get(s.id) ?? 0) <= 0);
      const chosen = eligible.length > 0 ? eligible[Math.floor(this.rng() * eligible.length)] : this.layout.secondaryStations[0];
      this.navigateTo(chosen, 'performing_activity');
    } else if (rand < 0.88) {
      // 8%: Architecture Meeting Table
      this.navigateTo(COMMON_STATIONS.meeting_table, 'performing_activity');
    } else if (rand < 0.93) {
      // 5%: Sprint Mission Board
      this.navigateTo(COMMON_STATIONS.mission_board, 'performing_activity');
    } else if (rand < 0.97) {
      // 4%: Lounge Coffee Bar
      this.navigateTo(COMMON_STATIONS.coffee_lounge, 'idle_resting');
    } else {
      // 3%: Hall Water Cooler
      this.navigateTo(COMMON_STATIONS.water_cooler, 'idle_resting');
    }
  }

  navigateTo(station: OfficeStation, nextStateOnArrival: BehaviorState): void {
    this.targetStation = station;
    this.state = 'walking_to_station';
    this.stationCooldowns.set(station.id, 25.0); // 25s cooldown before visiting same station again
    this.pickContextualThought(station);
  }

  private pickContextualThought(station: OfficeStation): void {
    if (station.contextualThoughts.length > 0 && this.rng() < 0.65) {
      const idx = Math.floor(this.rng() * station.contextualThoughts.length);
      this.thoughtText = station.contextualThoughts[idx];
      this.thoughtTimer = 2.6;
    }
  }

  update(dt: number, context?: LiveAgentContext): void {
    // Tick cooldowns
    for (const [id, time] of this.stationCooldowns.entries()) {
      if (time > 0) this.stationCooldowns.set(id, Math.max(0, time - dt));
    }

    // Tick thought bubble
    if (this.thoughtText) {
      this.thoughtTimer -= dt;
      if (this.thoughtTimer <= 0) this.thoughtText = null;
    }

    // Handle walking movement
    if (this.state === 'walking_to_station') {
      const dx = this.targetStation.x - this.x;
      const dy = this.targetStation.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = Math.min(this.speed * dt, dist);

      if (dist <= step || dist < 1.5) {
        this.x = this.targetStation.x;
        this.y = this.targetStation.y;
        this.currentStation = this.targetStation;
        this.facing = this.targetStation.facing;
        this.animFrame = 0;

        // Arrival state transition
        if (this.currentStation.id === this.layout.primaryWorkstation.id) {
          this.state = 'working';
          this.stateDuration = this.layout.primaryWorkstation.defaultDurationSec;
        } else if (this.currentStation.kind === 'verification_station') {
          this.state = 'verifying';
          this.stateDuration = this.targetStation.defaultDurationSec;
        } else {
          this.state = 'performing_activity';
          this.stateDuration = this.targetStation.defaultDurationSec;
        }
        this.stateTimer = 0;
        this.pickContextualThought(this.currentStation);
        return;
      }

      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;

      // Facing calculation
      if (Math.abs(dx) > Math.abs(dy)) {
        this.facing = dx > 0 ? 'right' : 'left';
      } else {
        this.facing = dy > 0 ? 'down' : 'up';
      }

      // Cycle walk animation: 0 -> 1 -> 0 -> 2
      this.animTimer += dt;
      const frameIndex = Math.floor(this.animTimer / 0.14) % 4;
      this.animFrame = frameIndex === 0 ? 0 : frameIndex === 1 ? 1 : frameIndex === 2 ? 0 : 2;
      return;
    }

    // In-place activities (working / performing / resting)
    this.animFrame = 0;
    this.stateTimer += dt;

    if (this.state === 'celebrating') {
      if (this.stateTimer >= this.stateDuration) {
        this.state = 'working';
        this.stateTimer = 0;
      }
      return;
    }

    if (this.stateTimer >= this.stateDuration) {
      this.stateTimer = 0;
      this.selectNextActivity(context);
    }
  }
}
