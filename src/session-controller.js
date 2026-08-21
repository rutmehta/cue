const { createInitialSnapshot, reduceSession } = require('./session-state');

class SessionController {
  constructor({
    now = Date.now,
    settings = {},
    startCapture = async () => {},
    stopCapture = async () => {},
    publish = () => {}
  } = {}) {
    this._now = now;
    this._startCapture = startCapture;
    this._stopCapture = stopCapture;
    this._publish = publish;
    this._snapshot = createInitialSnapshot({ now: this._now(), settings });
    this._listeners = new Set();
    this._transition = null;
    this._disposed = false;
  }

  getSnapshot() {
    return this._snapshot;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Session listener must be a function');
    }
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  dispatch(event) {
    this._assertActive();
    this._snapshot = reduceSession(this._snapshot, event);
    this._publishSnapshot();
    return this._snapshot;
  }

  start() {
    return this._runTransition(async () => {
      if (this._snapshot.session.phase !== 'idle' && this._snapshot.session.phase !== 'error') {
        return this._snapshot;
      }
      this.dispatch({ type: 'SESSION_START_REQUESTED', now: this._now() });
      try {
        await this._startCapture();
      } catch (error) {
        return this._captureFailed(error);
      }
      return this._snapshot;
    });
  }

  pause() {
    return this._runTransition(async () => {
      if (this._snapshot.session.phase !== 'starting' && this._snapshot.session.phase !== 'listening') {
        return this._snapshot;
      }
      try {
        await this._stopCapture();
      } catch (error) {
        return this._captureFailed(error);
      }
      this.dispatch({ type: 'SESSION_PAUSED', now: this._now() });
      return this._snapshot;
    });
  }

  resume() {
    return this._runTransition(async () => {
      if (this._snapshot.session.phase !== 'paused') {
        return this._snapshot;
      }
      this.dispatch({ type: 'SESSION_RESUMED', now: this._now() });
      try {
        await this._startCapture();
      } catch (error) {
        return this._captureFailed(error);
      }
      return this._snapshot;
    });
  }

  stop() {
    return this._runTransition(async () => {
      if (this._snapshot.session.phase === 'idle') {
        return this._snapshot;
      }
      this.dispatch({ type: 'SESSION_STOP_REQUESTED', now: this._now() });
      try {
        await this._stopCapture();
      } catch (error) {
        return this._captureFailed(error);
      }
      this.dispatch({ type: 'SESSION_STOPPED', now: this._now() });
      return this._snapshot;
    });
  }

  dispose() {
    this._disposed = true;
    this._listeners.clear();
  }

  _runTransition(operation) {
    this._assertActive();
    if (this._transition) {
      return this._transition;
    }

    const transition = Promise.resolve().then(operation);
    this._transition = transition;
    return transition.finally(() => {
      if (this._transition === transition) {
        this._transition = null;
      }
    });
  }

  _publishSnapshot() {
    this._publish(this._snapshot);
    for (const listener of this._listeners) {
      listener(this._snapshot);
    }
  }

  _captureFailed(error) {
    return this.dispatch({
      type: 'SESSION_CAPTURE_FAILED',
      now: this._now(),
      error: { code: 'capture_failed', message: error?.message || 'Capture operation failed' }
    });
  }

  _assertActive() {
    if (this._disposed) {
      throw new Error('SessionController is disposed');
    }
  }
}

module.exports = { SessionController };
