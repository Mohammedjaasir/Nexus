/**
 * Deterministic Project Analyzer for Nexus.
 *
 * Fast, offline local heuristics scanner that inspects project files, dependencies,
 * frameworks, tests, documentation, and Git status WITHOUT sending code to an LLM.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, extname, relative, resolve } from 'node:path';
import { safeJoin } from '../fs';
import { getBranch, getStatus, getLog, isRepo } from '../git';
import type {
  ProjectDependency,
  ProjectHealthMetrics,
  ProjectLanguageStat,
  ProjectScanResult,
  ProjectTestSuite,
  ProjectType
} from '../../shared/project';
import type { DomainId } from '../../shared/domain';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'target',
  'bin',
  'obj',
  'vendor',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.idea',
  '.vscode',
  '.turbo',
  'coverage',
  '.cache'
]);

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript (React)',
  js: 'JavaScript',
  jsx: 'JavaScript (React)',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  kt: 'Kotlin',
  cpp: 'C++',
  c: 'C',
  h: 'C/C++ Header',
  hpp: 'C++ Header',
  cs: 'C#',
  php: 'PHP',
  rb: 'Ruby',
  swift: 'Swift',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sql: 'SQL',
  sh: 'Shell',
  ps1: 'PowerShell',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  md: 'Markdown',
  ipynb: 'Jupyter Notebook'
};

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go',
  'java', 'kt', 'cpp', 'c', 'h', 'hpp', 'cs', 'php', 'rb', 'swift', 'ipynb'
]);

const ML_KEYWORDS = new Set([
  'torch', 'pytorch', 'tensorflow', 'keras', 'transformers', 'huggingface',
  'scikit-learn', 'sklearn', 'opencv', 'cv2', 'diffusers', 'accelerate',
  'timm', 'spacy', 'nltk', 'torchvision', 'torchaudio', 'langchain',
  'llama-index', 'ollama', 'vllm', 'bitsandbytes', 'safetensors', 'onnx',
  'datasets', 'optuna', 'wandb', 'pandas', 'numpy', 'scipy', 'polars'
]);

const SECURITY_KEYWORDS = new Set([
  'scapy', 'pyshark', 'yara', 'volatility', 'cryptography', 'paramiko',
  'bandit', 'semgrep', 'trivy', 'snyk', 'owasp', 'metasploit', 'nmap',
  'burp', 'zap', 'security', 'audit', 'cve', 'vulnerability', 'exploit'
]);

export interface ScanOptions {
  maxDepth?: number;
  maxFiles?: number;
}

export async function analyzeProject(rootPath: string, options: ScanOptions = {}): Promise<ProjectScanResult> {
  const root = resolve(rootPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Directory not found: ${root}`);
  }

  const maxDepth = options.maxDepth ?? 5;
  const maxFiles = options.maxFiles ?? 2000;

  const extCounts: Record<string, number> = {};
  const allFiles: string[] = [];
  const importantFiles: string[] = [];
  const documentationFiles: string[] = [];
  const testFiles: string[] = [];
  const entryPoints: string[] = [];
  const frameworksSet = new Set<string>();
  const dependencies: ProjectDependency[] = [];
  const testSuites: ProjectTestSuite[] = [];

  // 1. Walk directory tree
  function walk(currentDir: string, currentDepth: number) {
    if (currentDepth > maxDepth || allFiles.length >= maxFiles) return;

    let entries: string[] = [];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;

      const fullPath = join(currentDir, entry);
      const relPath = relative(root, fullPath).replace(/\\/g, '/');

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, currentDepth + 1);
      } else if (stat.isFile()) {
        allFiles.push(relPath);
        const ext = extname(entry).replace(/^\./, '').toLowerCase();

        if (ext) {
          extCounts[ext] = (extCounts[ext] || 0) + 1;
        }

        // Test file detection
        if (
          entry.includes('.test.') ||
          entry.includes('.spec.') ||
          entry.startsWith('test_') ||
          entry.endsWith('_test.go') ||
          entry.endsWith('_test.rs') ||
          relPath.startsWith('test/') ||
          relPath.startsWith('tests/') ||
          relPath.startsWith('__tests__/')
        ) {
          testFiles.push(relPath);
        }

        // Documentation detection
        if (
          /^readme(\.md|\.txt)?$/i.test(entry) ||
          /^contributing(\.md)?$/i.test(entry) ||
          /^spec(\.md)?$/i.test(entry) ||
          /^design(\.md)?$/i.test(entry) ||
          relPath.startsWith('docs/')
        ) {
          documentationFiles.push(relPath);
        }

        // Important config detection
        if (
          /^(package\.json|tsconfig.*\.json|cargo\.toml|pyproject\.toml|requirements.*\.txt|go\.mod|pom\.xml|build\.gradle|dockerfile|docker-compose.*\.ya?ml|makefile|vite\.config.*|webpack\.config.*|jest\.config.*|vitest\.config.*)$/i.test(
            entry
          )
        ) {
          importantFiles.push(relPath);
        }
      }
    }
  }

  walk(root, 0);

  // 2. Language Statistics
  const languages: ProjectLanguageStat[] = Object.entries(extCounts)
    .filter(([ext]) => CODE_EXTS.has(ext))
    .map(([ext, count]) => ({
      language: LANGUAGE_EXTENSIONS[ext] || ext.toUpperCase(),
      fileCount: count,
      extension: ext
    }))
    .sort((a, b) => b.fileCount - a.fileCount);

  // 3. Package & Manifest Inspection
  let projectType: ProjectType = 'application';
  let manifestName: string | undefined = undefined;

  // Node.js (package.json)
  const pkgPath = safeJoin(root, 'package.json');
  if (pkgPath && existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.name === 'string' && pkg.name.trim()) manifestName = pkg.name.trim();
      if (pkg.main) entryPoints.push(pkg.main);
      if (pkg.module) entryPoints.push(pkg.module);
      if (pkg.bin) {
        if (typeof pkg.bin === 'string') entryPoints.push(pkg.bin);
        else if (typeof pkg.bin === 'object') entryPoints.push(...Object.values(pkg.bin as Record<string, string>));
        projectType = 'cli';
      }

      if (pkg.dependencies && typeof pkg.dependencies === 'object') {
        for (const [name, ver] of Object.entries(pkg.dependencies)) {
          dependencies.push({ name, version: String(ver), type: 'production' });
          checkNodeFramework(name, frameworksSet);
        }
      }
      if (pkg.devDependencies && typeof pkg.devDependencies === 'object') {
        for (const [name, ver] of Object.entries(pkg.devDependencies)) {
          dependencies.push({ name, version: String(ver), type: 'development' });
          checkNodeFramework(name, frameworksSet);
          checkNodeTestFramework(name, pkgPath, testSuites);
        }
      }

      if (pkg.scripts && typeof pkg.scripts === 'object') {
        if (pkg.scripts.test) {
          testSuites.push({
            framework: 'npm test',
            testCommand: 'npm test'
          });
        }
      }
    } catch {
      // best-effort
    }
  }

  // Python (pyproject.toml / requirements.txt / setup.py)
  const reqPath = safeJoin(root, 'requirements.txt');
  if (reqPath && existsSync(reqPath)) {
    try {
      const lines = readFileSync(reqPath, 'utf8').split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const match = /^([a-zA-Z0-9_\-.]+)(?:[>=<~!]+(.*))?/.exec(line);
        if (match) {
          const name = match[1].toLowerCase();
          const version = match[2]?.trim();
          dependencies.push({ name, version, type: 'production' });
          checkPythonFramework(name, frameworksSet);
        }
      }
    } catch {
      // best-effort
    }
  }

  const pyprojPath = safeJoin(root, 'pyproject.toml');
  if (pyprojPath && existsSync(pyprojPath)) {
    try {
      const content = readFileSync(pyprojPath, 'utf8');
      if (/pytest/i.test(content)) {
        testSuites.push({ framework: 'pytest', testCommand: 'pytest' });
      }
      for (const kw of ML_KEYWORDS) {
        if (content.toLowerCase().includes(kw)) {
          frameworksSet.add(kw);
        }
      }
    } catch {
      // best-effort
    }
  }

  // Rust (Cargo.toml)
  const cargoPath = safeJoin(root, 'Cargo.toml');
  if (cargoPath && existsSync(cargoPath)) {
    try {
      const content = readFileSync(cargoPath, 'utf8');
      if (/\[lib\]/i.test(content)) projectType = 'library';
      if (/\[\[bin\]\]/i.test(content) || existsSync(join(root, 'src', 'main.rs'))) projectType = 'cli';
      frameworksSet.add('Rust / Cargo');
      testSuites.push({ framework: 'cargo test', testCommand: 'cargo test' });
    } catch {
      // best-effort
    }
  }

  // Go (go.mod)
  const goModPath = safeJoin(root, 'go.mod');
  if (goModPath && existsSync(goModPath)) {
    frameworksSet.add('Go Modules');
    testSuites.push({ framework: 'go test', testCommand: 'go test ./...' });
  }

  // Standard Entry Point candidates
  const standardEntryPoints = [
    'src/index.ts',
    'src/main.ts',
    'src/App.tsx',
    'src/index.js',
    'src/main.js',
    'index.js',
    'main.py',
    'app.py',
    'src/main.py',
    'src/main.rs',
    'main.go',
    'cmd/main.go'
  ];
  for (const sep of standardEntryPoints) {
    if (allFiles.includes(sep) && !entryPoints.includes(sep)) {
      entryPoints.push(sep);
    }
  }

  // 4. Git Metadata
  let gitInfo: ProjectScanResult['gitInfo'] = undefined;
  const isGit = await isRepo(root);
  if (isGit) {
    const branchRes = await getBranch(root);
    const statusRes = await getStatus(root);
    const logRes = await getLog(root, 1);

    const isClean =
      'staged' in statusRes
        ? statusRes.staged.length === 0 && statusRes.unstaged.length === 0 && statusRes.untracked.length === 0
        : false;

    gitInfo = {
      isRepo: true,
      branch: 'current' in branchRes ? branchRes.current : null,
      isClean,
      lastCommit:
        Array.isArray(logRes) && logRes[0]
          ? {
              sha: logRes[0].sha,
              message: logRes[0].subject,
              author: logRes[0].author,
              time: logRes[0].time
            }
          : undefined
    };
  }

  // 5. Domain Inference (Primary & Secondary)
  let mlScore = 0;
  let secScore = 0;
  let sdeScore = 2; // base score for general software development

  for (const dep of dependencies) {
    const dname = dep.name.toLowerCase();
    if (ML_KEYWORDS.has(dname)) mlScore += 3;
    if (SECURITY_KEYWORDS.has(dname)) secScore += 3;
  }
  for (const fw of frameworksSet) {
    const fname = fw.toLowerCase();
    if (ML_KEYWORDS.has(fname)) mlScore += 3;
    if (SECURITY_KEYWORDS.has(fname)) secScore += 3;
  }
  if (extCounts.ipynb) mlScore += extCounts.ipynb * 2;

  let primaryDomain: DomainId = 'software-engineering';
  const secondaryDomains: DomainId[] = [];

  if (mlScore >= 3 && mlScore >= secScore) {
    primaryDomain = 'ai-ml';
    if (extCounts.ipynb && !entryPoints.length) {
      projectType = 'notebook_pipeline';
    }
    secondaryDomains.push('software-engineering');
    if (secScore >= 2) secondaryDomains.push('cybersecurity');
  } else if (secScore >= 3 && secScore > mlScore) {
    primaryDomain = 'cybersecurity';
    secondaryDomains.push('software-engineering');
    if (mlScore >= 2) secondaryDomains.push('ai-ml');
  } else {
    primaryDomain = 'software-engineering';
    if (mlScore >= 2) secondaryDomains.push('ai-ml');
    if (secScore >= 2) secondaryDomains.push('cybersecurity');
  }

  // Deduplicate test suites
  const uniqueTestSuites: ProjectTestSuite[] = [];
  const seenFws = new Set<string>();
  for (const ts of testSuites) {
    if (!seenFws.has(ts.framework)) {
      seenFws.add(ts.framework);
      uniqueTestSuites.push(ts);
    }
  }

  // 6. Health Metrics Calculation
  let healthScore = 40; // baseline
  const hasTests = uniqueTestSuites.length > 0 || testFiles.length > 0;
  const hasDocs = documentationFiles.length > 0;
  const hasEntry = entryPoints.length > 0;
  const isClean = gitInfo?.isClean ?? false;

  if (hasTests) healthScore += 20;
  if (hasDocs) healthScore += 15;
  if (hasEntry) healthScore += 10;
  if (isGit) healthScore += 5;
  if (isClean) healthScore += 10;
  healthScore = Math.min(100, healthScore);

  const health: ProjectHealthMetrics = {
    healthScore,
    hasTests,
    hasDocumentation: hasDocs,
    hasEntryPoints: hasEntry,
    hasGit: isGit,
    gitClean: isClean,
    dependencyCount: dependencies.length
  };

  const topLang = languages[0]?.language || 'Generic';
  const summary = `${topLang} ${projectType} project with ${dependencies.length} dependencies, ${uniqueTestSuites.length} test suite(s), and ${documentationFiles.length} doc file(s).`;

  return {
    rootPath: root,
    suggestedName: manifestName || basename(root),
    suggestedDomainId: primaryDomain,
    primaryDomain,
    secondaryDomains,
    projectType,
    languages,
    frameworks: Array.from(frameworksSet),
    dependencies,
    entryPoints,
    importantFiles,
    testSuites: uniqueTestSuites,
    documentationFiles,
    gitInfo,
    health,
    summary
  };
}

function checkNodeFramework(name: string, set: Set<string>): void {
  const n = name.toLowerCase();
  if (n === 'react' || n === 'react-dom') set.add('React');
  else if (n === 'next') set.add('Next.js');
  else if (n === 'vue') set.add('Vue');
  else if (n === 'express') set.add('Express');
  else if (n === 'electron') set.add('Electron');
  else if (n === 'vite') set.add('Vite');
  else if (n === '@nestjs/core') set.add('NestJS');
  else if (n === 'fastify') set.add('Fastify');
  else if (n === 'svelte') set.add('Svelte');
  else if (ML_KEYWORDS.has(n)) set.add(name);
}

function checkNodeTestFramework(name: string, pkgPath: string, testSuites: ProjectTestSuite[]): void {
  const n = name.toLowerCase();
  if (n === 'jest' || n === 'ts-jest') {
    testSuites.push({ framework: 'Jest', configPath: pkgPath, testCommand: 'npm test' });
  } else if (n === 'vitest') {
    testSuites.push({ framework: 'Vitest', testCommand: 'npx vitest run' });
  } else if (n === 'mocha') {
    testSuites.push({ framework: 'Mocha', testCommand: 'npx mocha' });
  }
}

function checkPythonFramework(name: string, set: Set<string>): void {
  const n = name.toLowerCase();
  if (n === 'fastapi') set.add('FastAPI');
  else if (n === 'django') set.add('Django');
  else if (n === 'flask') set.add('Flask');
  else if (n === 'torch' || n === 'pytorch') set.add('PyTorch');
  else if (n === 'tensorflow') set.add('TensorFlow');
  else if (n === 'transformers') set.add('HuggingFace Transformers');
  else if (n === 'scikit-learn' || n === 'sklearn') set.add('Scikit-Learn');
  else if (ML_KEYWORDS.has(n)) set.add(name);
}
