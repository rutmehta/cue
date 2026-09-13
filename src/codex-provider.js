'use strict';

// Codex owns credentials and refresh. Cue only speaks the supported stdio protocol.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apply_patch_freeform', 'apps', 'connectors', 'plugins', 'remote_plugin', 'hooks', 'codex_hooks', 'plugin_hooks', 'computer_use', 'browser_use', 'in_app_browser', 'js_repl', 'code_mode', 'code_mode_host', 'multi_agent', 'multi_agent_v2', 'collab', 'image_generation', 'imagegenext', 'memory_tool', 'memories', 'skill_search', 'tool_search', 'tool_suggest', 'goals', 'remote_control'];
const SAFE_CONFIG = {
  web_search: 'disabled', mcp_servers: {}, project_doc_max_bytes: 0,
  features: Object.fromEntries([...DISABLED_FEATURES.map(k => [k, false]), ['skip_host_skill_discovery', true]]),
};

function executablePath() {
  const candidates = [path.join(os.homedir(), '.local/bin/codex'), '/Applications/Codex.app/Contents/Resources/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
  for (const p of candidates) { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {} }
  throw new Error('Install Codex CLI or the Codex desktop app, then sign in with ChatGPT.');
}

class CodexProvider {
  constructor(options = {}) {
    this.spawn = options.spawn || spawn;
    this.executable = options.executable;
    this.timeoutMs = options.timeoutMs || 90000;
    this.cwd = options.cwd || os.tmpdir();
    this.pending = new Map(); this.events = new EventEmitter(); this.nextId = 1;
  }

  async connect() {
    const args = ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"'];
    for (const [key, value] of Object.entries(SAFE_CONFIG.features)) args.push('-c', `features.${key}=${value}`);
    // Do not inherit an API credential that could change billing mode.
    const env = { ...process.env }; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    this.child = this.spawn(this.executable || executablePath(), args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return this.fail(new Error('Codex protocol response exceeded the size limit.'));
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch { this.fail(new Error('Codex returned an invalid protocol response.')); }
      }
    });
    // Drain, but never forward server diagnostics which may contain sensitive context.
    this.child.stderr.resume();
    this.child.on('error', () => this.fail(new Error('Unable to start Codex. Check that Codex CLI is installed.')));
    this.child.on('exit', () => this.fail(new Error('Codex stopped before completing the request.')));
    this.child.stdin.on('error', () => this.fail(new Error('The Codex connection closed.')));
    await this.request('initialize', { clientInfo: { name: 'cue', title: 'Cue', version: '0.2.2' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
  }

  write(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out. Try again.')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  receive(message) {
    if (message.id != null && message.method) {
      // No tools, approval dialogs, or external token lifecycle are delegated to Cue.
      this.write({ id: message.id, error: { code: -32601, message: 'Cue only supports answer generation; tool requests are disabled.' } });
      return;
    }
    if (message.id != null) {
      const p = this.pending.get(message.id); if (!p) return;
      this.pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new Error(message.error.message || 'Codex request failed.')); else p.resolve(message.result);
      return;
    }
    this.events.emit('notification', message);
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.events.emit('failure', error);
  }
  close() { this.fail(new Error('Codex connection closed.')); this.child?.kill(); this.events.removeAllListeners(); }

  async account() {
    const { account } = await this.request('account/read', { refreshToken: false });
    return { connected: account?.type === 'chatgpt', plan: account?.type === 'chatgpt' ? account.planType : null };
  }
  async models() {
    const models = []; let cursor = null;
    do {
      const result = await this.request('model/list', { limit: 100, cursor });
      models.push(...result.data); cursor = result.nextCursor;
    } while (cursor);
    return models;
  }
  async status() {
    try {
      await this.connect(); const account = await this.account();
      return { ...account, models: account.connected ? (await this.models()).map(m => ({ id: m.model, name: m.displayName, isDefault: m.isDefault, defaultReasoningEffort: m.defaultReasoningEffort, supportedReasoningEfforts: m.supportedReasoningEfforts })) : [] };
    } finally { this.close(); }
  }

  async login(openBrowser) {
    try {
      await this.connect();
      if ((await this.account()).connected) return { connected: true };
      const result = await this.request('account/login/start', { type: 'chatgpt' });
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)) throw new Error('Codex returned an unexpected sign-in URL.');
      const completed = this.waitFor(message => message.method === 'account/login/completed' && message.params.loginId === result.loginId ? message.params : null);
      completed.catch(() => {});
      await openBrowser(url.href);
      const state = await completed;
      if (!state.success) throw new Error('Codex sign-in was not completed.');
      return await this.account();
    } finally { this.close(); }
  }

  waitFor(select, { isActivity } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => { clearTimeout(timer); this.events.off('notification', onMessage); this.events.off('failure', onFailure); error ? reject(error) : resolve(value); };
      const onFailure = error => finish(error);
      const rearm = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('Codex response timed out. Try again.')), this.timeoutMs); };
      const onMessage = message => { try { if (isActivity?.(message)) rearm(); const value = select(message); if (value) finish(null, value); } catch (error) { finish(error); } };
      rearm();
      this.events.on('notification', onMessage); this.events.on('failure', onFailure);
    });
  }

  async stream({ system = '', turns = [], imageDataUrl, onToken = () => {}, onActivity = () => {}, model, effort: requestedEffort, smart = false }) {
    try {
      await this.connect();
      onActivity();
      if (!(await this.account()).connected) throw new Error('Sign in with ChatGPT in Cue Settings to use your Codex subscription. API-key authentication is not used for this provider.');
      const catalog = await this.models();
      // Empty maps merge with user config: disable each inherited server explicitly.
      // Only names are retained; configuration/credentials never leave this process.
      const effective = await this.request('config/read', { includeLayers: false });
      const mcpServers = Object.fromEntries(Object.keys(effective?.config?.mcp_servers || {}).map(name => [name, { enabled: false }]));
      const selected = model && model !== 'auto' ? catalog.find(m => m.model === model) : catalog.find(m => m.isDefault) || catalog[0];
      if (!selected) throw new Error('The selected Codex model is unavailable. Choose an available model in Settings.');
      if (requestedEffort && requestedEffort !== 'default' && !selected.supportedReasoningEfforts?.some(e => e.reasoningEffort === requestedEffort)) {
        throw new Error('The selected reasoning effort is unavailable for this model. Choose a supported effort.');
      }
      const { thread } = await this.request('thread/start', {
        model: selected.model, modelProvider: 'openai', cwd: this.cwd, ephemeral: true,
        sandbox: 'read-only', approvalPolicy: 'never', environments: [], dynamicTools: [], selectedCapabilityRoots: [],
        config: { ...SAFE_CONFIG, mcp_servers: mcpServers },
        baseInstructions: 'You are Cue, a concise conversational assistant. Answer only from the provided conversation and optional image. Do not use tools, access files, execute code, or take external actions.',
        developerInstructions: system,
      });
      onActivity();
      let full = '';
      const completion = this.waitFor(message => {
        const p = message.params || {}; if (p.threadId !== thread.id) return null;
        onActivity();
        if (message.method === 'item/agentMessage/delta') { full += p.delta; onToken(p.delta); }
        if (message.method === 'turn/completed') {
          if (p.turn.status !== 'completed') throw new Error(p.turn.error?.message || 'Codex answer was interrupted.');
          if (!full) {
            full = (p.turn.items || []).filter(i => i.type === 'agentMessage').map(i => i.text || '').join('\n');
            if (full) onToken(full);
          }
          if (!full.trim()) throw new Error('Codex returned an empty answer. Try again.');
          return { text: full };
        }
        return null;
      }, { isActivity: message => message.params?.threadId === thread.id });
      // Observe rejection immediately while turn/start is still pending.
      completion.catch(() => {});
      const input = [{ type: 'text', text: JSON.stringify(turns.filter(t => ['user', 'assistant'].includes(t.role)).map(t => ({ role: t.role, text: String(t.text || '') }))), text_elements: [] }];
      if (imageDataUrl) input.push({ type: 'image', url: imageDataUrl });
      const effort = requestedEffort === 'default' ? selected.defaultReasoningEffort : requestedEffort || (!smart && selected.supportedReasoningEfforts?.some(e => e.reasoningEffort === 'low') ? 'low' : selected.defaultReasoningEffort);
      await this.request('turn/start', { threadId: thread.id, input, environments: [], effort, serviceTierForTurn: 'default' });
      return (await completion).text;
    } finally { this.close(); }
  }
}

module.exports = { CodexProvider, SAFE_CONFIG };
