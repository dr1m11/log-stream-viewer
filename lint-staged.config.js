// @ts-check

/** @type {Record<string, string | string[]>} */
const config = {
  '*.{ts,tsx,mts,cts,js,mjs,cjs}': ['eslint --fix --max-warnings=0', 'prettier --write'],
  '*.{json,jsonc,md,mdx,css,yml,yaml,html}': 'prettier --write',
};

export default config;
