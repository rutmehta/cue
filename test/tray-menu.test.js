const assert = require('node:assert/strict');
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

test('tray controller replaces its menu only when the subscribed session phase changes', () => {
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
      getSnapshot: () => ({ session: { phase: 'idle' } }),
      subscribe: (next) => {
        listener = next;
        return () => { listener = null; };
      }
    }
  });

  listener({ session: { phase: 'idle' } });
  listener({ session: { phase: 'listening' } });
  assert.equal(menus.length, 2);
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
