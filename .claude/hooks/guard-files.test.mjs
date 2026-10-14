import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { projectRelative } from './_lib.mjs';
import { checkPath } from './guard-files.mjs';

describe('checkPath', () => {
  it('allows regular source files and files outside the repository', () => {
    assert.equal(checkPath('apps/web/src/main.tsx'), null);
    assert.equal(checkPath('apps/mock-server/src/server.ts'), null);
    assert.equal(checkPath('.env.example'), null);
    assert.equal(checkPath(null), null);
  });

  it('blocks env files and Worker secrets', () => {
    for (const file of ['.env', '.env.local', 'apps/web/.env.production', 'apps/web/.dev.vars']) {
      assert.notEqual(checkPath(file), null, file);
    }
  });

  it('blocks the lockfile and generated output', () => {
    for (const file of [
      'pnpm-lock.yaml',
      'apps/web/dist/index.html',
      'coverage/index.html',
      '.lighthouseci/lhr-1.json',
      'node_modules/react/index.js',
      'apps/web/tsconfig.app.tsbuildinfo',
    ]) {
      assert.notEqual(checkPath(file), null, file);
    }
  });
});

describe('projectRelative', () => {
  const root = path.resolve('/repo');

  it('returns POSIX paths relative to the root', () => {
    assert.equal(
      projectRelative(path.join(root, 'apps', 'web', 'src', 'main.tsx'), root),
      'apps/web/src/main.tsx',
    );
  });

  it('returns null for files outside the root', () => {
    assert.equal(projectRelative(path.resolve('/elsewhere/file.ts'), root), null);
    assert.equal(projectRelative(undefined, root), null);
  });
});
