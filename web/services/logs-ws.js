function attachLogsWebsocket({
  server,
  WebSocketServer,
  loadAgentsConfig,
  getAgentDataDir,
  fsSync,
  logger = console
}) {
  const wss = new WebSocketServer({ server, path: '/ws/logs' });

  wss.on('connection', (ws) => {
    logger.log('WebSocket client connected');

    const initialAgentId = (() => {
      const config = loadAgentsConfig();
      const first = Array.isArray(config.agents) && config.agents[0] ? config.agents[0].id : null;
      return first || 'main';
    })();
    let agentId = initialAgentId;
    let tail = null;

    function startTail(id) {
      if (tail) {
        tail.unwatch();
      }

      const logPath = getAgentDataDir(id) + '/watch.log';
      fsSync.mkdirSync(getAgentDataDir(id), { recursive: true });
      if (!fsSync.existsSync(logPath)) {
        fsSync.writeFileSync(logPath, '');
      }

      try {
        const Tail = require('tail').Tail;
        tail = new Tail(logPath, { follow: true, fromBeginning: false });
        tail.on('line', (line) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'log', line }));
          }
        });
        tail.on('error', (err) => {
          logger.error('Tail error:', err);
        });
      } catch (e) {
        logger.error('Failed to start tail:', e.message);
      }
    }

    startTail(agentId);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.agentId && msg.agentId !== agentId) {
          agentId = msg.agentId;
          startTail(agentId);
        }
      } catch (_e) {}
    });

    ws.on('close', () => {
      logger.log('WebSocket client disconnected');
      if (tail) tail.unwatch();
    });
  });

  return wss;
}

module.exports = {
  attachLogsWebsocket
};
