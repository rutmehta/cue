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
        const output = new Int16Array(input.length);
        for (let index = 0; index < input.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, input[index]));
          output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        onPcm(output.buffer);
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
        const observerPromise = new Promise((resolve) => resolve(observerResult));
        Promise.prototype.then.call(observerPromise, undefined, () => {});
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
    disconnectAudioGraph
  };
});
