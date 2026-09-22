function createVisibilityLatch(initialVisible = false) {
  let visible = Boolean(initialVisible);

  return Object.freeze({
    isVisible: () => visible,
    markVisible: () => { visible = true; },
    markHidden: () => { visible = false; },
    toggleAction: () => (visible ? 'hide' : 'show'),
  });
}

module.exports = { createVisibilityLatch };
