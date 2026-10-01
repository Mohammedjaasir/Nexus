// DEMO ONLY: browser preview bridge.
//
// When the renderer is opened in a plain browser through the Vite dev server,
// there is no Electron preload and therefore no `window.cth`. This installs a
// stub so the UI can be inspected (layout, responsive checks) without a
// backend. It is compiled in only for dev builds, and it puts a permanent
// banner on screen so the sample data below can never pass for real data.
if (import.meta.env.DEV && typeof window !== 'undefined' && !window.cth) {
  const now = Date.now();
  const sampleProjects: any[] = [
    {
      id: 'sample-project-a',
      name: 'Sample project A',
      domainId: 'computer-vision',
      type: 'library',
      primaryLanguage: 'typescript',
      rootPath: '/sample/project-a',
      createdAt: now - 3600000,
      updatedAt: now,
      status: 'active'
    },
    {
      id: 'sample-project-b',
      name: 'Sample project B',
      domainId: 'ai-ml',
      type: 'backend_service',
      primaryLanguage: 'python',
      rootPath: '/sample/project-b',
      createdAt: now - 7200000,
      updatedAt: now,
      status: 'active'
    }
  ];

  const sampleAgents: any[] = [
    { id: 'sample-agent-1', name: 'sample-agent-1', status: 'idle' },
    { id: 'sample-agent-2', name: 'sample-agent-2', status: 'working' }
  ];

  const baseBridge: Record<string, any> = {
    getConfig: async () => ({
      tvShowOffices: false,
      officeTheme: 'office',
      freeflowEnabled: false,
      webhookTriggers: [],
      orgTrigger: { webhookUrl: '' }
    }),
    realtimeHasOpenAiKey: async () => false,
    projectGetActive: async () => sampleProjects[0],
    projectList: async () => sampleProjects,
    projectSetActive: async (id: string) => sampleProjects.find((p) => p.id === id) || sampleProjects[0],
    projectRefresh: async (id: string) => sampleProjects.find((p) => p.id === id) || sampleProjects[0],
    projectPlanGet: async () => null,
    hiveTasks: async () => ({ tasks: [] }),
    hiveAgents: async () => sampleAgents,
    hiveRegistry: async () => ({}),
    hiveAgentDirectory: async () => sampleAgents,
    hiveBoard: async () => ({ columns: [] }),
    hiveMemory: async () => ({ entries: [] }),
    hiveLog: async () => [],
    memoryStatus: async () => ({ ready: true, count: 0 }),
    telemetrySnapshot: async () => ({}),
    listMissions: async () => [],
    appInfo: async () => ({ version: 'dev', name: 'Browser preview' }),
    getGodState: async () => ({ status: 'idle' }),
    rosterReadSync: () => null,
    rosterWrite: async () => {}
  };

  (window as any).cth = new Proxy(baseBridge, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop.startsWith('on')) return () => () => {};
      return async () => ({});
    }
  });

  const showBanner = () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.textContent = 'Browser preview: no backend connected. Projects and agents shown are sample data.';
    el.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
      'padding:6px 12px', 'font:12px/1.4 system-ui,sans-serif', 'text-align:center',
      'background:#222', 'color:#fff', 'pointer-events:none'
    ].join(';');
    document.body.appendChild(el);
  };
  if (document.body) showBanner();
  else window.addEventListener('DOMContentLoaded', showBanner, { once: true });
}

export {};
