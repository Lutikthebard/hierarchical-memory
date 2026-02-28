(function attachHmAppState(globalObj) {
  function createState(defaultClassFilters, messageClassOptions) {
    return {
      agents: [],
      selectedAgent: '',
      currentAgentStatus: { running: false },
      stats: {
        messagesCount: 0,
        artifacts: { L1: 0, L2: 0, L3: 0 },
        threshold: 60,
        unsummarized: 0,
        progress: 0,
        sessionMessageCount: 0,
        compactThreshold: 150,
        compactProgress: 0
      },
      artifacts: { L1: [], L2: [], L3: [] },
      contextSections: [],
      messages: [],
      logs: [],
      activeTab: 'context',
      expanded: {},
      showAgentManager: false,
      newAgentId: '',
      newAgentName: '',
      newAgentIsSubagent: false,
      availableAgents: [],
      sessionSyncInProgress: false,
      sessionSyncMessage: '',
      contextRebuildInProgress: false,
      contextRebuildMessage: '',
      contextInjectInProgress: false,
      contextInjectMessage: '',
      compactInjectInProgress: false,
      compactInjectMessage: '',
      memoryClearInProgress: false,
      memoryClearMessage: '',
      showRollbackModal: false,
      rollbackCutoffLocal: '',
      rollbackPreviewInProgress: false,
      rollbackApplyInProgress: false,
      rollbackRestoreInProgress: false,
      rollbackPreview: null,
      rollbackLastBackupId: '',
      rollbackMessage: '',
      sessionInfo: { sessionId: null, sessionKey: null, source: null, jsonlPath: null },
      ws: null,
      refreshInterval: null,
      drilldownModal: {
        open: false,
        loading: false,
        title: '',
        type: '',
        sourceLevel: null,
        messages: [],
        sourceArtifacts: []
      },
      messageDates: [],
      selectedMessageDate: '',
      archivedMessages: [],
      archivedMessagesLoading: false,
      messageClassOptions,
      agentConfig: {
        thresholds: { L1: 60, default: 5 },
        prompts: { l1: '', aggregate: '' },
        filters: {
          exclude: [],
          excludePatterns: [],
          countRoles: ['user', 'assistant'],
          storeRoles: ['user', 'assistant'],
          ...defaultClassFilters
        },
        autoInjectContext: {
          enabled: false,
          onNewSession: false,
          onCompaction: false,
          preText: '',
          postText: '',
          preMdFiles: [],
          postMdFiles: []
        },
        autoCompact: {
          enabled: false,
          messageThreshold: 150,
          postCompactMessage: '',
          retries: 5,
          retryDelayMs: 3000
        }
      }
    };
  }

  globalObj.HmAppState = {
    createState
  };
}(window));
