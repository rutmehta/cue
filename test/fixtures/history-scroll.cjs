// Render the real markup and styles with synthetic history, without app services.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-history-test-'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const renderer = path.resolve(__dirname, '../../renderer');
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('<head>', `<head><base href="${pathToFileURL(renderer + path.sep).href}">`);
  const fixture = path.join(directory, 'index.html');
  fs.writeFileSync(fixture, html);
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(fixture);
  for (const [width, height] of [[600, 410], [520, 320], [1000, 720]]) {
    win.setContentSize(width, height);
    for (const compact of [true, false]) {
      const result = await win.webContents.executeJavaScript(`(() => {
        document.body.classList.toggle('compact', ${compact});
        document.body.classList.remove('transcript-open');
        const messages = document.getElementById('messages');
        messages.innerHTML = Array.from({length: 8}, (_, i) => '<div class="response-group"><div class="response-sep">Answer ' + i + '</div><div class="ai-text"><p>' + 'Synthetic answer history. '.repeat(20) + '</p></div></div>').join('');
        const first = messages.firstElementChild;
        if (getComputedStyle(first).display === 'none') return 'Older answers are hidden';
        messages.scrollTop = messages.scrollHeight;
        if (messages.scrollTop <= 0) return 'Answers cannot scroll down';
        messages.scrollTop = 0;
        if (first.getBoundingClientRect().top < messages.getBoundingClientRect().top - 1) return 'First answer is unreachable';
        const sidebar = document.getElementById('transcript-sidebar');
        document.getElementById('panel-main').insertBefore(sidebar, messages);
        sidebar.classList.remove('hidden');
        document.body.classList.add('transcript-open');
        const list = document.getElementById('ts-list');
        list.innerHTML = '<div class="ts-row"><div class="ts-text">Synthetic transcript history.</div></div>'.repeat(40);
        list.scrollTop = list.scrollHeight;
        if (list.scrollTop <= 0) return 'Transcript cannot scroll down';
        list.scrollTop = 0;
        if (list.firstElementChild.getBoundingClientRect().top < list.getBoundingClientRect().top - 1) return 'First transcript is unreachable';
        sidebar.classList.add('hidden');
        return 'ok';
      })()`);
      if (result !== 'ok') throw new Error(`${width}x${height}, compact=${compact}: ${result}`);
    }
  }
  console.log('Answer and transcript history scroll at all three sizes in both modes.');
  win.destroy();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
app.on('quit', () => fs.rmSync(directory, { recursive: true, force: true }));
