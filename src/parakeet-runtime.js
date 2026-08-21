const crypto = require('node:crypto');
const nativeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LocalSttError, normalizeEngineInspection } = require('./local-stt-engine');

const PARAKEET_REQUIRED_FILES = Object.freeze([
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt'
]);
const PARAKEET_MODEL_NAME = 'parakeet-tdt-0.6b-v3';
const OPENWHISPR_RUNTIME = '/Applications/OpenWhispr.app/Contents/Resources/bin/sherpa-onnx-ws-darwin-x64';

function defaultFileSystem() {
  return {
    constants: nativeFs.constants,
    stat: nativeFs.promises.stat.bind(nativeFs.promises),
    access: nativeFs.promises.access.bind(nativeFs.promises)
  };
}

function fileSystemFor(fs) {
  return fs || defaultFileSystem();
}

async function invoke(fs, method, ...args) {
  const direct = fs && fs[method];
  const promised = fs && fs.promises && fs.promises[method];
  const synchronous = fs && fs[`${method}Sync`];
  const fn = promised || direct || synchronous;
  const receiver = promised ? fs.promises : fs;
  if (typeof fn !== 'function') {
    throw new TypeError(`Injected filesystem does not provide ${method}().`);
  }
  if (synchronous && fn === synchronous) return fn.call(receiver, ...args);
  if (!promised && fn.length > args.length) {
    return new Promise((resolve, reject) => {
      fn.call(receiver, ...args, (error, value) => error ? reject(error) : resolve(value));
    });
  }
  return fn.call(receiver, ...args);
}

async function stat(fs, filePath) {
  return invoke(fs, 'stat', filePath);
}

async function access(fs, filePath) {
  const xOk = fs.constants && fs.constants.X_OK !== undefined ? fs.constants.X_OK : nativeFs.constants.X_OK;
  return invoke(fs, 'access', filePath, xOk);
}

function isMissing(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function toMtimeMs(fileStat) {
  if (Number.isFinite(fileStat.mtimeMs)) return fileStat.mtimeMs;
  if (fileStat.mtime instanceof Date) return fileStat.mtime.getTime();
  return 0;
}

async function fingerprintFiles(paths, fs) {
  const activeFs = fileSystemFor(fs);
  const rows = [];
  for (const filePath of [...paths].map(String).sort()) {
    const fileStat = await stat(activeFs, filePath);
    rows.push(`${filePath}\u0000${fileStat.size}\u0000${toMtimeMs(fileStat)}`);
  }
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

function addCandidate(candidates, candidate) {
  if (candidate.path && !candidates.some((current) => current.path === candidate.path)) {
    candidates.push(candidate);
  }
}

function runtimeCandidates(options) {
  const name = `sherpa-onnx-ws-${options.platform}-${options.architecture}`;
  const candidates = [];
  if (options.environment.CUE_PARAKEET_RUNTIME) {
    addCandidate(candidates, { path: options.environment.CUE_PARAKEET_RUNTIME, source: 'environment' });
  }
  for (const directory of [
    path.join(options.resourcesPath, 'bin'),
    path.join(options.resourcesPath, 'parakeet', 'bin'),
    path.join(options.appPath, 'resources', 'bin')
  ]) {
    addCandidate(candidates, { path: path.join(directory, name), source: 'bundle' });
  }
  for (const directory of [
    path.join(options.userDataPath, 'parakeet', 'bin'),
    path.join(options.userDataPath, 'parakeet', 'runtime'),
    path.join(options.userDataPath, 'parakeet-runtime')
  ]) {
    addCandidate(candidates, { path: path.join(directory, name), source: 'cache' });
  }
  if (options.platform === 'darwin') {
    addCandidate(candidates, { path: OPENWHISPR_RUNTIME, source: 'openwhispr' });
  }
  return candidates;
}

function modelCandidates(options) {
  const candidates = [];
  if (options.explicitModelPath) {
    addCandidate(candidates, { path: options.explicitModelPath, source: 'settings' });
  }
  for (const directory of [
    path.join(options.resourcesPath, 'parakeet-models'),
    path.join(options.resourcesPath, 'models'),
    path.join(options.resourcesPath, 'parakeet', 'models'),
    path.join(options.appPath, 'resources', 'parakeet-models')
  ]) {
    addCandidate(candidates, { path: path.join(directory, PARAKEET_MODEL_NAME), source: 'bundle' });
  }
  for (const directory of [
    path.join(options.userDataPath, 'parakeet-models'),
    path.join(options.userDataPath, 'models'),
    path.join(options.userDataPath, 'parakeet', 'models')
  ]) {
    addCandidate(candidates, { path: path.join(directory, PARAKEET_MODEL_NAME), source: 'cache' });
  }
  addCandidate(candidates, {
    path: path.join(options.homeDirectory, '.cache', 'openwhispr', 'parakeet-models', PARAKEET_MODEL_NAME),
    source: 'openwhispr'
  });
  return candidates;
}

async function firstPresentCandidate(candidates, fs) {
  for (const candidate of candidates) {
    try {
      return { candidate, fileStat: await stat(fs, candidate.path) };
    } catch (error) {
      if (!isMissing(error)) return { candidate, error };
    }
  }
  return null;
}

function missingRuntimeError() {
  return new LocalSttError(
    'runtime_missing',
    'No Parakeet runtime was found.',
    'Install or configure a Parakeet runtime.'
  );
}

function runtimeExecutableError(runtimePath) {
  return new LocalSttError(
    'runtime_not_executable',
    `The Parakeet runtime is not executable: ${runtimePath}`,
    'Choose an executable Parakeet runtime or repair its permissions.'
  );
}

function missingModelError(modelPath = null) {
  return new LocalSttError(
    'model_missing',
    modelPath ? `No Parakeet model directory was found at ${modelPath}.` : 'No Parakeet model was found.',
    'Download or configure a complete Parakeet model.'
  );
}

function incompleteModelError(modelPath, missingFiles) {
  return new LocalSttError(
    'model_incomplete',
    `The Parakeet model is incomplete: ${missingFiles.join(', ')}.`,
    'Download or configure a complete Parakeet model.',
    { path: modelPath, missingFiles }
  );
}

async function inspectRuntime(candidates, fs) {
  const found = await firstPresentCandidate(candidates, fs);
  if (!found) return { runtime: null, error: missingRuntimeError() };
  const runtime = { path: found.candidate.path, source: found.candidate.source, version: null };
  if (found.error || !found.fileStat || !found.fileStat.isFile()) {
    return { runtime, error: found.error && isMissing(found.error) ? missingRuntimeError() : runtimeExecutableError(runtime.path) };
  }
  try {
    await access(fs, runtime.path);
    return { runtime, error: null };
  } catch {
    return { runtime, error: runtimeExecutableError(runtime.path) };
  }
}

async function inspectModel(candidates, fs) {
  const found = await firstPresentCandidate(candidates, fs);
  if (!found) return { model: null, error: missingModelError() };
  const model = { path: found.candidate.path, source: found.candidate.source, fingerprint: null };
  if (found.error || !found.fileStat || !found.fileStat.isDirectory()) {
    return { model, error: missingModelError(model.path) };
  }

  const missingFiles = [];
  const paths = PARAKEET_REQUIRED_FILES.map((name) => path.join(model.path, name));
  for (let index = 0; index < paths.length; index += 1) {
    try {
      const fileStat = await stat(fs, paths[index]);
      if (!fileStat.isFile()) missingFiles.push(PARAKEET_REQUIRED_FILES[index]);
    } catch {
      missingFiles.push(PARAKEET_REQUIRED_FILES[index]);
    }
  }
  if (missingFiles.length > 0) {
    return { model, error: incompleteModelError(model.path, missingFiles) };
  }

  try {
    model.fingerprint = await fingerprintFiles(paths, fs);
    return { model, error: null };
  } catch {
    const missingFiles = [...PARAKEET_REQUIRED_FILES];
    return { model, error: incompleteModelError(model.path, missingFiles) };
  }
}

function normalizeOptions(options = {}) {
  const environment = options.environment || process.env;
  const homeDirectory = options.homeDirectory || environment.HOME || environment.USERPROFILE || os.homedir();
  const appPath = options.appPath || path.resolve(__dirname, '..');
  const resourcesPath = options.resourcesPath || process.resourcesPath || path.join(appPath, 'resources');
  return {
    platform: options.platform || process.platform,
    architecture: options.architecture || process.arch,
    environment,
    homeDirectory,
    appPath,
    resourcesPath,
    userDataPath: options.userDataPath || path.join(homeDirectory, '.cue'),
    explicitModelPath: options.explicitModelPath || '',
    fs: fileSystemFor(options.fs)
  };
}

async function inspectParakeet(options = {}) {
  const normalized = normalizeOptions(options);
  const [runtimeResult, modelResult] = await Promise.all([
    inspectRuntime(runtimeCandidates(normalized), normalized.fs),
    inspectModel(modelCandidates(normalized), normalized.fs)
  ]);
  const errors = [runtimeResult.error, modelResult.error].filter(Boolean);
  return normalizeEngineInspection({
    id: 'parakeet',
    healthy: errors.length === 0,
    runtime: runtimeResult.runtime,
    model: modelResult.model,
    errors
  });
}

function buildParakeetArgs({ modelPath, port, threads }) {
  return [
    `--tokens=${path.join(modelPath, 'tokens.txt')}`,
    `--encoder=${path.join(modelPath, 'encoder.int8.onnx')}`,
    `--decoder=${path.join(modelPath, 'decoder.int8.onnx')}`,
    `--joiner=${path.join(modelPath, 'joiner.int8.onnx')}`,
    `--port=${port}`,
    `--num-threads=${threads}`
  ];
}

module.exports = {
  PARAKEET_REQUIRED_FILES,
  buildParakeetArgs,
  fingerprintFiles,
  inspectParakeet
};
