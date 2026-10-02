/**
 * Domain Registry and Specialized Agent definitions for Nexus.
 *
 * Expands the platform into a multi-domain engineering registry:
 *  1. Software Engineering
 *  2. AI / Machine Learning
 *  3. Cybersecurity
 *  4. Computer Vision
 *  5. Data Science
 *  6. Data Analytics
 *  7. DevOps / Cloud
 *  8. Web & Application Development
 *  9. Mobile Development
 * 10. Robotics / IoT
 * 11. Game Development
 * 12. Research / Scientific Computing
 *
 * Prepared for:
 * 13. Embedded Systems
 * 14. Automation / RPA
 * 15. Blockchain / Web3
 * 16. GIS / Geospatial
 */

import type { OfficeCharacterName } from '../renderer/src/scene/office/cast';
import type { AgentProvider } from './agentProvider';
import type { ContextTier } from './context';

export type DomainId =
  | 'software-engineering'
  | 'ai-ml'
  | 'cybersecurity'
  | 'computer-vision'
  | 'data-science'
  | 'data-analytics'
  | 'devops-cloud'
  | 'web-app-dev'
  | 'mobile-dev'
  | 'robotics-iot'
  | 'game-dev'
  | 'research-scientific'
  | 'embedded-systems'
  | 'automation-rpa'
  | 'blockchain-web3'
  | 'gis-geospatial';

export interface AgentContextStrategy {
  defaultBudgetTokens: number;
  focusTiers: ContextTier[];
  prioritizeTests: boolean;
  systemPromptPreamble: string;
}

export interface DomainAgentRole {
  roleId: string;
  domainId: DomainId;
  title: string;
  description: string;
  character: OfficeCharacterName;
  preferredProvider: AgentProvider;
  preferredModel?: string;
  recommendedSkills: string[];
  recommendedTools: string[];
  capabilities: string[];
  verificationRules: string[];
  contextStrategy: AgentContextStrategy;
}

export interface DomainVerificationRule {
  id: string;
  name: string;
  type: 'test_runner' | 'linter' | 'typecheck' | 'build' | 'security_scan' | 'custom';
  description: string;
  commandTemplate?: string;
}

export interface DomainDefinition {
  id: DomainId;
  name: string;
  description: string;
  icon: string;
  category: 'engineering' | 'data_ai' | 'systems' | 'creative' | 'applied';
  departmentName: string;
  departmentRoom: string;
  badgeColor: string;
  leadCharacter: OfficeCharacterName;
  agentRoles: DomainAgentRole[];
  specializedSkills: string[];
  recommendedTools: string[];
  verificationRules: DomainVerificationRule[];
  taskCategories: string[];
  contextPreamble: string;
}

export const INITIAL_DOMAINS: Record<DomainId, DomainDefinition> = {
  // 1. Software Engineering
  'software-engineering': {
    id: 'software-engineering',
    name: 'Software Engineering',
    description: 'Full-stack application architecture, refactoring, API design, bug fixing, test automation, and CI/CD workflows.',
    icon: '💻',
    category: 'engineering',
    departmentName: 'Annex Software Lab',
    departmentRoom: 'Engineering Bay A',
    badgeColor: '#4A90E2',
    leadCharacter: 'jim',
    agentRoles: [
      {
        roleId: 'sde-planner',
        domainId: 'software-engineering',
        title: 'Planner',
        description: 'Breaks requirements into modular, testable tasks and dependency DAGs.',
        character: 'michael',
        preferredProvider: 'claude',
        recommendedSkills: ['md-hive-sync', 'md-audit'],
        recommendedTools: ['Read', 'Glob', 'Grep'],
        capabilities: ['architecture', 'planning', 'task-decomposition', 'dependency-graphing'],
        verificationRules: ['rule-typecheck'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier3_summary', 'tier4_metadata'],
          prioritizeTests: false,
          systemPromptPreamble: 'You are an expert Software Architect and Planner. Analyze system architecture, decompose features into incremental tasks, and define strict verification criteria.'
        }
      },
      {
        roleId: 'sde-engineer',
        domainId: 'software-engineering',
        title: 'Software Engineer',
        description: 'Implements features, refactors codebases, and integrates APIs with clean code standards.',
        character: 'jim',
        preferredProvider: 'claude',
        recommendedSkills: ['md-hive-sync'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['implementation', 'refactoring', 'api-design', 'feature-development'],
        verificationRules: ['rule-test-suite', 'rule-typecheck', 'rule-linter'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Senior Software Engineer. Write idiomatic, maintainable code with high test coverage and minimal blast radius.'
        }
      },
      {
        roleId: 'sde-debugger',
        domainId: 'software-engineering',
        title: 'Debugger',
        description: 'Pinpoints root causes, analyzes stack traces, and produces minimal reproduction fixes.',
        character: 'stanley',
        preferredProvider: 'claude',
        recommendedSkills: ['md-fetch-summarize'],
        recommendedTools: ['Read', 'Edit', 'Bash', 'Grep'],
        capabilities: ['debugging', 'root-cause-analysis', 'patching', 'regression-diagnosis'],
        verificationRules: ['rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are an expert Debugger and Systems Diagnostician. Trace errors to their exact line and cause before proposing surgical fixes.'
        }
      },
      {
        roleId: 'sde-tester',
        domainId: 'software-engineering',
        title: 'Tester / QA',
        description: 'Designs test suites, identifies edge cases, runs verification, and prevents regressions.',
        character: 'dwight',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Bash', 'Grep', 'Write', 'Edit'],
        capabilities: ['unit-testing', 'e2e-testing', 'regression-testing', 'test-coverage'],
        verificationRules: ['rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a QA and Test Automation Engineer. Execute test runners, identify regression risks, and verify correctness rigorously.'
        }
      },
      {
        roleId: 'sde-reviewer',
        domainId: 'software-engineering',
        title: 'Reviewer',
        description: 'Performs static analysis, architectural compliance checks, and code hygiene review.',
        character: 'angela',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Grep', 'Glob'],
        capabilities: ['code-review', 'clean-code-audit', 'type-audit', 'best-practices'],
        verificationRules: ['rule-typecheck', 'rule-linter'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature', 'tier3_summary'],
          prioritizeTests: false,
          systemPromptPreamble: 'You are a Senior Code Reviewer and Tech Lead. Inspect pull requests, verify non-breaking interface changes, and ensure style guide compliance.'
        }
      }
    ],
    specializedSkills: ['md-hive-sync', 'md-audit', 'md-fetch-summarize'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    verificationRules: [
      { id: 'rule-test-suite', name: 'Automated Test Suite', type: 'test_runner', description: 'Run project unit and integration tests (e.g. npm test, pytest, cargo test).' },
      { id: 'rule-typecheck', name: 'Static Type Check', type: 'typecheck', description: 'Verify static typing (e.g. tsc, mypy, pyright).' },
      { id: 'rule-linter', name: 'Code Linter', type: 'linter', description: 'Check lint rules and formatting (e.g. eslint, ruff, clippy).' }
    ],
    taskCategories: ['Architecture', 'Feature', 'Bugfix', 'Refactor', 'Testing', 'Review'],
    contextPreamble: 'Domain: Software Engineering. Prioritize clean modular boundaries, strong typing, comprehensive tests, and minimal regressions.'
  },

  // 2. AI / Machine Learning
  'ai-ml': {
    id: 'ai-ml',
    name: 'AI / Machine Learning',
    description: 'Data pipelines, model training, evaluation, inference servers, prompt engineering, and ML experimentation.',
    icon: '🤖',
    category: 'data_ai',
    departmentName: 'AI & ML Innovation Wing',
    departmentRoom: 'Innovation Bay B',
    badgeColor: '#9B51E0',
    leadCharacter: 'ryan',
    agentRoles: [
      {
        roleId: 'aiml-engineer',
        domainId: 'ai-ml',
        title: 'ML Engineer',
        description: 'Builds training pipelines, optimizes model architectures, and prepares production inference.',
        character: 'ryan',
        preferredProvider: 'claude',
        recommendedSkills: ['md-fetch-summarize'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['model-training', 'inference-optimization', 'data-pipeline', 'tensor-ops'],
        verificationRules: ['rule-eval-metrics', 'rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are an expert ML Engineer. Implement robust ML pipelines, verify loss convergence, and manage model weights and inference cleanly.'
        }
      },
      {
        roleId: 'aiml-data-scientist',
        domainId: 'ai-ml',
        title: 'Data Scientist',
        description: 'Performs exploratory data analysis, feature engineering, and statistical data validation.',
        character: 'pam',
        preferredProvider: 'claude',
        recommendedSkills: ['md-fetch-summarize'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Grep'],
        capabilities: ['eda', 'feature-engineering', 'data-cleaning', 'statistical-modeling'],
        verificationRules: ['rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier3_summary'],
          prioritizeTests: false,
          systemPromptPreamble: 'You are a Senior Data Scientist. Analyze data distributions, handle missing values rigorously, and extract high-signal features.'
        }
      },
      {
        roleId: 'aiml-researcher',
        domainId: 'ai-ml',
        title: 'AI Researcher',
        description: 'Designs novel model architectures, conducts ablation studies, and formulates research hypotheses.',
        character: 'toby',
        preferredProvider: 'claude',
        recommendedSkills: ['md-fetch-summarize'],
        recommendedTools: ['Read', 'Write', 'Grep'],
        capabilities: ['research', 'ablation-studies', 'architecture-design', 'literature-review'],
        verificationRules: ['rule-eval-metrics'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier3_summary'],
          prioritizeTests: false,
          systemPromptPreamble: 'You are an AI Research Scientist. Formulate hypotheses, design ablation experiments, and document methodology clearly.'
        }
      },
      {
        roleId: 'aiml-debugger',
        domainId: 'ai-ml',
        title: 'ML Debugger',
        description: 'Diagnoses training divergence, numerical instability, gradient explosion, and loss plateau issues.',
        character: 'stanley',
        preferredProvider: 'claude',
        recommendedSkills: ['md-fetch-summarize'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['loss-debugging', 'gradient-diagnostics', 'numerical-stability', 'nan-detection'],
        verificationRules: ['rule-eval-metrics'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are an ML Debugger. Pinpoint the mathematical or algorithmic cause of training instability.'
        }
      },
      {
        roleId: 'aiml-evaluator',
        domainId: 'ai-ml',
        title: 'Evaluation Agent',
        description: 'Designs evaluation benchmarks, tests accuracy, latency, calibration, and regression metrics.',
        character: 'oscar',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Bash', 'Grep', 'Write'],
        capabilities: ['evaluation', 'benchmarking', 'drift-detection', 'metric-validation'],
        verificationRules: ['rule-eval-metrics'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are an ML Evaluation Specialist. Rigorously evaluate model outputs against ground truth metrics and benchmark datasets.'
        }
      }
    ],
    specializedSkills: ['md-fetch-summarize', 'md-audit'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [
      { id: 'rule-eval-metrics', name: 'ML Metric Benchmark', type: 'custom', description: 'Run model evaluation script to verify accuracy, F1, or MSE thresholds.' },
      { id: 'rule-test-suite', name: 'Pipeline Unit Tests', type: 'test_runner', description: 'Run data and model pipeline test suite.' }
    ],
    taskCategories: ['Data Pipeline', 'Model Training', 'Evaluation', 'Inference', 'Research'],
    contextPreamble: 'Domain: AI / Machine Learning. Emphasize reproducibility, evaluation benchmarks, data validation, and numerical stability.'
  },

  // 3. Cybersecurity
  'cybersecurity': {
    id: 'cybersecurity',
    name: 'Cybersecurity',
    description: 'Vulnerability assessment, cryptographic hardening, authentication audits, penetration testing, and compliance.',
    icon: '🛡️',
    category: 'systems',
    departmentName: 'Security Operations Center',
    departmentRoom: 'Security Bunker C',
    badgeColor: '#E65100',
    leadCharacter: 'creed',
    agentRoles: [
      {
        roleId: 'sec-analyst',
        domainId: 'cybersecurity',
        title: 'Security Analyst',
        description: 'Audits codebases for CVE vulnerabilities, exposed secrets, and insecure configurations.',
        character: 'creed',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Grep', 'Glob', 'Bash'],
        capabilities: ['vulnerability-scanning', 'secret-detection', 'sast', 'threat-modeling'],
        verificationRules: ['rule-sec-audit', 'rule-secret-scan'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature', 'tier4_metadata'],
          prioritizeTests: false,
          systemPromptPreamble: 'You are a Senior Security Analyst. Inspect code for common vulnerability patterns, CWEs, leaked secrets, and misconfigurations.'
        }
      },
      {
        roleId: 'sec-coder',
        domainId: 'cybersecurity',
        title: 'Secure Coding Agent',
        description: 'Implements cryptographic protections, sanitizes input boundaries, and patches security vulnerabilities.',
        character: 'meredith',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Grep'],
        capabilities: ['crypto-hardening', 'input-sanitization', 'patching-cves', 'auth-flows'],
        verificationRules: ['rule-test-suite', 'rule-sec-scan'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Secure Coding Specialist. Apply defense-in-depth, sanitize untrusted input, and enforce zero-trust authentication.'
        }
      },
      {
        roleId: 'sec-researcher',
        domainId: 'cybersecurity',
        title: 'Security Researcher',
        description: 'Analyzes threat vectors, CVE advisories, attack surfaces, and zero-day disclosures.',
        character: 'toby',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Grep', 'Glob'],
        capabilities: ['threat-intel', 'cve-analysis', 'attack-surface-mapping', 'vulnerability-research'],
        verificationRules: ['rule-sec-scan'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier3_summary'],
          prioritizeTests: false,
          systemPromptPreamble: 'You are a Threat Intelligence Researcher. Identify emerging exploit vectors and evaluate vulnerability severity.'
        }
      },
      {
        roleId: 'sec-tester',
        domainId: 'cybersecurity',
        title: 'Testing Agent',
        description: 'Develops fuzz harnesses, boundary exploit simulations, and security validation assertions.',
        character: 'kevin',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Bash', 'Write', 'Edit'],
        capabilities: ['fuzzing', 'penetration-testing', 'boundary-payloads', 'dast'],
        verificationRules: ['rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Penetration Tester and Fuzzing Specialist. Create rigorous boundary tests and verify exploit mitigation.'
        }
      },
      {
        roleId: 'sec-doc',
        domainId: 'cybersecurity',
        title: 'Documentation Agent',
        description: 'Generates security advisories, remediation playbooks, and compliance audits.',
        character: 'phyllis',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Write', 'Glob'],
        capabilities: ['compliance-audit', 'remediation-playbooks', 'soc2-reports', 'threat-docs'],
        verificationRules: ['rule-sec-scan'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier3_summary', 'tier4_metadata'],
          prioritizeTests: false,
          systemPromptPreamble: 'You are a Security Compliance Officer. Produce clear, actionable remediation guides and threat models.'
        }
      }
    ],
    specializedSkills: ['md-audit'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [
      { id: 'rule-sec-audit', name: 'Security Vulnerability Scan', type: 'security_scan', description: 'Run automated static and dependency security scan.' },
      { id: 'rule-secret-scan', name: 'Secret & Credential Scan', type: 'security_scan', description: 'Scan for hardcoded secrets and tokens.' },
      { id: 'rule-sec-scan', name: 'Security Vulnerability Scan', type: 'security_scan', description: 'Run automated static and dependency security scan.' },
      { id: 'rule-test-suite', name: 'Security Assertion Suite', type: 'test_runner', description: 'Run automated security tests.' }
    ],
    taskCategories: ['Vulnerability Scan', 'Hardening', 'Penetration Test', 'Compliance', 'Security Patch'],
    contextPreamble: 'Domain: Cybersecurity. Prioritize least-privilege, boundary sanitization, secure secret storage, and zero-trust verification.'
  },

  // 4. Computer Vision
  'computer-vision': {
    id: 'computer-vision',
    name: 'Computer Vision',
    description: 'Image & video processing, object detection, segmentation, OCR recognition, and edge perception models.',
    icon: '👁️',
    category: 'data_ai',
    departmentName: 'Vision & Perception Lab',
    departmentRoom: 'Perception Wing',
    badgeColor: '#00897B',
    leadCharacter: 'pam',
    agentRoles: [
      {
        roleId: 'cv-scientist',
        domainId: 'computer-vision',
        title: 'Vision Scientist',
        description: 'Develops visual feature extractors, spatial transforms, and deep vision backbones.',
        character: 'pam',
        preferredProvider: 'claude',
        recommendedSkills: ['md-fetch-summarize'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['image-processing', 'spatial-transforms', 'deep-vision', 'feature-extraction'],
        verificationRules: ['rule-eval-metrics'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Computer Vision Scientist. Design robust image transformation, feature extraction, and neural vision pipelines.'
        }
      },
      {
        roleId: 'cv-engineer',
        domainId: 'computer-vision',
        title: 'CV Pipeline Engineer',
        description: 'Builds real-time video streaming, ONNX/TensorRT optimization, and OCR pipelines.',
        character: 'ryan',
        preferredProvider: 'claude',
        recommendedSkills: ['md-hive-sync'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['video-pipeline', 'ocr-recognition', 'onnx-export', 'latency-optimization'],
        verificationRules: ['rule-test-suite', 'rule-eval-metrics'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Vision Systems Engineer. Optimize inference latency, batching, and OpenCV/ONNX integration.'
        }
      },
      {
        roleId: 'cv-evaluator',
        domainId: 'computer-vision',
        title: 'Perception Evaluator',
        description: 'Evaluates mAP, IoU, bounding box accuracy, and OCR character error rates.',
        character: 'oscar',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Bash', 'Grep'],
        capabilities: ['map-evaluation', 'iou-benchmarking', 'cer-wer-metrics', 'dataset-curation'],
        verificationRules: ['rule-eval-metrics'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier3_summary'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Computer Vision Evaluator. Measure precision-recall curves, IoU, and OCR accuracy strictly.'
        }
      }
    ],
    specializedSkills: ['md-fetch-summarize', 'md-audit'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [
      { id: 'rule-eval-metrics', name: 'Vision Benchmark', type: 'custom', description: 'Run IoU/mAP/OCR benchmark evaluation script.' },
      { id: 'rule-test-suite', name: 'Vision Pipeline Tests', type: 'test_runner', description: 'Run image transformation unit tests.' }
    ],
    taskCategories: ['Image Processing', 'OCR', 'Object Detection', 'Video Pipeline', 'Evaluation'],
    contextPreamble: 'Domain: Computer Vision. Focus on pixel tensors, affine transformations, bounding box math, and GPU acceleration.'
  },

  // 5. Data Science
  'data-science': {
    id: 'data-science',
    name: 'Data Science',
    description: 'Statistical modeling, hypothesis testing, predictive regressions, clustering, and exploratory analysis.',
    icon: '📊',
    category: 'data_ai',
    departmentName: 'Statistical Research Lab',
    departmentRoom: 'Analytics Bay',
    badgeColor: '#1E88E5',
    leadCharacter: 'oscar',
    agentRoles: [
      {
        roleId: 'ds-lead',
        domainId: 'data-science',
        title: 'Principal Data Scientist',
        description: 'Formulates experimental statistical methodology and oversees mathematical modeling.',
        character: 'oscar',
        preferredProvider: 'claude',
        recommendedSkills: ['md-fetch-summarize'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Grep'],
        capabilities: ['statistical-inference', 'hypothesis-testing', 'predictive-modeling', 'eda'],
        verificationRules: ['rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier3_summary'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Principal Data Scientist. Ensure rigorous statistical validation, p-value calculations, and feature significance analysis.'
        }
      },
      {
        roleId: 'ds-analyst',
        domainId: 'data-science',
        title: 'Statistical Modeler',
        description: 'Implements generalized linear models, gradient boosting, and clustering algorithms.',
        character: 'kevin',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash'],
        capabilities: ['regression', 'clustering', 'scikit-learn', 'feature-transforms'],
        verificationRules: ['rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Statistical Modeler. Train scikit-learn/XGBoost models, tune hyperparameters, and prevent overfitting.'
        }
      }
    ],
    specializedSkills: ['md-fetch-summarize', 'md-audit'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [
      { id: 'rule-test-suite', name: 'Statistical Verification Suite', type: 'test_runner', description: 'Run pandas/numpy statistical tests.' }
    ],
    taskCategories: ['EDA', 'Feature Engineering', 'Statistical Modeling', 'Clustering', 'Validation'],
    contextPreamble: 'Domain: Data Science. Emphasize distribution modeling, cross-validation, feature normalization, and metric explainability.'
  },

  // 6. Data Analytics
  'data-analytics': {
    id: 'data-analytics',
    name: 'Data Analytics',
    description: 'SQL transformations, dashboard reporting, cohort analysis, metric tracking, and business intelligence.',
    icon: '📈',
    category: 'data_ai',
    departmentName: 'Business Intelligence Hub',
    departmentRoom: 'BI War Room',
    badgeColor: '#F57C00',
    leadCharacter: 'kevin',
    agentRoles: [
      {
        roleId: 'da-bi-lead',
        domainId: 'data-analytics',
        title: 'BI & Metrics Analyst',
        description: 'Designs executive KPIs, SQL aggregations, and dimensional data models.',
        character: 'kevin',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Grep'],
        capabilities: ['sql-analytics', 'kpi-modeling', 'cohort-analysis', 'data-aggregation'],
        verificationRules: ['rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier3_summary'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Business Intelligence Lead. Build performant SQL queries, dimensional models, and precise business metric aggregations.'
        }
      },
      {
        roleId: 'da-financial',
        domainId: 'data-analytics',
        title: 'Financial & Ledger Analyst',
        description: 'Validates ledger reconciliations, invoice accounting tables, and numerical audits.',
        character: 'angela',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Grep'],
        capabilities: ['financial-audit', 'ledger-reconciliation', 'reporting-tables', 'integrity-checks'],
        verificationRules: ['rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Financial Data Analyst. Verify decimal precision, balance reconciliations, and reporting schema integrity.'
        }
      }
    ],
    specializedSkills: ['md-audit'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [
      { id: 'rule-test-suite', name: 'Analytics Query Tests', type: 'test_runner', description: 'Run SQL query assertion and reconciliation tests.' }
    ],
    taskCategories: ['SQL Queries', 'KPI Dashboards', 'Ledger Reconciliation', 'Reporting', 'ETL Verification'],
    contextPreamble: 'Domain: Data Analytics. Focus on SQL optimization, dimensional modeling, exact numerical aggregations, and business metrics.'
  },

  // 7. DevOps / Cloud
  'devops-cloud': {
    id: 'devops-cloud',
    name: 'DevOps / Cloud',
    description: 'Docker containers, Kubernetes, Terraform IaC, GitHub Actions CI/CD, and platform observability.',
    icon: '☁️',
    category: 'systems',
    departmentName: 'Cloud Platform & Infrastructure Bay',
    departmentRoom: 'Platform Control Room',
    badgeColor: '#0288D1',
    leadCharacter: 'stanley',
    agentRoles: [
      {
        roleId: 'devops-platform',
        domainId: 'devops-cloud',
        title: 'Platform Engineer',
        description: 'Configures Docker packaging, CI/CD pipelines, Kubernetes manifests, and Terraform infrastructure.',
        character: 'stanley',
        preferredProvider: 'claude',
        recommendedSkills: ['md-hive-sync'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['docker', 'kubernetes', 'terraform', 'ci-cd', 'cloud-packaging'],
        verificationRules: ['rule-build', 'rule-linter'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier4_metadata'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Senior Platform Engineer. Write multi-stage Dockerfiles, clean CI/CD pipelines, and declarative IaC manifests.'
        }
      },
      {
        roleId: 'devops-sre',
        domainId: 'devops-cloud',
        title: 'SRE & Reliability Engineer',
        description: 'Implements health checks, logging pipelines, Prometheus metrics, and automated rollback triggers.',
        character: 'dwight',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Edit', 'Bash', 'Grep'],
        capabilities: ['monitoring', 'health-checks', 'alerting', 'sre', 'incident-automation'],
        verificationRules: ['rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Site Reliability Engineer. Build bulletproof health checks, uptime monitors, and automated failover mechanics.'
        }
      }
    ],
    specializedSkills: ['md-hive-sync', 'md-audit'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    verificationRules: [
      { id: 'rule-build', name: 'Docker / Build Verification', type: 'build', description: 'Verify build container and package compilation.' },
      { id: 'rule-linter', name: 'IaC & Config Linter', type: 'linter', description: 'Lint YAML, Dockerfile, and Terraform syntax.' }
    ],
    taskCategories: ['Docker', 'CI/CD Pipelines', 'Kubernetes', 'IaC Terraform', 'Monitoring & SRE'],
    contextPreamble: 'Domain: DevOps & Cloud. Prioritize immutable infrastructure, small container footprints, fast build caches, and high availability.'
  },

  // 8. Web & Application Development
  'web-app-dev': {
    id: 'web-app-dev',
    name: 'Web & App Development',
    description: 'React, Next.js, Vite, Vue, responsive styling, state management, and modern web applications.',
    icon: '🌐',
    category: 'engineering',
    departmentName: 'Frontend & Full-Stack Studio',
    departmentRoom: 'Design & Web Lab',
    badgeColor: '#7B1FA2',
    leadCharacter: 'jim',
    agentRoles: [
      {
        roleId: 'web-fullstack',
        domainId: 'web-app-dev',
        title: 'Full-Stack Web Engineer',
        description: 'Builds full-stack web applications with React, Node.js, REST APIs, and database persistence.',
        character: 'jim',
        preferredProvider: 'claude',
        recommendedSkills: ['md-hive-sync'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['react', 'nextjs', 'rest-api', 'state-management', 'fullstack'],
        verificationRules: ['rule-test-suite', 'rule-typecheck', 'rule-build'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Senior Full-Stack Web Engineer. Create accessible, responsive component architectures with strong typing and clean APIs.'
        }
      },
      {
        roleId: 'web-frontend',
        domainId: 'web-app-dev',
        title: 'UI / UX Developer',
        description: 'Implements pixel-perfect user interfaces, animations, CSS systems, and accessibility standards.',
        character: 'kelly',
        preferredProvider: 'claude',
        recommendedSkills: ['md-hive-sync'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Grep'],
        capabilities: ['ui-design', 'css-styling', 'component-library', 'responsive-layout'],
        verificationRules: ['rule-typecheck', 'rule-linter'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: false,
          systemPromptPreamble: 'You are a Frontend UI/UX Developer. Craft responsive, accessible, pixel-perfect interfaces with smooth micro-interactions.'
        }
      }
    ],
    specializedSkills: ['md-hive-sync', 'md-audit'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    verificationRules: [
      { id: 'rule-test-suite', name: 'Web Component Tests', type: 'test_runner', description: 'Run component and E2E test suites.' },
      { id: 'rule-typecheck', name: 'TypeScript Typecheck', type: 'typecheck', description: 'Run tsc --noEmit.' },
      { id: 'rule-build', name: 'Production Web Build', type: 'build', description: 'Run npm run build / vite build.' }
    ],
    taskCategories: ['Component Architecture', 'UI Styling', 'State Management', 'API Integration', 'Build & Bundle'],
    contextPreamble: 'Domain: Web & App Development. Prioritize responsive UX, fast hydration, semantic HTML5, and strict TypeScript types.'
  },

  // 9. Mobile Development
  'mobile-dev': {
    id: 'mobile-dev',
    name: 'Mobile Development',
    description: 'React Native, Flutter, iOS Swift, Android Kotlin, and mobile app lifecycle management.',
    icon: '📱',
    category: 'engineering',
    departmentName: 'Mobile & Device Studio',
    departmentRoom: 'Mobile Lab',
    badgeColor: '#388E3C',
    leadCharacter: 'andy',
    agentRoles: [
      {
        roleId: 'mobile-native',
        domainId: 'mobile-dev',
        title: 'Cross-Platform Mobile Engineer',
        description: 'Builds mobile apps for iOS and Android using React Native, Flutter, and native bridge modules.',
        character: 'andy',
        preferredProvider: 'claude',
        recommendedSkills: ['md-hive-sync'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['react-native', 'flutter', 'mobile-navigation', 'offline-storage'],
        verificationRules: ['rule-test-suite', 'rule-typecheck'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Cross-Platform Mobile Engineer. Build smooth 60fps mobile interfaces with native bridge integrations.'
        }
      }
    ],
    specializedSkills: ['md-hive-sync'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [
      { id: 'rule-test-suite', name: 'Mobile Unit Tests', type: 'test_runner', description: 'Run Jest / mobile test suites.' },
      { id: 'rule-typecheck', name: 'Type Check', type: 'typecheck', description: 'Run typechecker on mobile codebase.' }
    ],
    taskCategories: ['Mobile UI', 'Native Bridges', 'Offline Storage', 'App Navigation', 'Packaging'],
    contextPreamble: 'Domain: Mobile Development. Focus on touch responsiveness, battery efficiency, offline caching, and native permissions.'
  },

  // 10. Robotics / IoT
  'robotics-iot': {
    id: 'robotics-iot',
    name: 'Robotics / IoT',
    description: 'ROS2 nodes, sensor drivers, embedded telemetry, microcontroller logic, and actuator controls.',
    icon: '🤖',
    category: 'applied',
    departmentName: 'Robotics & Hardware Bay',
    departmentRoom: 'Hardware Workshop',
    badgeColor: '#C2185B',
    leadCharacter: 'dwight',
    agentRoles: [
      {
        roleId: 'robotics-lead',
        domainId: 'robotics-iot',
        title: 'Robotics Systems Lead',
        description: 'Implements ROS2 nodes, kinematics algorithms, sensor fusion, and actuator communication.',
        character: 'dwight',
        preferredProvider: 'claude',
        recommendedSkills: ['md-audit'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['ros2', 'sensor-fusion', 'kinematics', 'telemetry-drivers'],
        verificationRules: ['rule-test-suite', 'rule-build'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Robotics & IoT Systems Engineer. Write deterministic, real-time sensor processing and ROS2 message handlers.'
        }
      }
    ],
    specializedSkills: ['md-audit'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [
      { id: 'rule-test-suite', name: 'Robotics Logic Tests', type: 'test_runner', description: 'Run kinematics and driver unit tests.' },
      { id: 'rule-build', name: 'Robotics Build', type: 'build', description: 'Build ROS2 / embedded package.' }
    ],
    taskCategories: ['ROS2 Nodes', 'Sensor Drivers', 'Kinematics', 'Telemetry', 'Hardware Loop'],
    contextPreamble: 'Domain: Robotics / IoT. Prioritize real-time constraints, deterministic serialization, and sensor reliability.'
  },

  // 11. Game Development
  'game-dev': {
    id: 'game-dev',
    name: 'Game Development',
    description: '2D/3D game engines, sprite animation, physics systems, gameplay scripting, and interactive state.',
    icon: '🎮',
    category: 'creative',
    departmentName: 'Game Studio & Workshop',
    departmentRoom: 'Interactive Arcade',
    badgeColor: '#512DA8',
    leadCharacter: 'jim',
    agentRoles: [
      {
        roleId: 'game-engineer',
        domainId: 'game-dev',
        title: 'Game Systems Engineer',
        description: 'Implements entity-component systems, sprite animation loops, collision detection, and gameplay logic.',
        character: 'jim',
        preferredProvider: 'claude',
        recommendedSkills: ['md-hive-sync'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['ecs', 'physics-collision', 'gameloop', 'sprite-animation', 'gameplay-scripting'],
        verificationRules: ['rule-test-suite', 'rule-build'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier2_signature'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Game Systems Engineer. Build responsive gameplay mechanics, collision math, and clean state machines.'
        }
      }
    ],
    specializedSkills: ['md-hive-sync'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [
      { id: 'rule-test-suite', name: 'Game Logic Tests', type: 'test_runner', description: 'Run physics, collision, and state machine tests.' },
      { id: 'rule-build', name: 'Game Engine Build', type: 'build', description: 'Compile game assets and executable bundle.' }
    ],
    taskCategories: ['Game Loop', 'Physics & Collision', 'Entity Component System', 'Asset Pipeline', 'Audio & UI'],
    contextPreamble: 'Domain: Game Development. Emphasize fixed-timestep physics, memory efficiency, smooth rendering, and deterministic state.'
  },

  // 12. Research / Scientific Computing
  'research-scientific': {
    id: 'research-scientific',
    name: 'Research / Scientific',
    description: 'Numerical simulations, differential equations, scientific libraries, and academic paper codebases.',
    icon: '🔬',
    category: 'data_ai',
    departmentName: 'Scientific Simulation Center',
    departmentRoom: 'Research Observatory',
    badgeColor: '#303F9F',
    leadCharacter: 'michael',
    agentRoles: [
      {
        roleId: 'research-director',
        domainId: 'research-scientific',
        title: 'Scientific Computing Lead',
        description: 'Formulates mathematical simulations, numerical algorithms, and high-performance scientific models.',
        character: 'michael',
        preferredProvider: 'claude',
        recommendedSkills: ['md-fetch-summarize'],
        recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
        capabilities: ['numerical-simulation', 'differential-equations', 'matrix-solvers', 'scientific-computing'],
        verificationRules: ['rule-test-suite'],
        contextStrategy: {
          defaultBudgetTokens: 32000,
          focusTiers: ['tier1_full', 'tier3_summary'],
          prioritizeTests: true,
          systemPromptPreamble: 'You are a Scientific Computing Director. Implement accurate numerical solvers, matrix algorithms, and simulation models.'
        }
      }
    ],
    specializedSkills: ['md-fetch-summarize'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [
      { id: 'rule-test-suite', name: 'Scientific Accuracy Tests', type: 'test_runner', description: 'Run convergence and numerical accuracy tests.' }
    ],
    taskCategories: ['Numerical Solvers', 'Simulations', 'Matrix Math', 'Scientific Data', 'Ablation Tests'],
    contextPreamble: 'Domain: Research / Scientific Computing. Focus on numerical convergence, floating-point precision, and mathematical rigor.'
  },

  // Prepared Future Domains (13-16)
  'embedded-systems': {
    id: 'embedded-systems',
    name: 'Embedded Systems',
    description: 'C/C++ firmware, bare-metal microcontrollers, RTOS drivers, and low-power hardware logic.',
    icon: '⚡',
    category: 'applied',
    departmentName: 'Embedded Firmware Lab',
    departmentRoom: 'Hardware Bench D',
    badgeColor: '#455A64',
    leadCharacter: 'creed',
    agentRoles: [],
    specializedSkills: ['md-audit'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [{ id: 'rule-build', name: 'Firmware Build', type: 'build', description: 'Compile embedded binary.' }],
    taskCategories: ['Firmware', 'RTOS', 'Device Drivers'],
    contextPreamble: 'Domain: Embedded Systems. Prioritize low memory footprint, deterministic interrupts, and register-level correctness.'
  },
  'automation-rpa': {
    id: 'automation-rpa',
    name: 'Automation / RPA',
    description: 'Headless browser automation, scraping pipelines, scheduled workflows, and robotic process scripts.',
    icon: '⚙️',
    category: 'applied',
    departmentName: 'Process Automation Bureau',
    departmentRoom: 'Automation Station',
    badgeColor: '#5D4037',
    leadCharacter: 'dwight',
    agentRoles: [],
    specializedSkills: ['md-hive-sync'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [{ id: 'rule-test-suite', name: 'Workflow Tests', type: 'test_runner', description: 'Verify scraper and automation tasks.' }],
    taskCategories: ['Browser Automation', 'Workflow Scripts', 'ETL Automation'],
    contextPreamble: 'Domain: Automation / RPA. Focus on resilient element selectors, retries, and idempotent workflows.'
  },
  'blockchain-web3': {
    id: 'blockchain-web3',
    name: 'Blockchain / Web3',
    description: 'Smart contracts, cryptographic proofs, decentralized protocols, and EVM contract verification.',
    icon: '⛓️',
    category: 'applied',
    departmentName: 'Cryptographic Protocol Wing',
    departmentRoom: 'Protocol Bay',
    badgeColor: '#D84315',
    leadCharacter: 'creed',
    agentRoles: [],
    specializedSkills: ['md-audit'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [{ id: 'rule-sec-scan', name: 'Smart Contract Audit', type: 'security_scan', description: 'Run static contract vulnerability checks.' }],
    taskCategories: ['Smart Contracts', 'Crypto Proofs', 'DeFi Protocols'],
    contextPreamble: 'Domain: Blockchain / Web3. Emphasize reentrancy protection, gas optimization, and formal verification.'
  },
  'gis-geospatial': {
    id: 'gis-geospatial',
    name: 'GIS / Geospatial',
    description: 'GeoJSON vector math, spatial indexing, raster maps, projection transforms, and GIS analytics.',
    icon: '🗺️',
    category: 'applied',
    departmentName: 'Geospatial Intelligence Lab',
    departmentRoom: 'Cartography Room',
    badgeColor: '#2E7D32',
    leadCharacter: 'pam',
    agentRoles: [],
    specializedSkills: ['md-fetch-summarize'],
    recommendedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    verificationRules: [{ id: 'rule-test-suite', name: 'Spatial Assertion Suite', type: 'test_runner', description: 'Run geometry and projection tests.' }],
    taskCategories: ['Spatial Indexing', 'Raster Processing', 'Map Projections'],
    contextPreamble: 'Domain: GIS / Geospatial. Focus on coordinate reference systems, bounding polygon math, and spatial joins.'
  }
};

export function getDomainDefinition(domainId: string): DomainDefinition {
  return INITIAL_DOMAINS[domainId as DomainId] || INITIAL_DOMAINS['software-engineering'];
}

export function listDomainDefinitions(): DomainDefinition[] {
  return Object.values(INITIAL_DOMAINS);
}

export function listDomainRoles(domainId?: string): DomainAgentRole[] {
  if (domainId) {
    return getRolesForDomain(domainId);
  }
  const roles: DomainAgentRole[] = [];
  for (const domain of Object.values(INITIAL_DOMAINS)) {
    roles.push(...domain.agentRoles);
  }
  return roles;
}

export function getRolesForDomain(domainId: string): DomainAgentRole[] {
  const domain = getDomainDefinition(domainId);
  return domain.agentRoles;
}

export function getDomainRole(roleId: string): DomainAgentRole | null {
  for (const domain of Object.values(INITIAL_DOMAINS)) {
    const role = domain.agentRoles.find((r) => r.roleId === roleId);
    if (role) return role;
  }
  return null;
}

export function suggestRoleForTask(task: string, domainId: DomainId): DomainAgentRole {
  const domain = getDomainDefinition(domainId);
  const taskLower = task.toLowerCase();

  if (domainId === 'software-engineering') {
    if (taskLower.includes('plan') || taskLower.includes('break') || taskLower.includes('architect')) {
      return domain.agentRoles.find((r) => r.roleId === 'sde-planner') || domain.agentRoles[0];
    }
    if (taskLower.includes('test') || taskLower.includes('qa') || taskLower.includes('assert')) {
      return domain.agentRoles.find((r) => r.roleId === 'sde-tester') || domain.agentRoles[0];
    }
    if (taskLower.includes('fix') || taskLower.includes('debug') || taskLower.includes('bug') || taskLower.includes('error')) {
      return domain.agentRoles.find((r) => r.roleId === 'sde-debugger') || domain.agentRoles[0];
    }
    if (taskLower.includes('review') || taskLower.includes('audit') || taskLower.includes('lint')) {
      return domain.agentRoles.find((r) => r.roleId === 'sde-reviewer') || domain.agentRoles[0];
    }
    return domain.agentRoles.find((r) => r.roleId === 'sde-engineer') || domain.agentRoles[0];
  }

  if (domainId === 'ai-ml') {
    if (taskLower.includes('data') || taskLower.includes('eda') || taskLower.includes('feature')) {
      return domain.agentRoles.find((r) => r.roleId === 'aiml-data-scientist') || domain.agentRoles[0];
    }
    if (taskLower.includes('eval') || taskLower.includes('benchmark') || taskLower.includes('metric')) {
      return domain.agentRoles.find((r) => r.roleId === 'aiml-evaluator') || domain.agentRoles[0];
    }
    if (taskLower.includes('debug') || taskLower.includes('nan') || taskLower.includes('diverg')) {
      return domain.agentRoles.find((r) => r.roleId === 'aiml-debugger') || domain.agentRoles[0];
    }
    if (taskLower.includes('research') || taskLower.includes('paper') || taskLower.includes('ablat')) {
      return domain.agentRoles.find((r) => r.roleId === 'aiml-researcher') || domain.agentRoles[0];
    }
    return domain.agentRoles.find((r) => r.roleId === 'aiml-engineer') || domain.agentRoles[0];
  }

  if (domainId === 'cybersecurity') {
    if (taskLower.includes('scan') || taskLower.includes('vulnerab') || taskLower.includes('secret')) {
      return domain.agentRoles.find((r) => r.roleId === 'sec-analyst') || domain.agentRoles[0];
    }
    if (taskLower.includes('harden') || taskLower.includes('sanitize') || taskLower.includes('auth')) {
      return domain.agentRoles.find((r) => r.roleId === 'sec-coder') || domain.agentRoles[0];
    }
    if (taskLower.includes('research') || taskLower.includes('cve') || taskLower.includes('intel')) {
      return domain.agentRoles.find((r) => r.roleId === 'sec-researcher') || domain.agentRoles[0];
    }
    if (taskLower.includes('test') || taskLower.includes('fuzz') || taskLower.includes('pentest')) {
      return domain.agentRoles.find((r) => r.roleId === 'sec-tester') || domain.agentRoles[0];
    }
    if (taskLower.includes('doc') || taskLower.includes('report') || taskLower.includes('compliance')) {
      return domain.agentRoles.find((r) => r.roleId === 'sec-doc') || domain.agentRoles[0];
    }
    return domain.agentRoles.find((r) => r.roleId === 'sec-analyst') || domain.agentRoles[0];
  }

  // Look for direct role match
  for (const role of domain.agentRoles) {
    if (role.capabilities.some((c) => taskLower.includes(c.toLowerCase()))) {
      return role;
    }
  }

  return domain.agentRoles[0] || INITIAL_DOMAINS['software-engineering'].agentRoles[1];
}
