'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

class InMemoryProjectStore {
  constructor() {
    this.projects = new Map();
    this.activeId = null;
  }
  open() {}
  close() {}
  saveProject(project) {
    this.projects.set(project.id, { ...project, updatedAt: Date.now() });
  }
  getProject(id) {
    return this.projects.get(id) || null;
  }
  listProjects() {
    return Array.from(this.projects.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  updateProject(id, patch) {
    const existing = this.getProject(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id, updatedAt: Date.now() };
    this.saveProject(updated);
    return updated;
  }
  deleteProject(id) {
    const existed = this.projects.delete(id);
    if (this.activeId === id) this.activeId = null;
    return existed;
  }
  getActiveProjectId() {
    return this.activeId;
  }
  setActiveProjectId(id) {
    this.activeId = id;
  }
}

const { ProjectManager } = loadTs('src/main/project/projectManager.ts');

function makeTmpDir(prefix = 'proj-mgr-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Import project + 2. Project summary data', async () => {
  const projectDir = makeTmpDir('import-summary-');
  try {
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'sample-service',
        version: '1.2.0',
        dependencies: { express: '^4.18.2' },
        devDependencies: { mocha: '^10.0.0' }
      })
    );
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'server.js'), 'console.log("server");');
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Sample Service\nAPI docs.');

    const store = new InMemoryProjectStore();
    const manager = new ProjectManager(store);

    const { project, scanResult } = await manager.importProject(projectDir);

    // Assert Project fields
    assert.ok(project.id.startsWith('proj_'));
    assert.equal(project.name, 'sample-service');
    assert.equal(project.rootPath, path.resolve(projectDir));
    assert.equal(project.domainId, 'software-engineering');
    assert.equal(project.projectType, 'application');
    assert.ok(project.detectedLanguages.some((l) => l.language.includes('JavaScript')));
    assert.ok(project.frameworks.includes('Express'));
    assert.equal(project.dependencies.length, 2);
    assert.ok(project.documentationFiles.includes('README.md'));
    assert.ok(project.health.healthScore >= 50);

    // Assert ScanResult summary
    assert.ok(scanResult.summary.includes('project'));
    assert.equal(scanResult.primaryDomain, 'software-engineering');
    assert.ok(Array.isArray(scanResult.secondaryDomains));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('3. Primary + secondary domain handling', async () => {
  const projectDir = makeTmpDir('multi-domain-');
  try {
    // Has both PyTorch (ML) and Cryptography / Scapy (Sec)
    fs.writeFileSync(
      path.join(projectDir, 'requirements.txt'),
      ['torch>=2.0.0', 'transformers', 'scapy', 'cryptography'].join('\n')
    );
    fs.writeFileSync(path.join(projectDir, 'main.py'), 'print("model & sec")');

    const store = new InMemoryProjectStore();
    const manager = new ProjectManager(store);

    const { project, scanResult } = await manager.importProject(projectDir);

    // ML score: 6, Sec score: 6 -> ML >= Sec -> primary is ai-ml
    assert.equal(project.domainId, 'ai-ml');
    assert.equal(scanResult.primaryDomain, 'ai-ml');
    // Secondary domains should include software-engineering and cybersecurity
    assert.ok(project.secondaryDomains?.includes('software-engineering'));
    assert.ok(project.secondaryDomains?.includes('cybersecurity'));
    assert.ok(scanResult.secondaryDomains.includes('cybersecurity'));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('4. Domain override during import and update', async () => {
  const projectDir = makeTmpDir('override-');
  try {
    fs.writeFileSync(
      path.join(projectDir, 'requirements.txt'),
      ['torch'].join('\n')
    );
    fs.writeFileSync(path.join(projectDir, 'app.py'), 'print("hi")');

    const store = new InMemoryProjectStore();
    const manager = new ProjectManager(store);

    // Import with manual domain override to 'cybersecurity'
    const { project } = await manager.importProject(projectDir, 'cybersecurity', 'Custom Security Model');
    assert.equal(project.name, 'Custom Security Model');
    assert.equal(project.domainId, 'cybersecurity');

    // Update domain override to 'software-engineering'
    const updated = manager.updateProject(project.id, { domainId: 'software-engineering' });
    assert.ok(updated);
    assert.equal(updated.domainId, 'software-engineering');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('5. Active project selection', async () => {
  const dirA = makeTmpDir('projA-');
  const dirB = makeTmpDir('projB-');
  try {
    fs.writeFileSync(path.join(dirA, 'package.json'), JSON.stringify({ name: 'proj-a' }));
    fs.writeFileSync(path.join(dirB, 'package.json'), JSON.stringify({ name: 'proj-b' }));

    const store = new InMemoryProjectStore();
    const manager = new ProjectManager(store);

    const pA = await manager.createProject({ name: 'Project A', rootPath: dirA, domainId: 'software-engineering' });
    assert.equal(manager.getActiveProject()?.id, pA.id);

    const pB = await manager.createProject({ name: 'Project B', rootPath: dirB, domainId: 'ai-ml' });
    // After creating B, active project can be explicitly switched
    manager.setActiveProject(pB.id);
    assert.equal(manager.getActiveProject()?.id, pB.id);

    manager.setActiveProject(pA.id);
    assert.equal(manager.getActiveProject()?.id, pA.id);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('6. Re-analyze refreshes project metadata', async () => {
  const projectDir = makeTmpDir('refresh-');
  try {
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'v1-app' }));
    fs.writeFileSync(path.join(projectDir, 'index.js'), 'console.log(1)');

    const store = new InMemoryProjectStore();
    const manager = new ProjectManager(store);

    const initial = await manager.createProject({ name: 'V1', rootPath: projectDir, domainId: 'software-engineering' });
    assert.equal(initial.dependencies.length, 0);

    // Modify disk: add requirements and dependencies
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'v2-app', dependencies: { react: '^18.0.0', redux: '^5.0.0' } })
    );

    const refreshed = await manager.refreshProject(initial.id);
    assert.ok(refreshed);
    assert.equal(refreshed.dependencies.length, 2);
    assert.ok(refreshed.frameworks.includes('React'));
    assert.ok(refreshed.lastAnalyzedAt >= initial.lastAnalyzedAt);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('7. Invalid / nonexistent folder handling', async () => {
  const store = new InMemoryProjectStore();
  const manager = new ProjectManager(store);

  const nonExistentPath = path.join(os.tmpdir(), 'non-existent-dir-' + Date.now());

  await assert.rejects(
    async () => {
      await manager.importProject(nonExistentPath);
    },
    /Directory not found|Invalid project directory/
  );

  await assert.rejects(
    async () => {
      await manager.createProject({
        name: 'Bad Dir',
        rootPath: nonExistentPath,
        domainId: 'software-engineering'
      });
    },
    /Invalid project directory/
  );
});
