import type { DomainId } from '@shared/domain';

export interface RoomProp {
  icon: string;
  name: string;
}

export interface DepartmentVisualMeta {
  domainId: DomainId;
  signCode: string;
  roomName: string;
  floorColor: string;
  wallBorderColor: string;
  accentGlow: string;
  props: RoomProp[];
  leadQuote: string;
}

export const DEPARTMENT_VISUALS: Record<DomainId, DepartmentVisualMeta> = {
  'software-engineering': {
    domainId: 'software-engineering',
    signCode: 'RM-A01',
    roomName: 'Annex Software Lab',
    floorColor: '#EBF3FB',
    wallBorderColor: '#1E88E5',
    accentGlow: '#4A90E2',
    props: [
      { icon: '🖥️', name: 'Workstation' },
      { icon: '🪑', name: 'Ergo Chair' },
      { icon: '☕', name: 'Espresso' },
      { icon: '📋', name: 'Task DAG' }
    ],
    leadQuote: 'Ready to break down features, implement clean code, and ship passing test suites.'
  },
  'ai-ml': {
    domainId: 'ai-ml',
    signCode: 'LAB-B02',
    roomName: 'AI / ML Innovation Wing',
    floorColor: '#F3E5F5',
    wallBorderColor: '#8E24AA',
    accentGlow: '#9B51E0',
    props: [
      { icon: '🤖', name: 'GPU Cluster' },
      { icon: '⚡', name: 'Tensor Rig' },
      { icon: '📊', name: 'Loss Monitor' },
      { icon: '🧠', name: 'Model Weights' }
    ],
    leadQuote: 'Training pipelines are active and loss convergence is strictly verified.'
  },
  'cybersecurity': {
    domainId: 'cybersecurity',
    signCode: 'SEC-C03',
    roomName: 'Security Operations Center',
    floorColor: '#FBE9E7',
    wallBorderColor: '#D84315',
    accentGlow: '#E65100',
    props: [
      { icon: '🛡️', name: 'Firewall Hub' },
      { icon: '🔐', name: 'Key Vault' },
      { icon: '📡', name: 'Threat Radar' },
      { icon: '💻', name: 'Fuzzing Terminal' }
    ],
    leadQuote: 'Zero-trust boundaries enforced. Scanning for CVEs and hardcoded secrets.'
  },
  'computer-vision': {
    domainId: 'computer-vision',
    signCode: 'VIS-D04',
    roomName: 'Vision & Perception Lab',
    floorColor: '#E0F2F1',
    wallBorderColor: '#00897B',
    accentGlow: '#26A69A',
    props: [
      { icon: '👁️', name: 'Optics Array' },
      { icon: '📷', name: 'Sensor Bench' },
      { icon: '📐', name: 'Spatial Tensor' },
      { icon: '🖼️', name: 'OCR Stream' }
    ],
    leadQuote: 'Processing image tensors, affine bounding boxes, and precision-recall curves.'
  },
  'data-science': {
    domainId: 'data-science',
    signCode: 'DAT-E05',
    roomName: 'Statistical Research Lab',
    floorColor: '#E1F5FE',
    wallBorderColor: '#0288D1',
    accentGlow: '#29B6F6',
    props: [
      { icon: '📊', name: 'Stats Board' },
      { icon: '📈', name: 'Regression Desk' },
      { icon: '🔬', name: 'EDA Station' },
      { icon: '🗄️', name: 'Data Lake' }
    ],
    leadQuote: 'Evaluating distribution significance, p-values, and scikit-learn models.'
  },
  'data-analytics': {
    domainId: 'data-analytics',
    signCode: 'BI-F06',
    roomName: 'Business Intelligence Hub',
    floorColor: '#FFF3E0',
    wallBorderColor: '#FB8C00',
    accentGlow: '#FFA726',
    props: [
      { icon: '📈', name: 'KPI Wall' },
      { icon: '📑', name: 'Ledger Terminal' },
      { icon: '🗃️', name: 'SQL Warehouse' },
      { icon: '🧮', name: 'Audit Bench' }
    ],
    leadQuote: 'Validating dimensional SQL models and reconciling financial ledgers to the cent.'
  },
  'devops-cloud': {
    domainId: 'devops-cloud',
    signCode: 'OPS-G07',
    roomName: 'Cloud Platform & SRE Bay',
    floorColor: '#E0F7FA',
    wallBorderColor: '#00ACC1',
    accentGlow: '#00BCD4',
    props: [
      { icon: '☁️', name: 'Kubernetes Bay' },
      { icon: '🐳', name: 'Docker Engine' },
      { icon: '🛠️', name: 'Terraform IaC' },
      { icon: '🚨', name: 'SRE Monitor' }
    ],
    leadQuote: 'Cluster metrics nominal. Container multi-stage builds and CI/CD pipelines green.'
  },
  'web-app-dev': {
    domainId: 'web-app-dev',
    signCode: 'WEB-H08',
    roomName: 'Frontend & Full-Stack Studio',
    floorColor: '#F3E5F5',
    wallBorderColor: '#7B1FA2',
    accentGlow: '#AB47BC',
    props: [
      { icon: '🌐', name: 'Browser Bench' },
      { icon: '🎨', name: 'UI Canvas' },
      { icon: '⚛️', name: 'React Node' },
      { icon: '⚡', name: 'Vite Bundler' }
    ],
    leadQuote: 'Crafting responsive, accessible UI components with strict TypeScript safety.'
  },
  'mobile-dev': {
    domainId: 'mobile-dev',
    signCode: 'MOB-I09',
    roomName: 'Mobile & Device Studio',
    floorColor: '#E8F5E9',
    wallBorderColor: '#43A047',
    accentGlow: '#66BB6A',
    props: [
      { icon: '📱', name: 'Device Dock' },
      { icon: '📲', name: 'iOS/Android Rig' },
      { icon: '🔋', name: 'Battery Profiler' },
      { icon: '🧭', name: 'Native Bridge' }
    ],
    leadQuote: 'Optimizing mobile touch responsiveness, frame rates, and native bridges.'
  },
  'robotics-iot': {
    domainId: 'robotics-iot',
    signCode: 'ROB-J10',
    roomName: 'Robotics & Hardware Bay',
    floorColor: '#FCE4EC',
    wallBorderColor: '#C2185B',
    accentGlow: '#EC407A',
    props: [
      { icon: '🦾', name: 'Robotic Arm' },
      { icon: '🔌', name: 'Sensor Circuit' },
      { icon: '🤖', name: 'ROS2 Node' },
      { icon: '🎛️', name: 'Telemetry Bench' }
    ],
    leadQuote: 'Real-time ROS2 kinematic loops and sensor telemetry drivers calibrated.'
  },
  'game-dev': {
    domainId: 'game-dev',
    signCode: 'GM-K11',
    roomName: 'Game Studio & Workshop',
    floorColor: '#EDE7F6',
    wallBorderColor: '#5E35B1',
    accentGlow: '#7E57C2',
    props: [
      { icon: '🎮', name: 'Arcade Cabinet' },
      { icon: '🕹️', name: 'GameLoop Station' },
      { icon: '👾', name: 'Pixel Canvas' },
      { icon: '💥', name: 'Physics Engine' }
    ],
    leadQuote: 'Fixed-timestep physics, entity-component systems, and retro sprite loops active.'
  },
  'research-scientific': {
    domainId: 'research-scientific',
    signCode: 'SCI-L12',
    roomName: 'Scientific Simulation Center',
    floorColor: '#E8EAF6',
    wallBorderColor: '#3949AB',
    accentGlow: '#5C6BC0',
    props: [
      { icon: '🔬', name: 'Observatory Console' },
      { icon: '📐', name: 'Equation Board' },
      { icon: '🌌', name: 'Simulation Rig' },
      { icon: '🧪', name: 'Numerical Solver' }
    ],
    leadQuote: 'Differential equation solvers converging with high floating-point precision.'
  },
  // Fallbacks for future domains
  'embedded-systems': {
    domainId: 'embedded-systems',
    signCode: 'EMB-M13',
    roomName: 'Embedded Firmware Lab',
    floorColor: '#ECEFF1',
    wallBorderColor: '#546E7A',
    accentGlow: '#78909C',
    props: [{ icon: '⚡', name: 'Microcontroller' }],
    leadQuote: 'Bare-metal interrupt handlers and low-power registers configured.'
  },
  'automation-rpa': {
    domainId: 'automation-rpa',
    signCode: 'RPA-N14',
    roomName: 'Process Automation Bureau',
    floorColor: '#EFEBE9',
    wallBorderColor: '#6D4C41',
    accentGlow: '#8D6E63',
    props: [{ icon: '⚙️', name: 'Scraper Station' }],
    leadQuote: 'Automated headless browser tasks executing on schedule.'
  },
  'blockchain-web3': {
    domainId: 'blockchain-web3',
    signCode: 'W3-O15',
    roomName: 'Cryptographic Protocol Wing',
    floorColor: '#FBE9E7',
    wallBorderColor: '#BF360C',
    accentGlow: '#FF5722',
    props: [{ icon: '⛓️', name: 'Node Validator' }],
    leadQuote: 'Smart contracts audited for reentrancy and formal correctness.'
  },
  'gis-geospatial': {
    domainId: 'gis-geospatial',
    signCode: 'GIS-P16',
    roomName: 'Geospatial Intelligence Lab',
    floorColor: '#E8F5E9',
    wallBorderColor: '#1B5E20',
    accentGlow: '#4CAF50',
    props: [{ icon: '🗺️', name: 'Vector Map' }],
    leadQuote: 'Spatial coordinates indexed and polygon projections rendered.'
  }
};

export function getDepartmentVisual(domainId: DomainId): DepartmentVisualMeta {
  return DEPARTMENT_VISUALS[domainId] || DEPARTMENT_VISUALS['software-engineering'];
}
