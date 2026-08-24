(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CaptureLifecycle = api;
})(typeof window === 'object' ? window : null, function () {
  function createCaptureLifecycle({
    acquire,
    activate,
    disposeAcquired,
    disposeActive,
    onPhase = () => {}
  }) {
    let generation = 0;
    let wanted = false;
    let pending = null;
    let active = null;

    function start() {
      if (active) return Promise.resolve(active);
      if (wanted && pending && pending.generation === generation) return pending.promise;
      wanted = true;
      const ownGeneration = ++generation;
      let acquiredResource = null;
      onPhase('starting');

      const operation = Promise.resolve()
        .then(acquire)
        .then(async (resource) => {
          acquiredResource = resource;
          if (!wanted || generation !== ownGeneration) {
            disposeAcquired(resource);
            acquiredResource = null;
            return null;
          }
          const activated = await activate(resource);
          acquiredResource = null;
          if (!wanted || generation !== ownGeneration) {
            disposeActive(activated);
            return null;
          }
          active = activated;
          onPhase('live');
          return active;
        })
        .catch((error) => {
          if (acquiredResource) {
            disposeAcquired(acquiredResource);
            acquiredResource = null;
          }
          if (wanted && generation === ownGeneration) onPhase('error', error);
          throw error;
        })
        .finally(() => {
          if (pending && pending.promise === operation) pending = null;
        });
      pending = { generation: ownGeneration, promise: operation };
      return operation;
    }

    function stop() {
      const hadCapture = wanted || pending || active;
      wanted = false;
      generation += 1;
      if (active) disposeActive(active);
      active = null;
      if (hadCapture) onPhase('off');
    }

    return { start, stop };
  }

  function isActiveSession(snapshot) {
    const phase = snapshot && snapshot.session && snapshot.session.phase;
    return phase === 'starting' || phase === 'listening';
  }

  function describeSystemCaptureError(error, { userGesture = false } = {}) {
    const name = error && error.name;
    if (!userGesture && (name === 'InvalidStateError' || name === 'NotAllowedError'
      || name === 'PermissionDeniedError' || name === 'SecurityError')) {
      return {
        code: 'gesture_required',
        message: 'Meeting audio needs a click in Cue. End this session, then choose Start listening in the overlay to grant screen and audio access.'
      };
    }
    const code = String(error?.code || name || 'capture_failed').trim().slice(0, 64) || 'capture_failed';
    const message = String(error?.message || error || 'Meeting audio capture failed.').trim().slice(0, 500)
      || 'Meeting audio capture failed.';
    return { code, message };
  }

  function createSessionCaptureReconciler({
    startMic,
    startSystem,
    stopMic,
    stopSystem,
    onSystemError = () => {}
  }) {
    let captureWanted = false;
    let bootstrapSequence = 0;
    let activeBootstrap = null;

    function startSystemSafely(userGesture) {
      let result;
      try {
        result = startSystem();
      } catch (error) {
        try { onSystemError(error, { userGesture }); } catch (_) { /* presentation is best effort */ }
        return Promise.resolve(null);
      }
      return Promise.resolve(result).catch((error) => {
        try { onSystemError(error, { userGesture }); } catch (_) { /* presentation is best effort */ }
        return null;
      });
    }

    function beginSystemBootstrap() {
      const token = Object.freeze({ id: ++bootstrapSequence });
      activeBootstrap = token;
      void startSystemSafely(true);
      return token;
    }

    function completeSystemBootstrap(token) {
      if (activeBootstrap === token) activeBootstrap = null;
    }

    function cancelSystemBootstrap(token) {
      if (activeBootstrap !== token) return;
      activeBootstrap = null;
      stopSystem();
    }

    function reconcile(snapshot) {
      const active = isActiveSession(snapshot);
      if (active === captureWanted) return;
      captureWanted = active;
      if (active) {
        try { Promise.resolve(startMic()).catch(() => {}); } catch (_) { /* mic reports its own error */ }
        if (!activeBootstrap) void startSystemSafely(false);
      } else {
        stopMic();
        stopSystem();
      }
    }

    async function command(name, invoke, { bootstrapSystem = false } = {}) {
      const bootstrap = bootstrapSystem ? beginSystemBootstrap() : null;
      try {
        const snapshot = await invoke(name);
        if (bootstrap && !isActiveSession(snapshot)) cancelSystemBootstrap(bootstrap);
        reconcile(snapshot);
        if (bootstrap) completeSystemBootstrap(bootstrap);
        return snapshot;
      } catch (error) {
        if (bootstrap) cancelSystemBootstrap(bootstrap);
        throw error;
      }
    }

    return { command, reconcile };
  }

  function connectAudioWorklet({ audioContext, mediaStream, WorkletNode, onPcm }) {
    let source = null;
    let worklet = null;
    let sink = null;
    try {
      source = audioContext.createMediaStreamSource(mediaStream);
      worklet = new WorkletNode(audioContext, 'cue-audio-processor');
      sink = audioContext.createGain();
      sink.gain.value = 0;
      worklet.port.onmessage = (event) => onPcm(event.data);
      source.connect(worklet);
      worklet.connect(sink);
      sink.connect(audioContext.destination);
      return { source, worklet, sink };
    } catch (error) {
      if (worklet && worklet.port) worklet.port.onmessage = null;
      safeDisconnect(worklet);
      safeDisconnect(source);
      safeDisconnect(sink);
      throw error;
    }
  }

  function connectScriptProcessor({ audioContext, mediaStream, onPcm }) {
    let node = null;
    let proc = null;
    let sink = null;
    try {
      node = audioContext.createMediaStreamSource(mediaStream);
      proc = audioContext.createScriptProcessor(4096, 1, 1);
      sink = audioContext.createGain();
      sink.gain.value = 0;
      proc.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const samples = new Float32Array(input);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        onPcm({
          samples,
          sampleRate: audioContext.sampleRate,
          level: samples.length ? Math.sqrt(sum / samples.length) : 0
        });
      };
      node.connect(proc);
      proc.connect(sink);
      sink.connect(audioContext.destination);
      return { _legacy: true, node, proc, sink };
    } catch (error) {
      if (proc) proc.onaudioprocess = null;
      safeDisconnect(proc);
      safeDisconnect(node);
      safeDisconnect(sink);
      throw error;
    }
  }

  async function createAudioCaptureGraph({ audioContext, mediaStream, WorkletNode, onPcm, onWorkletFallback = () => {} }) {
    try {
      await audioContext.audioWorklet.addModule('audio-worklet-processor.js');
      return connectAudioWorklet({ audioContext, mediaStream, WorkletNode, onPcm });
    } catch (workletError) {
      try {
        const observerResult = onWorkletFallback(workletError);
        try {
          Promise.prototype.then.call(observerResult, undefined, () => {});
        } catch (_) {
          const observerPromise = new Promise((resolve) => resolve(observerResult));
          Promise.prototype.then.call(observerPromise, undefined, () => {});
        }
      } catch (_) { /* diagnostics cannot own capture cleanup */ }
      try {
        return connectScriptProcessor({ audioContext, mediaStream, onPcm });
      } catch (fallbackError) {
        try { await audioContext.close(); } catch (_) { /* preserve the graph failure */ }
        throw fallbackError;
      }
    }
  }

  function safeDisconnect(node) {
    try { if (node && typeof node.disconnect === 'function') node.disconnect(); } catch (_) { /* best effort */ }
  }

  function disconnectAudioGraph(graph) {
    if (!graph) return;
    safeDisconnect(graph.worklet);
    graph.worklet.port.onmessage = null;
    safeDisconnect(graph.source);
    safeDisconnect(graph.sink);
  }

  return {
    connectAudioWorklet,
    connectScriptProcessor,
    createAudioCaptureGraph,
    createCaptureLifecycle,
    createSessionCaptureReconciler,
    describeSystemCaptureError,
    disconnectAudioGraph
  };
});
