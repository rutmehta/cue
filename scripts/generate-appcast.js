const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const config = require('../build-resources/sparkle.json');
const pkg = require('../package.json');
const root = path.resolve(__dirname, '..');
const escapeXML = value => String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));

function generateAppcast(releaseDir, sparkleDir) {
  const signTool = path.join(sparkleDir, 'bin/sign_update');
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(config.publicKey, 'base64')]), format: 'der', type: 'spki' });
  const notes = fs.readFileSync(path.join(root, 'docs/releases', `${pkg.version}.html`), 'utf8');
  const items = [];
  // Sparkle 2.9 first filters hardware requirements, then keeps the first
  // matching entry on equal versions (SUAppcastDriver bestItemFromAppcastItems).
  // Thus Intel skips arm64, while Apple Silicon/Rosetta receives the native app.
  for (const arch of ['arm64', 'x64']) {
    const name = `Cue-${pkg.version}-mac-${arch}.zip`;
    const archive = path.join(releaseDir, name);
    const signature = execFileSync(signTool, ['--account', config.keychainAccount, '-p', archive], { encoding: 'utf8' }).trim();
    const bytes = fs.readFileSync(archive);
    if (!crypto.verify(null, bytes, publicKey, Buffer.from(signature, 'base64'))) throw new Error(`Invalid archive signature: ${name}`);
    items.push(`    <item>
      <title>Cue ${escapeXML(pkg.version)}</title>
      <sparkle:version>${escapeXML(pkg.version)}</sparkle:version>
      <sparkle:shortVersionString>${escapeXML(pkg.version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      ${arch === 'arm64' ? '<sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>' : ''}
      <pubDate>${new Date().toUTCString()}</pubDate>
      <description>${escapeXML(notes)}</description>
      <enclosure url="https://github.com/rutmehta/cue/releases/download/v${escapeXML(pkg.version)}/${escapeXML(name)}" sparkle:edSignature="${escapeXML(signature)}" length="${bytes.length}" type="application/octet-stream" />
    </item>`);
  }
  const appcast = path.join(releaseDir, 'appcast.xml');
  fs.writeFileSync(appcast, `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Cue Updates</title>
    <link>https://github.com/rutmehta/cue/releases</link>
    <description>Signed macOS updates for Cue</description>
    <language>en</language>
${items.join('\n')}
  </channel>
</rss>\n`);
  execFileSync(signTool, ['--account', config.keychainAccount, appcast], { stdio: 'inherit' });
  execFileSync(signTool, ['--account', config.keychainAccount, '--verify', appcast], { stdio: 'inherit' });
  return appcast;
}
module.exports = { generateAppcast };
if (require.main === module) console.log(generateAppcast(path.resolve(process.argv[2]), path.resolve(process.argv[3])));
