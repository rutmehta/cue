const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  PARAKEET_REQUIRED_FILES,
  buildParakeetArgs,
  fingerprintFiles,
  inspectParakeet
} = require('../src/parakeet-runtime');

function fakeFs(entries, options = {}) {
  const files = new Map();
  for (const entry of entries) {
    const descriptor = typeof entry === 'string' ? {} : entry;
    const filePath = typeof entry === 'string' ? entry : entry.path;
    files.set(filePath, {
      directory: Boolean(descriptor.directory),
      executable: descriptor.executable !== false,
      size: descriptor.size ?? 1,
      mtimeMs: descriptor.mtimeMs ?? 1000,
      error: descriptor.error || null
    });
  }
  return {
    constants: { X_OK: 1 },
    async stat(filePath) {
      const entry = files.get(filePath);
      if (!entry) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      if (entry.error) throw entry.error;
      return {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        isFile: () => !entry.directory,
        isDirectory: () => entry.directory
      };
    },
    async access(filePath) {
      const entry = files.get(filePath);
      if (!entry || entry.error || !entry.executable) {
        const error = (entry && entry.error) || new Error(`EACCES: ${filePath}`);
        error.code ||= 'EACCES';
        throw error;
      }
    }
  };
}

function modelFiles(modelPath) {
  return PARAKEET_REQUIRED_FILES.map((name) => `${modelPath}/${name}`);
}

function macFixtureWithOnlyOpenWhispr() {
  const modelPath = '/Users/test/.cache/openwhispr/parakeet-models/parakeet-tdt-0.6b-v3';
  return {
    platform: 'darwin', architecture: 'arm64', fs: fakeFs([
      '/Applications/OpenWhispr.app/Contents/Resources/bin/sherpa-onnx-ws-darwin-x64',
      { path: modelPath, directory: true },
      ...modelFiles(modelPath)
    ]),
    environment: {}, homeDirectory: '/Users/test',
    resourcesPath: '/Cue.app/Contents/Resources', appPath: '/repo', userDataPath: '/data'
  };
}

test('declares exactly the required Parakeet assets', () => {
  assert.deepEqual(PARAKEET_REQUIRED_FILES, [
    'encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'
  ]);
  assert.equal(Object.isFrozen(PARAKEET_REQUIRED_FILES), true);
});

test('prefers explicit runtime/model then Cue assets then OpenWhispr assets', async () => {
  const fs = fakeFs([
    '/explicit/runtime',
    { path: '/explicit/model', directory: true },
    ...modelFiles('/explicit/model'),
    '/Applications/OpenWhispr.app/Contents/Resources/bin/sherpa-onnx-ws-darwin-x64'
  ]);
  const result = await inspectParakeet({
    platform: 'darwin', architecture: 'arm64', fs,
    environment: { CUE_PARAKEET_RUNTIME: '/explicit/runtime' },
    explicitModelPath: '/explicit/model', homeDirectory: '/Users/test',
    resourcesPath: '/Cue.app/Contents/Resources', appPath: '/repo', userDataPath: '/data'
  });
  assert.equal(result.runtime.path, '/explicit/runtime');
  assert.equal(result.runtime.source, 'environment');
  assert.equal(result.model.path, '/explicit/model');
  assert.equal(result.model.source, 'settings');
  assert.equal(result.healthy, true);
});

test('finds the universal OpenWhispr runtime and cached model on this path shape', async () => {
  const result = await inspectParakeet(macFixtureWithOnlyOpenWhispr());
  assert.equal(result.runtime.path, '/Applications/OpenWhispr.app/Contents/Resources/bin/sherpa-onnx-ws-darwin-x64');
  assert.equal(result.runtime.source, 'openwhispr');
  assert.equal(result.model.path, '/Users/test/.cache/openwhispr/parakeet-models/parakeet-tdt-0.6b-v3');
  assert.equal(result.model.source, 'openwhispr');
  assert.equal(result.healthy, true);
});

test('uses metadata in a deterministic model fingerprint', async () => {
  const fs = fakeFs([
    { path: '/model/decoder.int8.onnx', size: 20, mtimeMs: 200 },
    { path: '/model/encoder.int8.onnx', size: 10, mtimeMs: 100 },
    { path: '/model/joiner.int8.onnx', size: 30, mtimeMs: 300 },
    { path: '/model/tokens.txt', size: 40, mtimeMs: 400 }
  ]);
  const first = await fingerprintFiles(['/model/tokens.txt', '/model/encoder.int8.onnx', '/model/joiner.int8.onnx', '/model/decoder.int8.onnx'], fs);
  const second = await fingerprintFiles(['/model/decoder.int8.onnx', '/model/joiner.int8.onnx', '/model/encoder.int8.onnx', '/model/tokens.txt'], fs);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
});

test('accepts synchronous injected filesystem operations', async () => {
  const modelPath = '/sync/model';
  const metadata = new Map([
    ['/sync/runtime', { directory: false }],
    [modelPath, { directory: true }],
    ...modelFiles(modelPath).map((filePath, index) => [filePath, {
      directory: false, size: index + 1, mtimeMs: index + 100
    }])
  ]);
  const fs = {
    constants: { X_OK: 1 },
    statSync(filePath) {
      const entry = metadata.get(filePath);
      if (!entry) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return {
        size: entry.size ?? 1,
        mtimeMs: entry.mtimeMs ?? 1,
        isFile: () => !entry.directory,
        isDirectory: () => entry.directory
      };
    },
    accessSync(filePath) {
      if (!metadata.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
    }
  };
  const result = await inspectParakeet({
    platform: 'linux', architecture: 'x64', fs,
    environment: { CUE_PARAKEET_RUNTIME: '/sync/runtime' }, explicitModelPath: modelPath,
    homeDirectory: '/sync-home', resourcesPath: '/sync-resources', appPath: '/sync-app', userDataPath: '/sync-data'
  });
  assert.equal(result.healthy, true);
});

test('reports invalid runtime and incomplete model assets without throwing', async () => {
  const result = await inspectParakeet({
    platform: 'darwin', architecture: 'arm64',
    fs: fakeFs([
      { path: '/bad/runtime', executable: false },
      { path: '/bad/model', directory: true },
      '/bad/model/encoder.int8.onnx'
    ]),
    environment: { CUE_PARAKEET_RUNTIME: '/bad/runtime' }, explicitModelPath: '/bad/model',
    homeDirectory: '/Users/test', resourcesPath: '/Cue.app/Contents/Resources', appPath: '/repo', userDataPath: '/data'
  });
  assert.equal(result.healthy, false);
  assert.deepEqual(result.errors.map((error) => error.code), ['runtime_not_executable', 'model_incomplete']);
  assert.deepEqual(result.model.missingFiles, ['decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(structuredClone(result), result);
});

test('builds sherpa server arguments in its required order', () => {
  assert.deepEqual(buildParakeetArgs({ modelPath: '/models/parakeet', port: 6006, threads: 4 }), [
    `--tokens=${path.join('/models/parakeet', 'tokens.txt')}`,
    `--encoder=${path.join('/models/parakeet', 'encoder.int8.onnx')}`,
    `--decoder=${path.join('/models/parakeet', 'decoder.int8.onnx')}`,
    `--joiner=${path.join('/models/parakeet', 'joiner.int8.onnx')}`,
    '--port=6006',
    '--num-threads=4'
  ]);
});
