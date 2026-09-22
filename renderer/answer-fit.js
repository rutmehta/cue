(function(root) {
  function createAnswerFitController({ measure, apply, schedule = cb => setTimeout(cb, 350), cancel = clearTimeout }) {
    let token = null, pending = null, timer = null, frozen = false;
    function reset() { if (timer !== null) cancel(timer); timer = null; pending = null; token = null; }
    return {
      reset,
      start(next) { reset(); token = next; frozen = false; },
      freeze() { frozen = true; if (timer !== null) cancel(timer); timer = null; pending = null; },
      update(node) {
        if (frozen || !Number.isInteger(token)) return;
        pending = node;
        if (timer !== null) return;
        timer = schedule(() => {
          timer = null;
          if (frozen || !pending) return;
          const size = measure(pending); pending = null;
          if (size) apply({ ...size, token });
        });
      }
    };
  }
  function createAnswerRenderGate({ hasSelection, render }) {
    const pending = new Set();
    return {
      update(node) { if (hasSelection(node)) { pending.add(node); return; } pending.delete(node); render(node); },
      resume() { for (const node of pending) if (!hasSelection(node)) { pending.delete(node); render(node); } },
      reset() { pending.clear(); }
    };
  }
  function selectionIntersects(node, selection) {
    if (!selection || selection.isCollapsed) return false;
    for (let i = 0; i < selection.rangeCount; i++) {
      try { if (selection.getRangeAt(i).intersectsNode(node)) return true; } catch {}
    }
    return false;
  }
  const api = { createAnswerFitController, createAnswerRenderGate, selectionIntersects };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CueAnswerFit = api;
})(typeof window !== 'undefined' ? window : globalThis);
