/**
 * The Worker script in front of the static assets (docs/adr/0003). Cloudflare calls it only for
 * requests that match no asset and are not navigations: with a compatibility date from 2025-04-01
 * a request with `Sec-Fetch-Mode: navigate` gets the SPA fallback without invoking it.
 *
 * A missing file under `/assets/` is a chunk of another build — typically a tab left open across
 * a deploy lazy-loading a chunk that no longer exists. It gets a 404 that nothing caches, instead
 * of `index.html` with the `immutable` header of the `/assets/*` rule. Every other path goes back
 * to the assets binding, which applies the SPA fallback and `_headers`, so requests without
 * `Sec-Fetch-Mode` (curl, crawlers, older browsers) still get the app for a deep link.
 */

/** The bindings of `wrangler.jsonc`, typed by hand with just the method used here. */
export interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

/** Vite's output directory for content-hashed files (`build.assetsDir`). */
const ASSETS_PREFIX = '/assets/';

// The Workers runtime takes the handler from the default export. No named runtime exports: the
// runtime would treat them as extra entrypoints.
// eslint-disable-next-line no-restricted-syntax -- the default export is the Workers module format
export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    if (!new URL(request.url).pathname.startsWith(ASSETS_PREFIX)) return env.ASSETS.fetch(request);
    // `_headers` does not apply to responses built by the Worker script, so this one sets its own.
    return new Response('Not found\n', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
