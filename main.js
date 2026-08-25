const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog, systemPreferences, Tray, Menu } = require('electron');
const path = require('path');
const os = require('os');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { parseDocumentFile } = require('./src/resume');
const { createLLM } = require('./src/llm');
const { MODES, buildFeatureRequest, createPromptPlan } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD, AudioRingBuffer } = require('./src/vad');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');
const { applyContentProtection } = require('./src/capture-protection');
const { createDisplayMediaRequestHandler } = require('./src/display-media');
const { IPC_EVENTS, IPC_INVOKES, IPC_SENDS } = require('./src/ipc-contract');
const { createLifecycleCoordinator, decideWindowClose } = require('./src/lifecycle');
const { SessionController } = require('./src/session-controller');
const { createTrayController } = require('./src/tray-menu');
const { resolveOverlayBounds, storeBoundsForDisplay, storeOverlayBoundsState } = require('./src/window-state');
const { isOverlaySender, parseSourceUpdatePayload } = require('./src/source-update');
const { batchStatusForResult, createBatchAttemptGate, createStreamingCallbackGate } = require('./src/stt-status-gate');
const { LocalSttManager } = require('./src/local-stt-manager');
const { createLocalSttRuntime } = require('./src/local-stt-runtime');
const { ParakeetTranscriber } = require('./src/parakeet-transcriber');
const { inspectParakeet } = require('./src/parakeet-runtime');
const { WhisperEngine } = require('./src/whisper-engine');

// macOS system-audio loopback (the "them" channel via getDisplayMedia) does not
// start on Electron 31–38 unless these Chromium features are enabled; without
// them getDisplayMedia rejects with "Error starting capture" and meeting audio
// silently never works. Electron 39+ wires this up itself, where this is a
// harmless no-op. Must run before app is ready.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}
const { WhisperModelManager } = require('./src/whisper-model-manager');
const { requireWhisperModel } = require('./src/whisper-model-catalog');
const { locateWhisperRuntime } = require('./src/whisper-runtime');

let win = null;
let permWin = null;
let sessionController = null;
let lifecycleCoordinator = null;
let trayController = null;
let appLaunched = false;
let quitCleanupStarted = false;
const captureProtectionByWindow = new WeakMap();
// Which global shortcuts cue actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
const shortcutState = { assist: false, say: false, leetcode: false, toggle: false, quit: false };
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = !isWindows || WIN_BUILD >= 19041;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
const MAX_TRANSCRIPT_TURNS = 200; // ~30–40 minutes of conversation at normal pace
const FLUSH_MS = 900;
const STREAM_INACTIVITY_MS = 25000; // abort a stalled LLM stream so state.busy can't wedge forever
const MIN_BYTES = Math.floor(16000 * 2 * 0.12); // ~0.12s
const RMS_GATE = 180;
let flushTimer = null;
let whisperModelManager = null;
let localSttManager = null;
let localSttRuntime = null;
let llmRequestSequence = 0;
const batchAttemptGate = createBatchAttemptGate();
const streamingCallbackGate = createStreamingCallbackGate();
let streamingCallbackToken = null;

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'them', speaking: false, durationMs: dur })
  })
};
// Pre-speech ring buffers (300ms) so we never clip the start of a word
const ringBuffers = {
  you: new AudioRingBuffer(300, 16000),
  them: new AudioRingBuffer(300, 16000)
};

function pushTranscript(turn) {
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT_TURNS) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
}

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

function publishSessionSnapshot(snapshot = sessionController?.getSnapshot()) {
  if (!snapshot) return;
  send(IPC_EVENTS.sessionSnapshot, snapshot);
}

function getTraySnapshot() {
  const snapshot = sessionController?.getSnapshot() || {};
  return {
    ...snapshot,
    overlay: { visible: Boolean(win && !win.isDestroyed() && win.isVisible()) }
  };
}

function refreshTray() {
  trayController?.update(getTraySnapshot());
}

function protectWindow(browserWindow) {
  const status = applyContentProtection(browserWindow, {
    platform: process.platform,
    windowsBuild: WIN_BUILD,
    environment: process.env
  });
  captureProtectionByWindow.set(browserWindow, status);
  return status;
}

function dispatchSession(event) {
  if (!sessionController) return null;
  return sessionController.dispatch(event);
}

function publishSttStatus(status, details = {}) {
  const phases = {
    connecting: 'probing', loading: 'loading', ready: 'ready', connected: 'ready',
    transcribing: 'transcribing', fallback: 'fallback', error: 'error',
    disconnected: 'off', off: 'off', stopping: 'off'
  };
  const phase = phases[status] || status;
  dispatchSession({
    type: 'STT_UPDATED',
    patch: { phase, detail: details.detail || null, ...details.patch }
  });
}

function sourceForChannel(channel) {
  return channel === 'you' ? 'mic' : 'system';
}

function markSourceLive(channel) {
  if (!sessionController) return;
  const snapshot = sessionController.getSnapshot();
  if (!state.capturing || !['starting', 'listening'].includes(snapshot.session.phase)) return;
  const source = sourceForChannel(channel);
  if (snapshot.sources[source].phase !== 'live') {
    dispatchSession({ type: 'SOURCE_UPDATED', source, patch: { phase: 'live', error: null } });
  }
}

function getWhisperRuntime() {
  return locateWhisperRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    architecture: process.arch,
    environment: process.env
  });
}

function publishTranscript(channel, text) {
  if (!text || !text.trim()) return;
  const turn = { channel, text: text.trim(), ts: Date.now() };
  pushTranscript(turn);
  dispatchSession({ type: 'TRANSCRIPT_FINAL', source: sourceForChannel(channel), text: turn.text });
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text });
}

async function getWhisperOverview() {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const runtime = getWhisperRuntime();
  const models = await whisperModelManager.listModels();
  return {
    runtime: {
      available: runtime.available,
      version: runtime.version,
      target: runtime.target,
      message: runtime.message || null
    },
    models
  };
}

// -------- window --------
function createWindow() {
  const savedSettings = store.getSettings();
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  let savedByDisplay = savedSettings.overlay?.boundsByDisplay || {};
  let preferredDisplayId = savedSettings.overlay?.preferredDisplayId ?? null;
  if (Object.keys(savedByDisplay).length === 0
    && savedSettings.windowX !== null && savedSettings.windowY !== null) {
    savedByDisplay = storeBoundsForDisplay(savedByDisplay, primaryDisplay.id, {
      x: savedSettings.windowX,
      y: savedSettings.windowY,
      width: 720,
      height: 600
    });
    preferredDisplayId = primaryDisplay.id;
  }
  const { displayId: _displayId, ...bounds } = resolveOverlayBounds({
    displays,
    primaryDisplayId: primaryDisplay.id,
    preferredDisplayId,
    savedByDisplay
  });

  const winOptions = {
    ...bounds,
    minWidth: 520,
    minHeight: 320,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Cue',
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // Fix 1: On Windows, set type:'toolbar' which sets WS_EX_TOOLWINDOW.
  // This removes the window from Alt+Tab AND the taskbar entirely.
  // On macOS, this is not needed (dock hiding + Mission Control handle it).
  if (isWindows) {
    winOptions.type = 'toolbar';
  }

  const createdWindow = new BrowserWindow(winOptions);
  win = createdWindow;
  const protectionStatus = protectWindow(createdWindow);
  createdWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  createdWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isMac && typeof createdWindow.setHiddenInMissionControl === 'function') createdWindow.setHiddenInMissionControl(true);
  createdWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let boundsSaveTimer = null;
  const persistBounds = () => {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (createdWindow.isDestroyed()) return;
      const currentBounds = createdWindow.getBounds();
      const display = screen.getDisplayMatching(currentBounds);
      const currentSettings = store.getSettings();
      store.setSettings({
        overlay: storeOverlayBoundsState(currentSettings.overlay, display.id, currentBounds)
      });
    }, 500);
  };
  createdWindow.on('moved', persistBounds);
  createdWindow.on('resized', persistBounds);
  createdWindow.on('close', (event) => {
    if (quitCleanupStarted) return;
    event.preventDefault();
    if (decideWindowClose(process.platform, lifecycleCoordinator) === 'quit') {
      void requestQuit();
    } else {
      createdWindow.hide();
      refreshTray();
    }
  });
  createdWindow.on('closed', () => {
    clearTimeout(boundsSaveTimer);
    if (win === createdWindow) win = null;
  });

  createdWindow.webContents.on('did-finish-load', () => {
    if (createdWindow.isDestroyed()) return;
    createdWindow.showInactive();
    publishSessionSnapshot();
    refreshTray();
    if (!protectionStatus.configured && protectionStatus.reason) {
      send('status', { message: protectionStatus.reason });
    }
  });
  createdWindow.webContents.on('render-process-gone', (_e, d) => {
    console.log('[cue] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });

  return createdWindow;
}

// -------- STT flushing (batch mode fallback) --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper), Deepgram, or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const attemptToken = batchAttemptGate.beginAttempt(channel);
    if (!attemptToken) return;
    const res = await stt.transcribe(pcm);
    const commit = batchAttemptGate.commit(attemptToken);
    if (!commit.effects && !commit.transcript) return;
    const batchStatus = batchStatusForResult(res);
    if (commit.effects && batchStatus) publishSttStatus(batchStatus.status, batchStatus.details);
    if (res.error) {
      if (commit.effects) handleSttError(res.error, settings);
      return;
    }
    if (commit.transcript && res.text && res.text.trim() && res.text.trim().length > 1 && !/^[?!.,;:\-…]+$/.test(res.text.trim())) {
      publishTranscript(channel, res.text);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
    recordEvent({ level: 'error', event: 'stt_failed', msg: e && e.message ? e.message : String(e), frame: 'flushChannel', context: { channel } });
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state cue is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (sttDisabled) return;
  const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || (err.message && err.message.includes('Quota exceeded'));
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found' || isQuota;
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: `Transcription off: your ${err.provider} key was rejected or hit a quota limit. Update your key in Settings to resume.` });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- streaming STT setup --------
function initStreamingSTT() {
  const settings = store.getSettings();
  streamingMode = false;
  const callbackToken = streamingCallbackGate.begin();
  streamingCallbackToken = callbackToken;
  const guard = (callback) => streamingCallbackGate.guard(callbackToken, callback);

  ['you', 'them'].forEach((channel) => {
    let activeProvider = settings.sttProvider || 'auto';
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: guard((ch, text) => {
        const turn = { channel: ch, text, ts: Date.now() };
        pushTranscript(turn);
        dispatchSession({ type: 'TRANSCRIPT_FINAL', source: sourceForChannel(ch), text });
        send('transcript', turn);
        send('stt:final', { channel: ch, text });
      }),
      onInterim: guard((ch, text) => {
        dispatchSession({ type: 'TRANSCRIPT_INTERIM', source: sourceForChannel(ch), text });
        send('stt:interim', { channel: ch, text });
      }),
      onError: guard((err) => {
        console.log('[streaming-stt] error', err.provider, err.message);
        const batch = createSTT(settings);
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (batch.available) {
          publishSttStatus('fallback', {
            detail: err.message,
            patch: { activeEngine: null, model: null }
          });
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
          startFlushLoop();
        } else if (!sttDisabled) {
          publishSttStatus('error', { detail: err.message });
          sttDisabled = true;
          send('status', { message: `Transcription stopped (${err.provider}): ${err.message}. The selected provider has no batch fallback.` });
        }
        streamingMode = false;
      }),
      onStatusChange: guard((ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'disconnected' && (!state.capturing || !streamingMode)) return;
        publishSttStatus(status, {
          patch: {
            activeEngine: activeProvider,
            model: activeProvider === 'deepgram' ? 'nova-3' : activeProvider === 'openai-realtime' ? 'gpt-realtime-whisper' : null
          }
        });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      })
    });
    activeProvider = sttInstance.provider;

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      streamingMode = true;
      streamingSTT[channel] = sttInstance.instance;
      sttInstance.instance.connect();
    }
  });

  if (!streamingMode) {
    streamingCallbackGate.invalidate(callbackToken);
    if (streamingCallbackToken === callbackToken) streamingCallbackToken = null;
  }

  return streamingMode;
}

function stopStreamingSTT() {
  const callbackToken = streamingCallbackToken;
  streamingCallbackToken = null;
  streamingCallbackGate.invalidate(callbackToken);
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
}

// -------- audio routing (streaming or batch) --------
function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);

  // Always run through VAD for speech state detection
  vad[channel].processChunk(buf);

  // Keep pre-speech buffer
  ringBuffers[channel].write(buf);

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: send raw PCM directly to the WebSocket
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else {
    // Batch mode: accumulate in buffers for periodic flush
    buffers[channel].push(buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
async function setCapturing(active) {
  if (active === state.capturing) return state.capturing;

  if (active) {
    batchAttemptGate.beginCapture();
    sttDisabled = false; // reset on re-enable
    const settings = store.getSettings();
    if ((settings.sttProvider || 'auto') === 'local') {
      try {
        if (!localSttRuntime) throw new Error('The local speech runtime is not ready.');
        await localSttRuntime.start(settings);
        state.capturing = true;
        console.log('[cue] capture started, mode: local');
        send('capture:state', { active: true, streaming: false, mode: 'local' });
        return true;
      } catch (error) {
        state.capturing = false;
        if (error.code === 'STARTUP_CANCELLED') {
          send('stt:status', { provider: 'local', status: 'off' });
          send('capture:state', { active: false, streaming: false, mode: 'local' });
          return false;
        }
        send('stt:status', { provider: 'local', status: 'error' });
        publishSttStatus('error', {
          detail: error.message,
          patch: { activeEngine: null, model: null }
        });
        send('status', { message: `Local transcription could not start: ${error.message} No audio was sent to a cloud provider.` });
        send('capture:state', { active: false, streaming: false, mode: 'local' });
        return false;
      }
    }

    state.capturing = true;
    publishSttStatus('probing', {
      detail: 'Selecting a speech-to-text route.',
      patch: { activeEngine: null, model: null }
    });
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      startFlushLoop();
      const batch = createSTT(settings);
      publishSttStatus(batch.available ? 'ready' : 'error', {
        detail: batch.available
          ? 'Batch transcription is ready; the engine will be reported after the first successful attempt.'
          : 'No configured speech-to-text provider is available.',
        patch: { activeEngine: null, model: null }
      });
    }
    console.log('[cue] capture started, mode:', streaming ? 'streaming' : 'batch');
    send('capture:state', { active: true, streaming: streamingMode, mode: streaming ? 'streaming' : 'batch' });
    return true;
  }

  state.capturing = false;
  batchAttemptGate.invalidate();
  publishSttStatus('off', { patch: { activeEngine: null, model: null } });
  stopFlushLoop();
  stopStreamingSTT();
  buffers.you = []; buffers.them = [];
  vad.you.reset(); vad.them.reset();
  ringBuffers.you.clear(); ringBuffers.them.clear();
  const stoppingLocal = Boolean(localSttRuntime?.isRunning());
  send('capture:state', { active: false, streaming: false, mode: stoppingLocal ? 'local' : 'off' });
  if (stoppingLocal) {
    send('stt:status', { provider: 'local', status: 'stopping' });
    try {
      await localSttRuntime.stop();
    } catch (error) {
      console.log('[local-stt] stop error', error && error.message);
    }
  }
  return false;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  let streamSettled = false; // drop stray tokens from a stream we've already abandoned
  let requestId = null;
  let requestStarted = false;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null
      ? def.userBubble
      : (mode === 'ask' ? userText : mode === 'answerThis' ? `"${(userText || '').slice(0, 60)}${userText && userText.length > 60 ? '…' : ''}"` : null);
    const promptPlan = createPromptPlan(mode, transcript, userText);
    const category = promptPlan.category;
    send('llm:start', { userBubble, small: !!def.small, category });

    if (!llm.ready) {
      const message = llm.configurationError || ('Complete the ' + settings.provider + ' provider settings. Model: ' + (llm.model || 'unset') + '.');
      requestId = `request-${Date.now()}-${++llmRequestSequence}`;
      dispatchSession({
        type: 'LLM_REQUEST_STARTED',
        id: requestId,
        provider: llm.provider,
        model: llm.model,
        contextUsed: { screen: false, mic: false, system: false }
      });
      requestStarted = true;
      dispatchSession({ type: 'LLM_REQUEST_FAILED', id: requestId, error: { code: 'configuration_error', message } });
      send('llm:error', { message });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try {
        imageDataUrl = await captureScreenshot();
        if (!imageDataUrl) throw new Error('No screen source was available.');
      }
      catch (e) {
        recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
        const message = process.platform === 'darwin'
          ? 'Screen capture needs permission — grant Screen Recording to cue in System Settings.'
          : process.platform === 'win32'
            ? 'Screen capture failed. Make sure cue is not blocked by Windows privacy or security software, then try again.'
            : 'Screen capture failed. Check your desktop capture permissions, then try again.';
        send('status', { message });
      }
    }

    const settingsForPrompt = store.getSettings();
    const prompt = buildFeatureRequest(mode, {
      plan: promptPlan,
      userText: userText || '',
      settings: settingsForPrompt,
      screenIncluded: Boolean(imageDataUrl)
    });
    const system = prompt.system;
    const built = prompt.text;
    requestId = `request-${Date.now()}-${++llmRequestSequence}`;
    dispatchSession({
      type: 'LLM_REQUEST_STARTED',
      id: requestId,
      provider: llm.provider,
      model: llm.model,
      contextUsed: prompt.contextUsed
    });
    requestStarted = true;

    // Watchdog: a provider that stalls mid-stream would otherwise hang the await forever,
    // leaving state.busy = true and wedging every later question until an app restart.
    let watchdog = null;
    let rearm = () => {};
    const stalled = new Promise((_res, reject) => {
      rearm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => reject(new Error('the model stopped responding (timed out). Please try again.')), STREAM_INACTIVITY_MS);
      };
      rearm();
    });
    try {
      await Promise.race([
        llm.stream({
          system,
          turns: [{ role: 'user', text: built }],
          imageDataUrl,
          onToken: (t) => {
            if (streamSettled) return;
            rearm();
            const snapshot = sessionController?.getSnapshot();
            if (snapshot?.request.phase !== 'streaming') {
              dispatchSession({ type: 'LLM_TOKEN_STARTED', id: requestId });
            }
            send('llm:token', { text: t });
          }
        }),
        stalled
      ]);
    } finally {
      streamSettled = true;
      clearTimeout(watchdog);
    }
    dispatchSession({ type: 'LLM_REQUEST_FINISHED', id: requestId });
    send('llm:done', {});
  } catch (e) {
    if (requestStarted) {
      dispatchSession({
        type: 'LLM_REQUEST_FAILED',
        id: requestId,
        error: { code: 'generation_failed', message: e && e.message ? e.message : String(e) }
      });
    }
    recordEvent({ level: 'error', event: 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider } });
    send('llm:error', { message: e && e.message ? e.message : String(e) });
  } finally {
    streamSettled = true;
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle(IPC_INVOKES.sessionGetSnapshot, () => sessionController?.getSnapshot() || null);
ipcMain.handle(IPC_INVOKES.sessionCommand, (_event, command) => {
  if (!lifecycleCoordinator) throw new Error('Cue session is not ready.');
  return command === 'quit' ? requestQuit() : lifecycleCoordinator.command(command);
});
ipcMain.handle(IPC_INVOKES.windowCommand, (_event, command) => {
  if (!lifecycleCoordinator) throw new Error('Cue window is not ready.');
  if (command === 'lock') return lockInteraction();
  if (!['show', 'hide', 'collapse', 'unlock', 'recenter'].includes(command)) {
    throw new TypeError(`Unknown window command: ${String(command)}`);
  }
  return lifecycleCoordinator.command(command);
});
ipcMain.handle(IPC_INVOKES.settingsOpen, () => {
  if (!lifecycleCoordinator) throw new Error('Cue settings are not ready.');
  return lifecycleCoordinator.command('settings');
});
ipcMain.handle(IPC_INVOKES.captureProtection, (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  return captureProtectionByWindow.get(senderWindow) || {
    configured: false,
    mode: 'error',
    reason: 'Capture protection status is unavailable for this window.'
  };
});
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  sttDisabled = false;
  const settings = store.setSettings(patch);
  dispatchSession({
    type: 'SETTINGS_UPDATED',
    settings: {
      ...settings,
      localStt: settings.localStt || { engine: settings.sttProvider === 'local' ? 'whisper' : 'auto' }
    }
  });
  return settings;
});
ipcMain.handle('capture:toggle', async () => {
  if (!sessionController) throw new Error('Cue session is not ready.');
  const phase = sessionController.getSnapshot().session.phase;
  if (phase === 'idle' || phase === 'error') await sessionController.start();
  else if (phase === 'paused') await sessionController.resume();
  else await sessionController.stop();
  return state.capturing;
});
ipcMain.handle('capture:state', () => ({
  active: ['starting', 'listening'].includes(sessionController?.getSnapshot().session.phase)
}));
ipcMain.handle('whisper:models', () => getWhisperOverview());
ipcMain.handle('whisper:model-download', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const result = await whisperModelManager.download(modelId, (progress) => send('whisper:download-progress', progress));
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-cancel', (_event, modelId) => {
  if (!whisperModelManager) return false;
  return whisperModelManager.cancelDownload(modelId);
});
ipcMain.handle('whisper:model-delete', async (_event, modelId) => {
  requireWhisperModel(modelId);
  if (localSttManager?.getStatus().activeEngine === 'whisper'
    && (store.getSettings().localWhisper?.modelId || 'base.en') === modelId) {
    throw new Error('Stop listening before deleting the active model.');
  }
  const result = await whisperModelManager.deleteModel(modelId);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-import', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  requireWhisperModel(modelId);
  if (localSttManager?.getStatus().activeEngine === 'whisper'
    && (store.getSettings().localWhisper?.modelId || 'base.en') === modelId) {
    throw new Error('Stop listening before replacing the active model.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: `Import ggml-${modelId}.bin`,
    properties: ['openFile'],
    filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }]
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const result = await whisperModelManager.importModel(modelId, selection.filePaths[0]);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION
}));
ipcMain.handle('transcript:clear', () => {
  transcript.splice(0, transcript.length);
  dispatchSession({ type: 'TRANSCRIPT_CLEARED' });
  return { ok: true };
});
ipcMain.on(IPC_SENDS.sourceUpdate, (event, payload) => {
  if (!sessionController || !isOverlaySender(event, win)) return;
  try {
    const update = parseSourceUpdatePayload(payload);
    dispatchSession({ type: 'SOURCE_UPDATED', source: update.source, patch: update.patch });
  } catch (error) {
    console.log('[cue] rejected source lifecycle update', error.message);
  }
});
ipcMain.on(IPC_SENDS.sourcePcm, (event, message) => {
  if (!sessionController || !isOverlaySender(event, win) || !state.capturing) return;
  const source = message?.source;
  const channel = source === 'mic' ? 'you' : source === 'system' ? 'them' : null;
  if (!channel) return;
  const snapshot = sessionController.getSnapshot();
  if (!['starting', 'listening'].includes(snapshot.session.phase)) return;
  try {
    markSourceLive(channel);
    if (localSttRuntime?.isRunning()) localSttRuntime.push(channel, message.payload);
    else routeAudio(channel, message?.payload?.pcm);
  } catch (error) {
    dispatchSession({
      type: 'SOURCE_UPDATED',
      source,
      patch: { phase: 'error', error: { code: 'invalid_audio', message: error.message } }
    });
  }
});
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('app:quit', () => { void requestQuit(); });
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
// -------- resume / job-description file import --------
// The dialog runs in MAIN and is filtered to pdf/docx; the renderer never supplies a path.
// The parsed text is RETURNED to the renderer, which drops it into the existing
// #resume-text / #job-description textareas so settings keep a single source of truth.
async function pickAndParseDocument() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Resume / Job description', extensions: ['pdf', 'docx'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  return { fileName: path.basename(filePath), text };
}
ipcMain.handle('profile:pickDocument', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    return { canceled: false, fileName: picked.fileName, text: picked.text };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => revokeAppLinkCaller(callerId));

// -------- permissions IPC --------
ipcMain.handle('permissions:check', () => getPermissionStatus());
ipcMain.handle('permissions:request', () => requestPermissions());
ipcMain.on('permissions:continue', async () => {
  const status = await getPermissionStatus();
  if (status.mic === 'granted' && status.screen === 'granted') {
    if (permWin) { permWin.close(); permWin = null; }
    await launchApp();
  }
});

// -------- shortcuts --------
function registerShortcuts() {
  shortcutState.assist = globalShortcut.register('CommandOrControl+Return', () => runFeature('assist', ''));
  shortcutState.say = globalShortcut.register('CommandOrControl+Shift+Return', () => runFeature('say', ''));
  shortcutState.leetcode = globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  shortcutState.toggle = globalShortcut.register('CommandOrControl+Shift+/', () => {
    const toggled = lifecycleCoordinator?.command('toggle');
    if (toggled) void toggled.catch((error) => recordEvent({
      level: 'warn', event: 'overlay_toggle_failed', msg: error?.message || String(error), frame: 'registerShortcuts'
    }));
  });
  shortcutState.quit = globalShortcut.register('CommandOrControl+Shift+X', () => { void requestQuit(); });
  for (const [name, wasRegistered] of Object.entries(shortcutState)) {
    if (!wasRegistered) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'another application holds the ' + name + ' shortcut', frame: 'registerShortcuts', context: { shortcut: name } });
    }
  }
}

// -------- permissions --------
// systemPreferences.getMediaAccessStatus('screen') is unreliable: it can return
// 'not-determined' or 'denied' even after the user has granted Screen Recording,
// especially in dev mode (unsigned / no proper app bundle).  As a fallback we
// actually attempt a capture and inspect the thumbnail — if it contains any
// non-zero pixel data, macOS is giving us real screen content, i.e. granted.
async function verifyScreenAccess() {
  const sysStatus = systemPreferences.getMediaAccessStatus('screen');
  if (sysStatus === 'granted') return 'granted';

  // Fallback: try an actual capture and check the thumbnail for real pixels.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
    if (sources.length > 0) {
      const bmp = sources[0].thumbnail.toBitmap();
      // toBitmap() returns raw RGBA bytes; any non-zero byte means real content
      if (bmp && bmp.some(byte => byte !== 0)) return 'granted';
    }
  } catch (_) {}

  return sysStatus;  // return the original system status if fallback didn't help
}

async function getPermissionStatus() {
  if (process.platform !== 'darwin') return { mic: 'granted', screen: 'granted' };
  return {
    mic: systemPreferences.getMediaAccessStatus('microphone'),
    screen: await verifyScreenAccess(),
  };
}

async function requestPermissions() {
  if (process.platform !== 'darwin') return true;

  // Trigger the macOS microphone permission dialog (first-use only)
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  // Trigger the macOS screen-recording permission dialog (first-use only).
  // There is no askForMediaAccess('screen'), but attempting to enumerate
  // sources via desktopCapturer will cause macOS to prompt the user.
  const screenStatus = await verifyScreenAccess();
  if (screenStatus !== 'granted') {
    try { await desktopCapturer.getSources({ types: ['screen'] }); } catch (_) {}
  }

  const status = await getPermissionStatus();
  return status.mic === 'granted' && status.screen === 'granted';
}

function createPermissionsWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 500, H = 540;
  const createdWindow = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 2),
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    skipTaskbar: false,
    show: false,
    title: 'Cue',
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  permWin = createdWindow;
  protectWindow(createdWindow);
  createdWindow.loadFile(path.join(__dirname, 'renderer', 'permissions.html'));
  createdWindow.webContents.on('did-finish-load', () => createdWindow.show());
  createdWindow.on('closed', () => {
    if (permWin === createdWindow) permWin = null;
  });
  return createdWindow;
}

function showOverlay() {
  if (!win || win.isDestroyed()) createWindow();
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(false);
    win.showInactive();
    publishSessionSnapshot();
    refreshTray();
  }
}

function hideOverlay() {
  if (win && !win.isDestroyed()) win.hide();
  refreshTray();
}

function toggleOverlay() {
  if (win && !win.isDestroyed() && win.isVisible()) hideOverlay();
  else showOverlay();
}

function collapseOverlay() {
  send('hide:toggle', {});
}

function unlockInteraction() {
  if (!win || win.isDestroyed()) createWindow();
  win.setIgnoreMouseEvents(false);
  win.showInactive();
  refreshTray();
}

function lockInteraction() {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true });
}

function recenterOverlay() {
  if (!win || win.isDestroyed()) createWindow();
  const currentDisplay = screen.getDisplayMatching(win.getBounds());
  const { displayId: _displayId, ...bounds } = resolveOverlayBounds({
    displays: [currentDisplay],
    primaryDisplayId: currentDisplay.id,
    savedByDisplay: {}
  });
  win.setBounds(bounds);
  win.showInactive();
  refreshTray();
}

function openSettings() {
  showOverlay();
  send('settings:open', {});
}

function cancelActiveDownload() {
  if (whisperModelManager?.activeDownload) {
    whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId);
  }
}

async function stopLocalEngines() {
  batchAttemptGate.invalidate();
  await Promise.allSettled([
    localSttRuntime?.isRunning() ? localSttRuntime.stop() : Promise.resolve(),
    stopAppLink()
  ]);
}

function destroyWindowsAndTray() {
  trayController?.destroy();
  trayController = null;
  for (const browserWindow of [win, permWin]) {
    if (browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.removeAllListeners('close');
      browserWindow.destroy();
    }
  }
  win = null;
  permWin = null;
  sessionController?.dispose();
}

function requestQuit() {
  if (quitCleanupStarted && lifecycleCoordinator) return lifecycleCoordinator.command('quit');
  quitCleanupStarted = true;
  if (!lifecycleCoordinator) {
    app.exit(0);
    return Promise.resolve();
  }
  return lifecycleCoordinator.command('quit');
}

async function createAppTray() {
  try {
    const fileIcon = await app.getFileIcon(process.execPath, { size: 'small' });
    const icon = fileIcon.resize({ width: 18, height: 18 });
    if (isMac) icon.setTemplateImage(true);
    trayController = createTrayController({
      Tray,
      Menu,
      icon,
      title: isMac ? 'Cue' : '',
      tooltip: isMac ? 'Cue — show/hide with ⌘⇧/' : 'Cue — show/hide',
      getSnapshot: getTraySnapshot,
      subscribe: (listener) => sessionController.subscribe(() => listener(getTraySnapshot())),
      command: (command) => lifecycleCoordinator?.command(command)
    });
    return true;
  } catch (error) {
    console.log('[cue] tray unavailable:', error && error.message);
    return false;
  }
}

// -------- launch (called after permissions are confirmed) --------
async function launchApp() {
  if (appLaunched) {
    showOverlay();
    return;
  }
  appLaunched = true;
  if (isMac && app.dock) app.dock.hide();

  const userDataPath = app.getPath('userData');
  whisperModelManager = new WhisperModelManager({ userDataPath });
  const parakeetTranscriber = new ParakeetTranscriber({
    inspect: () => inspectParakeet({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userDataPath,
      platform: process.platform,
      architecture: process.arch,
      environment: process.env
    })
  });
  const parakeetEngine = {
    id: 'parakeet',
    inspect: (settings) => parakeetTranscriber.inspect(settings),
    start: ({ inspection }) => parakeetTranscriber.start(inspection),
    transcribe: (segment) => parakeetTranscriber.transcribe(segment),
    stop: () => parakeetTranscriber.stop()
  };
  const whisperEngine = new WhisperEngine({
    modelManager: whisperModelManager,
    locateRuntime: async () => getWhisperRuntime()
  });
  localSttManager = new LocalSttManager({
    engines: [parakeetEngine, whisperEngine],
    dispatch: (event) => dispatchSession(event),
    loadBenchmark: () => store.getSettings().localStt?.benchmark || null,
    saveBenchmark: async (benchmark) => { store.setSettings({ localStt: { benchmark } }); },
    onObserverError: (error, details) => recordEvent({
      level: 'error',
      event: 'local_stt_observer_failed',
      code: details.kind,
      msg: error?.message || String(error),
      frame: 'LocalSttManager'
    })
  });
  localSttRuntime = createLocalSttRuntime({
    manager: localSttManager,
    publishTranscript,
    publishSpeechState: (channel, speaking, durationMs) => send('vad:state', { channel, speaking, durationMs }),
    publishError: (error) => send('status', {
      message: `Local transcription error: ${error.message}. Audio was not sent to a cloud fallback.`
    })
  });

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using Cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler(
    createDisplayMediaRequestHandler({ desktopCapturer }),
    { useSystemPicker: false }
  );

  sessionController = new SessionController({
    settings: store.getSettings(),
    startCapture: async () => {
      const active = await setCapturing(true);
      if (!active) throw new Error('Capture could not be started.');
    },
    stopCapture: () => setCapturing(false),
    publish: publishSessionSnapshot,
    onObserverError: (error, details) => recordEvent({
      level: 'error',
      event: 'session_observer_failed',
      code: details.kind,
      msg: error?.message || String(error),
      frame: 'SessionController',
      context: { revision: details.snapshot.revision }
    })
  });

  createWindow();
  const trayEnabled = await createAppTray();
  lifecycleCoordinator = createLifecycleCoordinator({
    platform: process.platform,
    trayEnabled,
    showOverlay,
    hideOverlay,
    toggleOverlay,
    collapseOverlay,
    startSession: () => sessionController.start(),
    pauseSession: () => sessionController.pause(),
    resumeSession: () => sessionController.resume(),
    stopSession: () => sessionController.stop(),
    unlockInteraction,
    recenterOverlay,
    openSettings,
    stopLocalEngines,
    cancelDownloads: cancelActiveDownload,
    unregisterShortcuts: () => globalShortcut.unregisterAll(),
    destroyWindowsAndTray,
    exit: () => app.exit(0)
  });
  refreshTray();

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      session: sessionController.getSnapshot(),
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...shortcutState },
      windowAlive: !!(win && !win.isDestroyed()),
    }),
    setCapturing: (active) => active ? sessionController.start() : sessionController.stop(),
    getWindow: () => win,
  });

  registerShortcuts();
  publishSessionSnapshot();
}

// -------- lifecycle --------
app.whenReady().then(async () => {
  app.setName('Cue');
  if (isWindows) process.title = 'Cue';

  if (isMac) {
    const allGranted = await requestPermissions();
    if (!allGranted) {
      // Show the permissions gate — the dock stays visible so the user can find the app.
      createPermissionsWindow();
      return;
    }
  }

  await launchApp();
});

app.on('activate', async () => {
  if (quitCleanupStarted) return;
  if (!appLaunched) {
    if (!permWin || permWin.isDestroyed()) createPermissionsWindow();
    return;
  }
  showOverlay();
});

app.on('before-quit', (event) => {
  if (quitCleanupStarted) return;
  event.preventDefault();
  void requestQuit();
});

app.on('will-quit', (event) => {
  if (quitCleanupStarted) return;
  event.preventDefault();
  void requestQuit();
});

app.on('window-all-closed', () => {
  if (quitCleanupStarted || isMac) return;
  if (lifecycleCoordinator?.closeDecision() === 'quit') void requestQuit();
});
