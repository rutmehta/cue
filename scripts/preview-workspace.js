// Local, synthetic UI fixture. Never loads user settings, audio, or API keys.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../renderer');
const { createInitialSnapshot } = require('../src/session-state');
const snapshot = createInitialSnapshot({ settings: { sttProvider: 'local' } });
const settings = { onboarded: true, provider: 'openai', sttProvider: 'local', localStt: { engine: 'parakeet' }, localWhisper: {}, models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }, apiKeys: {}, smart: false };
const bridge = `
const handlers = {};
const emit = (name, value = {}) => (handlers[name] || []).forEach(fn => fn(value));
let fixtureSettings = ${JSON.stringify(settings)};
window.cue = new Proxy({
  platform: 'darwin',
  on: (name, fn) => (handlers[name] ||= []).push(fn),
  settingsGet: async () => fixtureSettings,
  settingsSet: async patch => (fixtureSettings = {...fixtureSettings, ...patch}),
  platformInfo: async () => ({}),
  sessionGetSnapshot: async () => (${JSON.stringify(snapshot)}),
  settingsOpen: async () => emit('settings:open'),
  whisperModels: async () => ({models: [], runtime: {available: false}}),
  ask: () => window.previewSample(),
  newChat: async () => emit('transcript:cleared'),
}, { get: (target, key) => key in target ? target[key] : () => Promise.resolve({}) });
window.CueAudioCapture.createAudioCapture = () => ({startMic: async () => {}, stopMic() {}, startSystem: async () => {}, stopSystem() {}});
window.previewSample = () => {
  for (let i = 0; i < 5; i++) {
    emit('transcript', {channel:'them', text:'How would you diagnose a service that becomes slow under load?'});
    emit('transcript', {channel:'you', text:'I would first establish when the latency changed and check which part of the request is taking longer.'});
  }
  emit('llm:start', {userBubble:'How would you approach this?', small:false});
  emit('llm:token', {text:'Start by locating the bottleneck.\\n\\nCompare latency, error rate, and traffic before and after the change. Follow one slow request through the service to see whether time is spent in the application, database, or a dependency.\\n\\nThen test one hypothesis at a time, and measure the result before changing anything else.'});
  emit('llm:done');
};
window.previewCheck = () => {
  const ids = ['toolbar', 'composer', 'send-btn', 'answer-model'];
  return ids.map(id => { const r = document.getElementById(id).getBoundingClientRect(); return id + ': ' + (r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight ? 'inside' : 'CLIPPED'); }).join(' | ');
};
window.addEventListener('error', event => parent.postMessage({error: event.message}, location.origin));
window.addEventListener('unhandledrejection', event => parent.postMessage({error: String(event.reason)}, location.origin));
`;
const page = `<!doctype html><html><head><title>Cue workspace preview</title><style>body{font:14px system-ui;background:#dce2e6;margin:24px}nav{display:flex;gap:8px;align-items:center;margin-bottom:16px}iframe{border:0;width:720px;height:600px}button,select{padding:8px}#result{margin-top:12px}</style></head><body><nav><strong>Cue · synthetic preview</strong><select id="size" aria-label="Viewport size"><option value="720,600">720 × 600</option><option value="520,320">520 × 320</option><option value="1000,720">1000 × 720</option></select><button id="sample">Load sample conversation</button><button id="check">Check layout</button></nav><iframe title="Cue preview" src="/app"></iframe><div id="result" role="status"></div><script>const frame=document.querySelector('iframe');document.querySelector('#size').onchange=e=>{const [w,h]=e.target.value.split(',');frame.style.width=w+'px';frame.style.height=h+'px';};document.querySelector('#sample').onclick=()=>frame.contentWindow.previewSample();document.querySelector('#check').onclick=()=>document.querySelector('#result').textContent=frame.contentWindow.previewCheck();window.addEventListener('message',e=>{if(e.data.error) document.querySelector('#result').textContent=e.data.error;});</script></body></html>`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(page.replace('<option value="720,600">', '<option value="600,410">600 × 410</option><option value="720,600">')
      .replace('</style>', 'iframe{width:600px;height:410px}body.dense{background:repeating-linear-gradient(0deg,#ced5db 0 2px,#fff 2px 18px)}body.dark{background:#18222b}</style>')
      .replace('</nav>', '<button id="background">Change background</button></nav>')
      .replace("const frame=document.querySelector('iframe');", "let bg=0;document.querySelector('#background').onclick=()=>{document.body.className=['','dense','dark'][++bg%3];};const frame=document.querySelector('iframe');"));
  }
  if (req.url === '/preview-bridge.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bridge); }
  const name = req.url === '/app' ? 'index.html' : path.basename(req.url || '');
  if (!/^[a-z0-9.-]+$/.test(name)) { res.writeHead(404); return res.end(); }
  try {
    let content = fs.readFileSync(path.join(root, name));
    if (name === 'index.html') content = content.toString().replace('<script src="renderer.js"></script>', '<script src="preview-bridge.js"></script><script src="renderer.js"></script>');
    res.setHeader('Content-Type', types[path.extname(name)] || 'application/octet-stream');
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
}).listen(4319, '127.0.0.1', () => console.log('Synthetic Cue preview: http://127.0.0.1:4319'));
