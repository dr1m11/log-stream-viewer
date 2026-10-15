import AxeBuilder from '@axe-core/playwright';
import { expect, test as base } from '@playwright/test';

interface Fixtures {
  /** Runs axe against the current page (WCAG 2.1 A/AA) and fails on any violation. */
  expectNoA11yViolations: () => Promise<void>;
}

/**
 * Base test for every e2e spec: fails on uncaught page errors and console errors (including CSP
 * violations), and provides an accessibility check.
 */
export const test = base.extend<Fixtures & { failOnPageErrors: undefined }>({
  failOnPageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
      });
      await use(undefined);
      expect(errors, 'the page logged errors').toEqual([]);
    },
    { auto: true },
  ],

  expectNoA11yViolations: async ({ page }, use) => {
    await use(async () => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  },
});

export { expect };
