import fsd from '@feature-sliced/steiger-plugin';
import { defineConfig } from 'steiger';

export default defineConfig([
  ...fsd.configs.recommended,
  {
    rules: {
      // The app has a single page (pages/stream) until B2, so every feature has exactly one
      // consumer and FSD 2.1 "pages first" would fold features/toggle-theme into the page. We keep
      // user actions as features from the start: the table, search and stream controls of B2–B5
      // join them, and a feature cannot import the slices beside it. A warning rather than off,
      // because the rule also reports slices that nothing uses. Revisit once the page has grown.
      'fsd/insignificant-slice': 'warn',
    },
  },
]);
