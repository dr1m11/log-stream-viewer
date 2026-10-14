// @ts-check

/** @type {import('prettier').Config & import('prettier-plugin-tailwindcss').PluginOptions} */
const config = {
  singleQuote: true,
  printWidth: 100,
  trailingComma: 'all',
  endOfLine: 'lf',
  plugins: ['prettier-plugin-tailwindcss'],
  // Sorts Tailwind classes, including inside cn() and cva() calls. `tailwindStylesheet` (the app's
  // theme entry CSS) is added together with apps/web.
  tailwindFunctions: ['cn', 'cva'],
};

export default config;
