import fsd from '@feature-sliced/steiger-plugin';
import { defineConfig } from 'steiger';

export default defineConfig([
  ...fsd.configs.recommended,
  {
    // The app has a single page (pages/stream) until B2, so the theme toggle has one consumer and
    // FSD 2.1 "pages first" would fold it into the page. It stays a feature because it is a user
    // action that other pages will share. Only this slice is exempt: any other single-use slice is
    // still reported. Revisit in B2, when the table, search and stream controls arrive.
    files: ['./src/features/toggle-theme/**'],
    rules: {
      'fsd/insignificant-slice': 'off',
    },
  },
  {
    // The stream entity has one consumer (pages/stream) until the table, pause and settings slices
    // of B2 consume it too.
    files: ['./src/entities/log-stream/**'],
    rules: {
      'fsd/insignificant-slice': 'off',
    },
  },
  {
    // Stream settings are a user action with a single page to live on; a feature keeps them out of
    // the page's composition code and next to their own model.
    files: ['./src/features/configure-stream/**'],
    rules: {
      'fsd/insignificant-slice': 'off',
    },
  },
]);
