'use strict';

const loadTs = require('./load-ts.cjs');
const { extractProjectKnowledgeGraph } = loadTs('src/main/project/projectGraphExtractor.ts');
const { ContextEngine } = loadTs('src/main/context/contextEngine.ts');
const { execSync } = require('node:child_process');

class MemoryStore {
  constructor() {
    this.projects = new Map();
    this.nodes = new Map();
    this.edges = new Map();
  }
  getProject(id) { return this.projects.get(id) || null; }
  saveProject(p) { this.projects.set(p.id, p); }
  saveProjectGraph(pId, nodes, edges) {
    for (const n of nodes) this.nodes.set(`${pId}:${n.id}`, { ...n, projectId: pId });
    for (const e of edges) this.edges.set(`${pId}:${e.id}`, { ...e, projectId: pId });
  }
  getProjectGraphNodes(pId) { return Array.from(this.nodes.values()).filter((n) => n.projectId === pId); }
  getProjectGraphEdges(pId) { return Array.from(this.edges.values()).filter((e) => e.projectId === pId); }
}

const BENCHMARK_TASKS = [
  {
    type: 'Bug Fix',
    task: 'Fix the Ollama agent workspace/path issue.',
    testCmd: 'node --test test/agent-provider.test.cjs test/hive-windows-prompt.test.cjs'
  },
  {
    type: 'Feature Addition',
    task: 'Add support for custom model timeout and retry configuration in agentProvider.',
    testCmd: 'node --test test/agent-provider.test.cjs'
  },
  {
    type: 'Refactor',
    task: 'Refactor SQLite store migrations to support project graph node indices and clean connection lifecycle in db.ts.',
    testCmd: 'node --test test/project-graph.test.cjs'
  },
  {
    type: 'Failing Test Fix',
    task: 'Fix failing transcript-project-dir test and ensure proper working directory resolution.',
    testCmd: 'node --test test/transcript-project-dir.test.cjs'
  },
  {
    type: 'API Change',
    task: 'Extend project manager IPC channels with domain definition query and graph stats endpoints.',
    testCmd: 'node --test test/project-manager.test.cjs'
  }
];

async function runMultiTaskBenchmark() {
  const store = new MemoryStore();
  const root = process.cwd();
  store.saveProject({
    id: 'munder-difflin-root',
    name: 'munder-difflin',
    rootPath: root,
    domainId: 'software-engineering'
  });

  const graph = extractProjectKnowledgeGraph('munder-difflin-root', root, 'munder-difflin');
  store.saveProjectGraph('munder-difflin-root', graph.nodes, graph.edges);

  const engine = new ContextEngine(store);

  console.log('================================================================================');
  console.log('            PHASE 6C: MULTI-TASK CONTEXT BENCHMARK REPORT                      ');
  console.log('================================================================================\n');

  const results = [];

  for (const item of BENCHMARK_TASKS) {
    const realisticBase = engine.computeRealisticBaseline('munder-difflin-root', item.task);
    const optimizedPackage = await engine.assembleContext('munder-difflin-root', item.task, { budgetTokens: 32000 });

    let testsPassed = false;
    try {
      const out = execSync(item.testCmd, { encoding: 'utf8' });
      testsPassed = !out.includes('not ok');
    } catch {
      testsPassed = false;
    }

    const realReduction = realisticBase.tokens > 0
      ? Math.round((1 - (optimizedPackage.estimatedTokens / realisticBase.tokens)) * 100)
      : 0;

    const res = {
      type: item.type,
      task: item.task,
      baselineTokens: realisticBase.tokens,
      baselineFiles: realisticBase.fileCount,
      optimizedTokens: optimizedPackage.estimatedTokens,
      optimizedFiles: optimizedPackage.selectedFiles.length,
      realReduction,
      tierBreakdown: {
        t1: optimizedPackage.items.filter(i => i.tier === 'tier1_full').length,
        t2: optimizedPackage.items.filter(i => i.tier === 'tier2_signature').length,
        t3: optimizedPackage.items.filter(i => i.tier === 'tier3_summary').length
      },
      topTarget: optimizedPackage.selectedFiles[0] || 'none',
      testsPassed
    };

    results.push(res);

    console.log(`[TASK: ${item.type.toUpperCase()}] "${item.task}"`);
    console.log(`  • Baseline Context  : ${res.baselineTokens.toLocaleString()} tokens across ${res.baselineFiles} files`);
    console.log(`  • Optimized Context : ${res.optimizedTokens.toLocaleString()} tokens across ${res.optimizedFiles} files`);
    console.log(`  • Token Reduction   : ${res.realReduction}% reduction`);
    console.log(`  • Core Direct Target: ${res.topTarget}`);
    console.log(`  • Context Tiers     : Tier 1 (${res.tierBreakdown.t1}), Tier 2 (${res.tierBreakdown.t2}), Tier 3 (${res.tierBreakdown.t3})`);
    console.log(`  • Test Verification : ${res.testsPassed ? 'PASSED (Target suite clean)' : 'FAILED'}`);
    console.log('');
  }

  console.log('================================================================================');
  console.log('                           BENCHMARK SUMMARY TABLE                              ');
  console.log('================================================================================');
  console.log('| Task Type         | Baseline Tokens | Optimized Tokens | Reduction % | Test Status |');
  console.log('|-------------------|-----------------|------------------|-------------|-------------|');
  for (const r of results) {
    console.log(`| ${r.type.padEnd(17)} | ${(r.baselineTokens.toLocaleString() + ' tok').padEnd(15)} | ${(r.optimizedTokens.toLocaleString() + ' tok').padEnd(16)} | ${(r.realReduction + '%').padEnd(11)} | ${(r.testsPassed ? 'PASSED' : 'FAILED').padEnd(11)} |`);
  }
}

runMultiTaskBenchmark().catch(console.error);
