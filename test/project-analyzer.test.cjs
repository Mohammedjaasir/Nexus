'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { analyzeProject } = loadTs('src/main/project/projectAnalyzer.ts');

function makeTmpDir(prefix = 'proj-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('analyzeProject scans Node.js software engineering repo accurately', async () => {
  const dir = makeTmpDir('sde-');
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        main: 'src/index.ts',
        dependencies: {
          react: '^18.0.0',
          express: '^4.18.0'
        },
        devDependencies: {
          jest: '^29.0.0',
          typescript: '^5.0.0'
        },
        scripts: {
          test: 'jest'
        }
      })
    );
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'console.log("hello");');
    fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), 'export const App = () => null;');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test App\nDocs here.');
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests', 'app.test.ts'), 'test("ok", () => {});');

    const result = await analyzeProject(dir);

    assert.equal(result.suggestedName, 'test-app');
    assert.equal(result.suggestedDomainId, 'software-engineering');
    assert.equal(result.primaryDomain, 'software-engineering');
    assert.ok(Array.isArray(result.secondaryDomains));
    assert.equal(result.projectType, 'application');
    assert.ok(result.frameworks.includes('React'));
    assert.ok(result.frameworks.includes('Express'));
    assert.equal(result.dependencies.length, 4);
    assert.ok(result.entryPoints.includes('src/index.ts'));
    assert.ok(result.documentationFiles.includes('README.md'));
    assert.ok(result.testSuites.length >= 1);
    assert.ok(result.health.healthScore >= 70);
    assert.equal(result.health.hasTests, true);
    assert.equal(result.health.hasDocumentation, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeProject detects AI/ML Python repository', async () => {
  const dir = makeTmpDir('aiml-');
  try {
    fs.writeFileSync(
      path.join(dir, 'requirements.txt'),
      ['torch>=2.0.0', 'transformers>=4.30.0', 'scikit-learn', 'pandas', 'pytest'].join('\n')
    );
    fs.writeFileSync(path.join(dir, 'train.py'), 'import torch\nprint("training")');
    fs.writeFileSync(path.join(dir, 'eval.ipynb'), '{"cells": []}');
    fs.writeFileSync(path.join(dir, 'README.md'), '# ML Project');

    const result = await analyzeProject(dir);

    assert.equal(result.suggestedDomainId, 'ai-ml');
    assert.ok(result.frameworks.includes('torch') || result.frameworks.includes('PyTorch'));
    assert.ok(result.dependencies.some((d) => d.name === 'torch'));
    assert.ok(result.dependencies.some((d) => d.name === 'transformers'));
    assert.ok(result.languages.some((l) => l.language === 'Python'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeProject detects Cybersecurity repository', async () => {
  const dir = makeTmpDir('sec-');
  try {
    fs.writeFileSync(
      path.join(dir, 'requirements.txt'),
      ['scapy>=2.5.0', 'yara-python', 'bandit', 'cryptography'].join('\n')
    );
    fs.writeFileSync(path.join(dir, 'audit.py'), 'import yara\nprint("audit")');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Security Toolkit');

    const result = await analyzeProject(dir);

    assert.equal(result.suggestedDomainId, 'cybersecurity');
    assert.ok(result.dependencies.some((d) => d.name === 'scapy'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeProject runs deterministically on current workspace', async () => {
  const result = await analyzeProject(process.cwd());
  assert.equal(result.suggestedDomainId, 'software-engineering');
  assert.ok(result.languages.length > 0);
  assert.ok(result.dependencies.length > 0);
  assert.ok(result.importantFiles.length > 0);
  assert.ok(result.health.healthScore > 50);
});
