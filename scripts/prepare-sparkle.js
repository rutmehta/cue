const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const config = require('../build-resources/sparkle.json');
const root = path.resolve(__dirname, '..');
const cache = path.join(root, '.cache');
const distribution = path.join(cache, `sparkle-${config.version}`);

function prepareSparkle() {
  if (process.platform !== 'darwin') throw new Error('Sparkle packaging requires macOS.');
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, `Sparkle-${config.version}.tar.xz`);
  if (!fs.existsSync(archive)) {
    execFileSync('curl', ['-fL', '--retry', '3', `https://github.com/sparkle-project/Sparkle/releases/download/${config.version}/Sparkle-${config.version}.tar.xz`, '-o', archive], { stdio: 'inherit' });
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (digest !== config.sha256) throw new Error(`Sparkle archive checksum mismatch: ${archive}`);
  fs.mkdirSync(distribution, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', distribution]);
  return distribution;
}

function buildSparkleBridge(architecture, appPath) {
  const distribution = prepareSparkle();
  const candidates = [process.env.CUE_NODE_HEADERS, path.resolve(path.dirname(process.execPath), '../include/node'), '/opt/homebrew/include/node', '/usr/local/include/node'].filter(Boolean);
  const headers = candidates.find(candidate => fs.existsSync(path.join(candidate, 'node_api.h')));
  if (!headers) throw new Error('Install Node development headers or set CUE_NODE_HEADERS to their directory.');
  const frameworkDir = path.join(appPath, 'Contents/Frameworks');
  fs.mkdirSync(frameworkDir, { recursive: true });
  execFileSync('ditto', [path.join(distribution, 'Sparkle.framework'), path.join(frameworkDir, 'Sparkle.framework')]);
  const outputDir = path.join(appPath, 'Contents/Resources/app/native/bin');
  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-DNAPI_VERSION=8', '-bundle', '-undefined', 'dynamic_lookup', '-arch', architecture === 'x64' ? 'x86_64' : architecture, '-mmacosx-version-min=13.0', '-I', headers, '-F', distribution, '-framework', 'Sparkle', '-framework', 'AppKit', '-Wl,-rpath,@executable_path/../Frameworks', path.join(root, 'native/sparkle/bridge.mm'), '-o', path.join(outputDir, 'cue-sparkle.node')], { stdio: 'inherit' });
  fs.copyFileSync(path.join(distribution, 'LICENSE'), path.join(outputDir, 'Sparkle-LICENSE'));
  // Intel packages must not contain the Apple Silicon-only Core ML helper.
  if (architecture === 'x64') {
    for (const name of fs.readdirSync(outputDir)) {
      if (name === 'cue-local-speech' || name.endsWith('.bundle')) fs.rmSync(path.join(outputDir, name), { recursive: true, force: true });
    }
  }
}
module.exports = { prepareSparkle, buildSparkleBridge };
if (require.main === module) console.log(prepareSparkle());
