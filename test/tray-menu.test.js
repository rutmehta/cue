const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { buildTrayTemplate, createTrayController } = require('../src/tray-menu');

test('tray template changes Start to Pause and always exposes recovery plus Quit', () => {
  const labels = buildTrayTemplate({ session: { phase: 'listening' } }, {})
    .filter(Boolean)
    .map((item) => item.label);

  assert.deepEqual(labels, [
    'Show Cue',
    'Pause Listening',
    'End Session',
    'Unlock Interaction',
    'Recenter Overlay',
    'Settings',
    'Quit Cue'
  ]);
});

test('tray template exposes resume after pause and hides an already-visible overlay', () => {
  const paused = buildTrayTemplate({ session: { phase: 'paused' }, overlay: { visible: true } }, {});

  assert.equal(paused[0].label, 'Hide Cue');
  assert.equal(paused[1].label, 'Resume Listening');
});

test('tray controller routes all menu callbacks and double-click through command', async () => {
  const commands = [];
  const menus = [];
  const handlers = {};
  let created = 0;
  let destroyed = 0;
  const controller = createTrayController({
    Tray: class {
      constructor(icon) {
        created += 1;
        assert.equal(icon, 'cue-icon');
      }
      setContextMenu(menu) { menus.push(menu); }
      on(event, handler) { handlers[event] = handler; }
      destroy() { destroyed += 1; }
    },
    Menu: { buildFromTemplate: (template) => template },
    icon: 'cue-icon',
    command: async (name) => commands.push(name),
    getSnapshot: () => ({ session: { phase: 'listening' } })
  });

  assert.equal(created, 1);
  assert.equal(menus.length, 1);
  for (const item of menus[0]) await item.click();
  await handlers['double-click']();

  assert.deepEqual(commands, ['show', 'pause', 'end-session', 'unlock', 'recenter', 'settings', 'quit', 'show']);
  controller.destroy();
  controller.destroy();
  assert.equal(destroyed, 1);
});

test('tray controller replaces its menu when session phase or window visibility changes', () => {
  const menus = [];
  let listener;
  const controller = createTrayController({
    Tray: class {
      setContextMenu(menu) { menus.push(menu); }
      on() {}
      destroy() {}
    },
    Menu: { buildFromTemplate: (template) => template },
    icon: 'cue-icon',
    command: () => {},
    sessionController: {
      getSnapshot: () => ({ session: { phase: 'idle' }, overlay: { visible: false } }),
      subscribe: (next) => {
        listener = next;
        return () => { listener = null; };
      }
    }
  });

  listener({ session: { phase: 'idle' }, overlay: { visible: false } });
  listener({ session: { phase: 'idle' }, overlay: { visible: true } });
  listener({ session: { phase: 'listening' }, overlay: { visible: true } });
  assert.equal(menus.length, 3);
  assert.equal(menus[1][0].label, 'Hide Cue');
  controller.destroy();
  assert.equal(listener, null);
});

test('tray controller installs a recovery menu even before its first snapshot arrives', () => {
  const menus = [];
  createTrayController({
    Tray: class {
      setContextMenu(menu) { menus.push(menu); }
      on() {}
    },
    Menu: { buildFromTemplate: (template) => template },
    icon: 'cue-icon',
    command: () => {}
  });

  assert.equal(menus.length, 1);
  assert.equal(menus[0][0].label, 'Show Cue');
});

test('tray callbacks consume rejected lifecycle commands under strict unhandled-rejection handling', () => {
  const modulePath = path.join(__dirname, '..', 'src', 'tray-menu.js');
  const script = `
    const { createTrayController } = require(${JSON.stringify(modulePath)});
    let menu;
    let doubleClick;
    createTrayController({
      Tray: class {
        setContextMenu(nextMenu) { menu = nextMenu; }
        on(event, handler) { if (event === 'double-click') doubleClick = handler; }
      },
      Menu: { buildFromTemplate: (template) => template },
      icon: 'cue-icon',
      command: () => Promise.reject(new Error('command rejected')),
      getSnapshot: () => ({ session: { phase: 'idle' } })
    });
    menu[0].click();
    doubleClick();
    setImmediate(() => process.exit(0));
  `;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script]);

  assert.equal(result.status, 0, result.stderr.toString());
});

test('tray destruction still runs once when unsubscription throws', () => {
  let destroyed = 0;
  const controller = createTrayController({
    Tray: class {
      setContextMenu() {}
      on() {}
      destroy() { destroyed += 1; }
    },
    Menu: { buildFromTemplate: (template) => template },
    icon: 'cue-icon',
    command: () => {},
    subscribe: () => () => { throw new Error('unsubscribe failed'); }
  });

  assert.doesNotThrow(() => controller.destroy());
  controller.destroy();
  assert.equal(destroyed, 1);
});
