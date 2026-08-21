function errorResult(error) {
  return {
    configured: false,
    mode: 'error',
    reason: error && error.message ? error.message : String(error)
  };
}

function isDisabled(options) {
  const environment = options.environment || options.env || process.env;
  return options.noProtect === true || Boolean(environment && environment.CUE_NO_PROTECT);
}

function protectionMode(platform, windowsBuild) {
  if (platform === 'darwin') return 'macos-best-effort';
  if (platform === 'win32') {
    return Number(windowsBuild) >= 19041 ? 'windows-excluded' : 'windows-black-fallback';
  }
  return null;
}

function applyContentProtection(win, options = {}) {
  if (isDisabled(options)) {
    return {
      configured: false,
      mode: 'disabled',
      reason: 'Content protection disabled by CUE_NO_PROTECT.'
    };
  }

  const platform = options.platform || process.platform;
  const mode = protectionMode(platform, options.windowsBuild);
  if (!mode) {
    return {
      configured: false,
      mode: 'unsupported',
      reason: platform === 'linux'
        ? 'Content protection is unavailable on Linux.'
        : 'Content protection is unavailable on this platform.'
    };
  }

  try {
    win.setContentProtection(true);
    if (win.isContentProtected() !== true) {
      return {
        configured: false,
        mode: 'error',
        reason: 'Content protection could not be verified.'
      };
    }
  } catch (error) {
    return errorResult(error);
  }

  return { configured: true, mode };
}

module.exports = {
  applyContentProtection
};
