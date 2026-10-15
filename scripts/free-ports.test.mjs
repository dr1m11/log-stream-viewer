import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isOwnProcess, isOwnWatcher, parseWindowsListeners, watcherOf } from './free-ports.mjs';

const root = 'C:\\Users\\dev\\log-stream-viewer';

describe('isOwnProcess', () => {
  it('accepts processes started from this repository', () => {
    assert.ok(
      isOwnProcess(
        '"C:\\nvm4w\\nodejs\\node.exe" C:\\Users\\dev\\log-stream-viewer\\node_modules\\.pnpm\\vite@8.3.4\\node_modules\\vite\\bin\\vite.js',
        root,
      ),
    );
    assert.ok(isOwnProcess('node --watch src/main.ts', root));
    assert.ok(isOwnProcess('"C:\\nvm4w\\nodejs\\node.exe" src\\main.ts', root));
  });

  it('leaves processes of other projects alone', () => {
    assert.ok(
      !isOwnProcess(
        'node C:\\Users\\dev\\pipeline-builder\\node_modules\\vite\\bin\\vite.js preview',
        root,
      ),
    );
    assert.ok(!isOwnProcess('', root));
  });
});

describe('isOwnWatcher', () => {
  it('recognises the own node --watch process', () => {
    assert.ok(isOwnWatcher('node  --watch src/main.ts', root));
    assert.ok(isOwnWatcher('"C:\\nvm4w\\nodejs\\node.exe" --watch-path=src src\\main.ts', root));
  });

  it('ignores servers without --watch and watchers of other projects', () => {
    assert.ok(!isOwnWatcher('node src/main.ts', root));
    assert.ok(!isOwnWatcher('node --watcher-mode src/main.ts', root));
    assert.ok(!isOwnWatcher('node --watch C:\\Users\\dev\\pipeline-builder\\server.js', root));
    assert.ok(!isOwnWatcher('C:\\WINDOWS\\system32\\cmd.exe /d /s /c node --watch other.js', root));
  });
});

describe('watcherOf', () => {
  const listener = {
    port: 8787,
    pid: 40864,
    cmd: '"C:\\nvm4w\\nodejs\\node.exe" src/main.ts',
    ppid: 3536,
    parentCmd: 'node  --watch src/main.ts',
  };

  it('returns the own node --watch parent of an own listener', () => {
    assert.equal(watcherOf(listener, root), 3536);
  });

  it('returns nothing for another parent, an unknown parent or a foreign listener', () => {
    assert.equal(
      watcherOf(
        { ...listener, parentCmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c node src/main.ts' },
        root,
      ),
      undefined,
    );
    assert.equal(watcherOf({ ...listener, ppid: 0 }, root), undefined);
    assert.equal(
      watcherOf({ ...listener, cmd: 'node C:\\Users\\dev\\pipeline-builder\\server.js' }, root),
      undefined,
    );
  });
});

describe('parseWindowsListeners', () => {
  it('handles a single object, an array and empty output', () => {
    assert.deepEqual(parseWindowsListeners('{"port":5173,"pid":42,"cmd":"node vite"}'), [
      { port: 5173, pid: 42, cmd: 'node vite', ppid: 0, parentCmd: '' },
    ]);
    assert.deepEqual(
      parseWindowsListeners('[{"port":4173,"pid":7,"cmd":null},{"port":8787,"pid":0,"cmd":"x"}]'),
      [{ port: 4173, pid: 7, cmd: '', ppid: 0, parentCmd: '' }],
    );
    assert.deepEqual(parseWindowsListeners(''), []);
  });

  it('reads the parent process', () => {
    assert.deepEqual(
      parseWindowsListeners(
        '{"port":8787,"pid":40864,"cmd":"node src/main.ts","ppid":3536,"pcmd":"node --watch src/main.ts"}',
      ),
      [
        {
          port: 8787,
          pid: 40864,
          cmd: 'node src/main.ts',
          ppid: 3536,
          parentCmd: 'node --watch src/main.ts',
        },
      ],
    );
    assert.deepEqual(
      parseWindowsListeners('{"port":8787,"pid":5,"cmd":"x","ppid":-1,"pcmd":null}'),
      [{ port: 8787, pid: 5, cmd: 'x', ppid: 0, parentCmd: '' }],
    );
  });
});
