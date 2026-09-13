// Local release pipeline. Signing secrets remain in macOS Keychain.
// Publication is explicit and separate: upload these verified files together
// in one GitHub release so the stable /latest/download/appcast.xml stays atomic.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { prepareSparkle } = require('./prepare-sparkle');
const pkg = require('../package.json');
const config = require('../build-resources/sparkle.json');
const root = path.resolve(__dirname, '..');
const identity = process.env.CUE_SIGN_IDENTITY || 'Developer ID Application: Rut Mehta (FX4926673K)';
const profile = process.env.CUE_NOTARY_PROFILE;
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });

function signApp(appPath) {
  const entitlements = path.join(root, 'build-resources/entitlements.mac.plist');
  function sign(file, sparkle = false) {
    const args = ['--force', '--sign', identity, '--options', 'runtime', '--timestamp'];
    if (sparkle) {
      if (file.endsWith('/Downloader.xpc')) args.push('--preserve-metadata=entitlements');
    } else args.push('--entitlements', entitlements);
    run('codesign', [...args, file]);
  }
  function walk(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    const sparkle = file.includes('/Sparkle.framework');
    if (stat.isDirectory()) {
      // Sign nested helper directories before a framework's main executable.
      // codesign validates the enclosing framework even when given that binary.
      const names = fs.readdirSync(file).sort((a, b) =>
        Number(fs.lstatSync(path.join(file, b)).isDirectory()) - Number(fs.lstatSync(path.join(file, a)).isDirectory()));
      for (const name of names) walk(path.join(file, name));
      if (/\.(app|framework|xpc)$/.test(file)) sign(file, sparkle);
    } else if (stat.isFile() && stat.size >= 4) {
      const fd = fs.openSync(file, 'r');
      const bytes = Buffer.alloc(4);
      try { fs.readSync(fd, bytes, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'cafebabf'].includes(bytes.toString('hex'))) {
        // Downloader's existing sandbox entitlement is preserved at its bundle.
        const args = sparkle && file.includes('/Downloader.xpc/') ? ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', '--preserve-metadata=entitlements', file] : null;
        if (args) run('codesign', args); else sign(file, sparkle);
      }
    }
  }
  walk(appPath);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
}

async function main() {
  if (process.platform !== 'darwin' || !profile) throw new Error('Run on macOS with CUE_NOTARY_PROFILE set to a valid Keychain notarytool profile.');
  run('xcrun', ['notarytool', 'history', '--keychain-profile', profile], { stdio: 'ignore' });
  const sparkle = prepareSparkle();
  const publicKey = run(path.join(sparkle, 'bin/generate_keys'), ['--account', config.keychainAccount, '-p'], { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (publicKey !== config.publicKey) throw new Error('Keychain signing key does not match the app public key.');
  const releaseDir = path.join(root, 'dist', `release-${pkg.version}`);
  if (fs.existsSync(releaseDir)) throw new Error(`Release output already exists: ${releaseDir}. Move it aside before rebuilding.`);
  run('npm', ['test']);
  run(process.execPath, ['scripts/build-local-speech.js']);
  run(path.join(root, 'node_modules/.bin/electron-builder'), ['--mac', '--dir', '--arm64', '--x64'], { env: { ...process.env, MAC_SIGN: '', CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const arch of ['arm64', 'x64']) {
    const appPath = path.join(root, 'dist', arch === 'arm64' ? 'mac-arm64' : 'mac', 'Cue.app');
    signApp(appPath);
    const submission = path.join(root, '.cache', `Cue-${pkg.version}-${arch}-notary.zip`);
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, submission]);
    const notarization = run('xcrun', ['notarytool', 'submit', submission, '--keychain-profile', profile, '--wait', '--output-format', 'json'], { encoding: 'utf8', stdio: 'pipe' });
    fs.writeFileSync(path.join(releaseDir, `notarization-${arch}.json`), notarization);
    const result = JSON.parse(notarization);
    if (result.status !== 'Accepted') throw new Error(`Notarization failed for ${arch}: ${result.status} (${result.id})`);
    console.log(`Notarization Accepted: ${arch} (${result.id})`);
    run('xcrun', ['stapler', 'staple', appPath]);
    run('xcrun', ['stapler', 'validate', appPath]);
    run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
    const archive = path.join(releaseDir, `Cue-${pkg.version}-mac-${arch}.zip`);
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archive]);
    fs.copyFileSync(path.join(root, 'docs/releases', `${pkg.version}.html`), archive.replace(/\.zip$/, '.html'));
  }
  run(path.join(sparkle, 'bin/generate_appcast'), ['--account', config.keychainAccount, '--download-url-prefix', `https://github.com/rutmehta/cue/releases/download/v${pkg.version}/`, '--maximum-deltas', '0', '--embed-release-notes', releaseDir]);
  const archives = fs.readdirSync(releaseDir).filter(name => name.endsWith('.zip'));
  fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS'), archives.map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseDir, name))).digest('hex')}  ${name}\n`).join(''));
  console.log(`Verified release ready: ${releaseDir}`);
}
module.exports = { signApp };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
