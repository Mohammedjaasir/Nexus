// Browser fallback bridge when running in Vite standalone browser outside Electron
if (typeof window !== 'undefined' && !window.cth) {
  const dummyProjects: any[] = [
    {
      id: 'proj-ocr-1',
      name: 'Vision OCR Engine',
      domainId: 'computer-vision',
      type: 'library',
      primaryLanguage: 'typescript',
      rootPath: '/fake/vision-ocr',
      createdAt: Date.now() - 3600000,
      updatedAt: Date.now(),
      status: 'active'
    },
    {
      id: 'proj-fraud-2',
      name: 'Invoice Fraud Detection Platform',
      domainId: 'ai-ml',
      type: 'backend_service',
      primaryLanguage: 'python',
      rootPath: '/fake/fraud-detector',
      createdAt: Date.now() - 7200000,
      updatedAt: Date.now(),
      status: 'active'
    }
  ];

  const dummyAgents: any[] = [
    { id: 'agent-jim', name: 'jim', status: 'idle', charName: 'jim', color: 'blue' },
    { id: 'agent-ryan', name: 'ryan', status: 'working', charName: 'ryan', color: 'purple' },
    { id: 'agent-creed', name: 'creed', status: 'idle', charName: 'creed', color: 'red' }
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
    projectGetActive: async () => dummyProjects[0],
    projectList: async () => dummyProjects,
    projectSetActive: async (id: string) => dummyProjects.find((p) => p.id === id) || dummyProjects[0],
    projectRefresh: async (id: string) => dummyProjects.find((p) => p.id === id) || dummyProjects[0],
    projectPlanGet: async (id: string) => ({
      projectId: id,
      version: '1.0.0',
      milestones: [
        {
          id: 'ms-1',
          name: 'Core Implementation',
          tasks: [
            { id: 't-1', title: 'Setup OCR pipeline', status: 'completed' },
            { id: 't-2', title: 'Train model weights', status: 'in_progress' }
          ]
        }
      ],
      tasks: [
        { id: 't-1', title: 'Setup OCR pipeline', status: 'completed' },
        { id: 't-2', title: 'Train model weights', status: 'in_progress' }
      ]
    }),
    hiveTasks: async () => ({ tasks: [] }),
    hiveAgents: async () => dummyAgents,
    hiveRegistry: async () => ({}),
    hiveAgentDirectory: async () => dummyAgents,
    hiveBoard: async () => ({ columns: [] }),
    hiveMemory: async () => ({ entries: [] }),
    hiveLog: async () => [],
    memoryStatus: async () => ({ ready: true, count: 0 }),
    telemetrySnapshot: async () => ({}),
    listMissions: async () => [],
    appInfo: async () => ({ version: '0.4.4', name: 'Munder Difflin' }),
    getGodState: async () => ({ status: 'idle' }),
    rosterReadSync: () => null,
    rosterWrite: async () => {},
    onCloseRequested: (cb: any) => () => {},
    onHiveMessage: (cb: any) => () => {},
    onTelemetry: (cb: any) => () => {},
    onClosingTime: (cb: any) => () => {},
    onVoiceActivity: (cb: any) => () => {},
    onAudioChunk: (cb: any) => () => {},
    onMichaelTalk: (cb: any) => () => {},
    onGodState: (cb: any) => () => {}
  };

  (window as any).cth = new Proxy(baseBridge, {
    get(target, prop: string) {
      if (prop in target) {
        return target[prop];
      }
      if (prop.startsWith('on')) {
        return () => () => {};
      }
      return async () => ({});
    }
  });
}

export {};
