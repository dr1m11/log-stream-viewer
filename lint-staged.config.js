// @ts-check

/** @type {Record<string, string | string[]>} */
const config = {
  '*.{ts,tsx,mts,cts,js,mjs,cjs}': [
    // --no-warn-ignored: a staged file that ESLint ignores must not fail --max-warnings=0.
    'eslint --fix --max-warnings=0 --no-warn-ignored',
    'prettier --write',
  ],
  '*.{json,jsonc,md,mdx,css,yml,yaml,html}': 'prettier --write',
};

export default config;
