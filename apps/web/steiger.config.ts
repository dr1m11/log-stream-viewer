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
]);
