// @ts-check

/** @type {import('prettier').Config & import('prettier-plugin-tailwindcss').PluginOptions} */
const config = {
  singleQuote: true,
  printWidth: 100,
  trailingComma: 'all',
  endOfLine: 'lf',
  plugins: ['prettier-plugin-tailwindcss'],
  // Sorts Tailwind classes using the app's theme (so token utilities such as text-level-error sort
  // like built-in ones), including inside cn() and cva() calls.
  tailwindStylesheet: './apps/web/src/app/styles/index.css',
  tailwindFunctions: ['cn', 'cva'],
};

export default config;
