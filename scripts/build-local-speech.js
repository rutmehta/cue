const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.log('Native Core ML speech is available on Apple Silicon Macs.');
  process.exit(0);
}
const root = path.resolve(__dirname, '..');
const packagePath = path.join(root, 'native/local-speech');
execFileSync('swift', ['build', '-c', 'release', '--package-path', packagePath], { stdio: 'inherit' });
const buildPath = execFileSync('swift', ['build', '-c', 'release', '--show-bin-path', '--package-path', packagePath], { encoding: 'utf8' }).trim();
const destination = path.join(root, 'native/bin');
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(buildPath, 'cue-local-speech'), path.join(destination, 'cue-local-speech'));
fs.chmodSync(path.join(destination, 'cue-local-speech'), 0o755);
fs.rmSync(path.join(destination, 'FluidAudio-LICENSE'), { force: true });
fs.copyFileSync(path.join(packagePath, '.build/checkouts/FluidAudio/LICENSE'), path.join(destination, 'FluidAudio-LICENSE'));
for (const name of fs.readdirSync(buildPath).filter(name => name.endsWith('.bundle'))) {
  fs.rmSync(path.join(destination, name), { recursive: true, force: true });
  fs.cpSync(path.join(buildPath, name), path.join(destination, name), { recursive: true });
}
console.log('Native local speech helper is ready.');
