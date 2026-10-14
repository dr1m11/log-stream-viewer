import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isOwnProcess, parseWindowsListeners } from './free-ports.mjs';

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

describe('parseWindowsListeners', () => {
  it('handles a single object, an array and empty output', () => {
    assert.deepEqual(parseWindowsListeners('{"port":5173,"pid":42,"cmd":"node vite"}'), [
      { port: 5173, pid: 42, cmd: 'node vite' },
    ]);
    assert.deepEqual(
      parseWindowsListeners('[{"port":4173,"pid":7,"cmd":null},{"port":8787,"pid":0,"cmd":"x"}]'),
      [{ port: 4173, pid: 7, cmd: '' }],
    );
    assert.deepEqual(parseWindowsListeners(''), []);
  });
});
