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
      wanted = true;
      if (active) return Promise.resolve(active);
      if (pending) return pending;
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
          if (pending === operation) pending = null;
        });
      pending = operation;
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
    const source = audioContext.createMediaStreamSource(mediaStream);
    const worklet = new WorkletNode(audioContext, 'cue-audio-processor');
    const sink = audioContext.createGain();
    sink.gain.value = 0;
    worklet.port.onmessage = (event) => onPcm(event.data);
    source.connect(worklet);
    worklet.connect(sink);
    sink.connect(audioContext.destination);
    return { source, worklet, sink };
  }

  function disconnectAudioGraph(graph) {
    if (!graph) return;
    graph.worklet.disconnect();
    graph.worklet.port.onmessage = null;
    graph.source.disconnect();
    graph.sink.disconnect();
  }

  return { connectAudioWorklet, createCaptureLifecycle, disconnectAudioGraph };
});
