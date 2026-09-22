function acceptScreenCapture({ captured, enabled, requestEpoch, currentEpoch }) {
  if (requestEpoch !== currentEpoch) return { state: 'cancelled' };
  if (!enabled) return { state: 'off' };
  return { state: 'captured', captured };
}

module.exports = { acceptScreenCapture };
