const crypto = require('crypto');

async function runMemoryTask({
  agentId,
  requestId,
  taskKind,
  sourceLevel,
  targetLevel,
  threshold,
  selectedCount,
  windowStart,
  windowEnd,
  createPrompt,
  createRetryPrompt,
  sendToAgent,
  parseAgentResponse,
  logTelemetry,
  safePreview,
  maxRetries = 3,
  includeSelectedCountInFailure = false,
  logLastResponseOnFailure = false
}) {
  const resolvedRequestId = requestId || crypto.randomUUID();
  const originalPrompt = createPrompt();
  let currentPrompt = originalPrompt;
  let retries = 0;
  let artifactText = null;
  let responseText = '';

  while (retries < maxRetries) {
    try {
      const attempt = retries + 1;
      console.log(`[trigger] Attempt ${attempt}/${maxRetries}`);
      logTelemetry(agentId, {
        eventType: 'memory_task_sent',
        requestId: resolvedRequestId,
        taskKind,
        sourceLevel,
        targetLevel,
        threshold,
        selectedCount,
        windowStart,
        windowEnd,
        attempt,
        promptHash: crypto.createHash('sha1').update(currentPrompt).digest('hex'),
        promptPreview: safePreview(currentPrompt)
      });

      const sendResult = await sendToAgent(currentPrompt, targetLevel);
      responseText = sendResult?.reply || '';
      logTelemetry(agentId, {
        eventType: 'memory_task_response',
        requestId: resolvedRequestId,
        taskKind,
        sourceLevel,
        targetLevel,
        attempt,
        responseLength: responseText.length,
        responsePreview: safePreview(responseText),
        captureMethod: sendResult?.captureInfo?.method ?? null,
        captureCollectedCount: sendResult?.captureInfo?.collectedCount ?? null
      });

      artifactText = parseAgentResponse(responseText, targetLevel);
      console.log('[trigger] ✅ Successfully parsed artifact');
      break;
    } catch (error) {
      retries += 1;
      logTelemetry(agentId, {
        eventType: 'memory_task_attempt_failed',
        requestId: resolvedRequestId,
        taskKind,
        sourceLevel,
        targetLevel,
        attempt: retries,
        error: error.message
      });
      console.error(`[trigger] ❌ Attempt ${retries} failed: ${error.message}`);

      if (retries >= maxRetries) {
        console.error('[trigger] Max retries reached, giving up');
        if (logLastResponseOnFailure) {
          console.error('[trigger] Last response:', responseText ? responseText.substring(0, 500) : 'No response');
        }
        const failEvent = {
          eventType: 'artifact_failed',
          requestId: resolvedRequestId,
          taskKind,
          sourceLevel,
          targetLevel,
          attemptsSent: retries,
          windowStart,
          windowEnd
        };
        if (includeSelectedCountInFailure) {
          failEvent.selectedCount = selectedCount;
        }
        logTelemetry(agentId, failEvent);
        return null;
      }

      console.log('[trigger] Retrying with error feedback...');
      currentPrompt = createRetryPrompt(error.message, responseText, originalPrompt);
    }
  }

  return {
    requestId: resolvedRequestId,
    artifactText,
    attemptsSent: retries + 1
  };
}

module.exports = {
  runMemoryTask
};
