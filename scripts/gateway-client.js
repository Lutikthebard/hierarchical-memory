/**
 * gateway-client.js — WebSocket client for OpenClaw Gateway
 * 
 * Implements proper device identity auth with Ed25519 signatures.
 * 
 * ENV:
 *   GATEWAY_URL=ws://127.0.0.1:18789
 *   GATEWAY_TOKEN=... (gateway auth token from config)
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 30000;
const OPENCLAW_DIR = path.join(process.env.HOME, '.openclaw');

/**
 * Load gateway token from config if not provided
 */
function loadGatewayToken() {
  const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
  
  if (!fs.existsSync(configPath)) {
    return null;
  }
  
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.gateway?.auth?.token || null;
  } catch {
    return null;
  }
}

/**
 * Base64url encode buffer
 */
function base64UrlEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Extract raw public key from PEM (Ed25519)
 */
function derivePublicKeyRaw(pem) {
  const key = crypto.createPublicKey(pem);
  const spki = key.export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI: 12 byte prefix + 32 byte raw key
  return spki.slice(12);
}

/**
 * Load device identity from ~/.openclaw/identity/
 */
function loadDeviceIdentity() {
  const devicePath = path.join(OPENCLAW_DIR, 'identity', 'device.json');
  
  if (!fs.existsSync(devicePath)) {
    return null;
  }
  
  const device = JSON.parse(fs.readFileSync(devicePath, 'utf8'));
  return {
    deviceId: device.deviceId,
    publicKeyPem: device.publicKeyPem,
    privateKeyPem: device.privateKeyPem,
    publicKeyBase64Url: base64UrlEncode(derivePublicKeyRaw(device.publicKeyPem))
  };
}

class OpenClawClient {
  constructor(url, token) {
    this.url = url;
    this.token = token || loadGatewayToken();
    this.ws = null;
    this.pending = new Map(); // id -> {resolve, reject, timeout}
    this.connected = false;
    this.deviceIdentity = loadDeviceIdentity();
    
    // Event handlers (set by consumer)
    this.onChatMessage = null;
    this.onDisconnect = null;
    
    // Connection state
    this.connectNonce = null;
    
    if (!this.token) {
      console.warn('[gateway-client] Warning: No gateway token found');
    }
  }

  /**
   * Connect to Gateway WebSocket
   */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const timeoutHandle = setTimeout(() => {
        reject(new Error('Connection timeout'));
        ws.close();
      }, 15000);

      ws.on('open', () => {
        // Wait for connect.challenge event
      });

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        this._onFrame(msg, () => {
          clearTimeout(timeoutHandle);
          resolve();
        });
      });

      ws.on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });

      ws.on('close', () => {
        this.connected = false;
        
        // Reject all pending requests
        for (const [id, p] of this.pending) {
          clearTimeout(p.timeout);
          p.reject(new Error('socket closed'));
        }
        this.pending.clear();

        // Notify consumer
        if (this.onDisconnect) {
          this.onDisconnect();
        }
      });
    });
  }

  /**
   * Handle incoming WebSocket frame
   */
  _onFrame(frame, onConnected) {
    // Handshake: connect.challenge -> connect
    if (frame?.type === 'event' && frame?.event === 'connect.challenge') {
      this.connectNonce = frame.payload?.nonce;
      const ts = frame.payload?.ts ?? Date.now();
      
      this._sendConnectRequest(ts, this.connectNonce);
      return;
    }

    // RPC response
    if (frame?.type === 'res') {
      // Check for hello-ok (connection established)
      if (frame.ok && frame.payload?.type === 'hello-ok') {
        this.connected = true;
        onConnected?.();
        return;
      }
      
      // Handle pending RPC
      const p = this.pending.get(frame.id);
      if (p) {
        this.pending.delete(frame.id);
        clearTimeout(p.timeout);
        
        if (frame.ok) {
          p.resolve(frame.payload);
        } else {
          p.reject(Object.assign(
            new Error(frame.error?.message ?? 'rpc error'),
            { error: frame.error }
          ));
        }
      }
      return;
    }

    // Events
    if (frame?.type === 'event') {
      // Chat messages from chat.subscribe
      if (frame.event === 'chat') {
        this._handleChatEvent(frame.payload);
      }
    }
  }

  /**
   * Send connect request with device auth
   */
  _sendConnectRequest(ts, nonce) {
    const clientId = 'cli';
    const clientMode = 'backend';
    const role = 'operator';
    const scopes = ['operator.read', 'operator.write', 'operator.admin'];
    
    let device = undefined;
    
    if (this.deviceIdentity && this.token) {
      // Build auth payload: v2|deviceId|clientId|clientMode|role|scopes|ts|token|nonce
      const payload = [
        'v2',
        this.deviceIdentity.deviceId,
        clientId,
        clientMode,
        role,
        scopes.join(','),
        String(ts),
        this.token,
        nonce
      ].join('|');
      
      // Sign with Ed25519
      const privateKey = crypto.createPrivateKey(this.deviceIdentity.privateKeyPem);
      const signature = base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey));
      
      device = {
        id: this.deviceIdentity.deviceId,
        publicKey: this.deviceIdentity.publicKeyBase64Url,
        signature: signature,
        signedAt: ts,
        nonce: nonce
      };
    }
    
    const connectReq = {
      type: 'req',
      id: this._id(),
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: clientId,
          version: '1.0.0',
          platform: process.platform,
          mode: clientMode
        },
        role: role,
        scopes: scopes,
        caps: [],
        commands: [],
        permissions: {},
        auth: this.token ? { token: this.token } : undefined,
        locale: 'ru-RU',
        userAgent: 'hierarchical-memory/2.0.0',
        device: device
      }
    };
    
    this._send(connectReq);
  }

  /**
   * Handle chat event from subscription
   */
  _handleChatEvent(payload) {
    if (!this.onChatMessage) return;

    // Normalize message format
    const msg = payload?.message ?? payload;
    
    const chatMsg = {
      role: msg?.role ?? msg?.fromRole ?? msg?.senderRole,
      content: msg?.text ?? msg?.content ?? msg?.message,
      timestamp: msg?.timestamp ?? msg?.ts ?? new Date().toISOString(),
      raw: msg
    };

    // Pass to consumer handler
    this.onChatMessage(chatMsg);
  }

  /**
   * Send JSON frame
   */
  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('socket not open');
    }
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * Generate unique ID
   */
  _id() {
    return crypto.randomBytes(12).toString('hex');
  }

  /**
   * RPC call with timeout
   */
  rpc(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = this._id();
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this._send({ type: 'req', id, method, params });
    });
  }

  /**
   * Subscribe to chat messages for a session
   */
  async subscribeToChat(sessionKey) {
    await this.rpc('chat.subscribe', { sessionKey });
  }

  /**
   * Send message to agent session and wait for response
   * Uses chat.send + agent.wait with agent:agentId session
   */
  async sendToAgent(agentId, message, timeoutSeconds = 120) {
    const crypto = require('crypto');
    const sessionKey = `agent:${agentId}:main`;
    const timeoutMs = timeoutSeconds * 1000;
    
    console.log('[gateway-client] sendToAgent called');
    console.log('[gateway-client]   agentId:', agentId);
    console.log('[gateway-client]   sessionKey:', sessionKey);
    console.log('[gateway-client]   message length:', message.length);
    console.log('[gateway-client]   message preview:', message.substring(0, 100));
    
    // 1. Send message to agent session
    try {
      console.log('[gateway-client] Step 1: Calling chat.send...');
      console.log('[gateway-client]   → Sending to sessionKey:', sessionKey);
      const sendResult = await this.rpc('chat.send', {
        sessionKey,
        message,
        idempotencyKey: crypto.randomUUID(),
        timeoutMs
      }, timeoutMs + 30000);
      
      console.log('[gateway-client] chat.send result:', JSON.stringify(sendResult, null, 2));
      
      if (!sendResult.runId) {
        throw new Error('No runId returned from chat.send');
      }
      
      // 2. Wait for completion
      console.log('[gateway-client] Step 2: Waiting for completion (runId:', sendResult.runId, ')...');
      const waitResult = await this.rpc('agent.wait', {
        runId: sendResult.runId,
        timeoutMs
      }, timeoutMs + 30000);
      
      console.log('[gateway-client] agent.wait result:', JSON.stringify(waitResult, null, 2));
      
      // 3. Get history to extract response
      console.log('[gateway-client] Step 3: Fetching chat history...');
      const history = await this.rpc('chat.history', {
        sessionKey,
        limit: 15
      }, 10000);
      
      console.log('[gateway-client] chat.history returned', history.messages?.length || 0, 'messages');
      
      // History is NEWEST-FIRST, so response is at i-1 (before user message in array)
      // Normalize whitespace since Gateway may collapse newlines to spaces
      const messages = history.messages || [];
      const normalizeWs = (s) => s.replace(/\s+/g, ' ').trim();
      const searchText = normalizeWs(message.substring(0, Math.min(80, message.length)));
      
      console.log('[gateway-client] Searching for response...');
      console.log('[gateway-client]   searchText:', searchText.substring(0, 60));
      
      for (let i = 1; i < messages.length; i++) {
        if (messages[i].role === 'user') {
          const rawText = this._extractTextContent(messages[i].content);
          const textNorm = normalizeWs(rawText.substring(0, 100));
          console.log('[gateway-client]   Checking message', i, ':', textNorm.substring(0, 60));
          if (textNorm.includes(searchText.substring(0, 40))) {
            console.log('[gateway-client]   ✅ Found our message at index', i);
            // Search for assistant response with <memory_artifact> in last 10 messages
            for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
              if (messages[j]?.role === 'assistant') {
                const response = this._extractTextContent(messages[j].content);
                if (response.includes('<memory_artifact>')) {
                  console.log('[gateway-client]   ✅ Found response with artifact at index', j, ', length:', response.length);
                  console.log('[gateway-client]   Response preview:', response.substring(0, 100));
                  return response;
                }
                console.log('[gateway-client]   ⏭️  Skipping assistant at index', j, '(no artifact tag)');
              }
            }
            console.log('[gateway-client]   ❌ No assistant response with <memory_artifact> found in range', i - 1, 'to', Math.max(0, i - 10));
          }
        }
      }
      
      // Fallback: return empty if not found
      console.log('[gateway-client] ❌ No response found in history');
      return '';
      
    } catch (error) {
      console.error('[gateway-client] ❌ Error in sendToAgent:', error.message);
      console.error('[gateway-client] Error stack:', error.stack);
      throw error;
    }
  }

  /**
   * Send message to session and wait for response
   * Uses chat.send + agent.wait + chat.history
   */
  async sendAndWait(sessionKey, message, timeoutSeconds = 120) {
    const crypto = require('crypto');
    const timeoutMs = timeoutSeconds * 1000;
    
    // Get history before sending to know where new messages start
    const historyBefore = await this.rpc('chat.history', {
      sessionKey,
      limit: 1
    }, 10000);
    const lastMsgBefore = historyBefore.messages?.[0];
    
    // 1. Send message
    const sendResult = await this.rpc('chat.send', {
      sessionKey,
      message,
      idempotencyKey: crypto.randomUUID(),
      timeoutMs
    }, timeoutMs + 30000);
    
    if (!sendResult.runId) {
      throw new Error('No runId returned from chat.send');
    }
    
    // 2. Wait for completion
    await this.rpc('agent.wait', {
      runId: sendResult.runId,
      timeoutMs
    }, timeoutMs + 30000);
    
    // 3. Get history to extract response (get more messages to find the new one)
    const history = await this.rpc('chat.history', {
      sessionKey,
      limit: 10
    }, 10000);
    
    // Find assistant message that came AFTER our request
    // Messages are in reverse order (newest first), so find first assistant after user message with our text
    const messages = history.messages || [];
    let foundOurMessage = false;
    
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      
      // Check if this is our message
      if (msg.role === 'user') {
        const content = this._extractTextContent(msg.content);
        if (content.includes(message.substring(0, 50))) {
          foundOurMessage = true;
          continue;
        }
      }
      
      // If we found our message and this is assistant response
      if (foundOurMessage && msg.role === 'assistant') {
        return this._extractTextContent(msg.content);
      }
    }
    
    // Fallback: return last assistant message
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        return this._extractTextContent(msg.content);
      }
    }
    
    return '';
  }
  
  /**
   * Extract text content from message content
   */
  _extractTextContent(content) {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }
    return '';
  }

  /**
   * Close connection
   */
  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = { OpenClawClient, loadDeviceIdentity };
