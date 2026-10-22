---
paths:
  - 'apps/web/src/**'
---

# UI kit (`shared/ui`, Radix + Tailwind CSS 4)

## Which component

- `Button` (`@/shared/ui/button`) — any control with visible text. Variants: `primary` (the one main action of a group, e.g. "Jump to latest"), `secondary` (default), `ghost` (toolbars, low emphasis), `danger` (destructive: clear the buffer). Sizes `sm`, `md`; `asChild` renders a link with button styles.
- `IconButton` (`@/shared/ui/icon-button`) — icon-only control (pause, settings, close details). `label` is required: it is the accessible name and the tooltip. `shortcut={['Space']}` adds the keys to the tooltip. Do not wrap an `IconButton` in another `Tooltip`.
- `Tooltip` (`@/shared/ui/tooltip`) — a short hint for a focusable element; it describes the trigger and never replaces its accessible name or holds the only copy of important information. `TooltipProvider` is mounted once in `app/App.tsx`; tests that render a tooltip wrap the tree in `<TooltipProvider delayDuration={0}>`.
- `Badge` (`@/shared/ui/badge`) — small non-interactive label or count (`tone`: `neutral`, `accent`, `success`, `warning`, `danger`). Colour is never the only signal: add an icon or words, and give bare numbers words for screen readers (`<span className="sr-only"> dropped</span>`).
- `Kbd` (`@/shared/ui/kbd`) — a key in shortcut hints.
- Native elements first: radios in a fieldset for segmented choices (see `features/toggle-theme`), `<details>` for simple disclosure. Add a Radix primitive only when native HTML cannot give the behaviour.

## How components are built

- Behaviour from Radix primitives imported from the umbrella `radix-ui` package (`import { Tooltip } from 'radix-ui'`); styling is ours.
- Colours only through design tokens (`bg-surface-raised`, `text-fg-muted`, `border-border`, `bg-accent`…, defined in `app/styles/tokens.css` and exposed in `index.css`). No raw hex/rgb/oklch values or arbitrary colour classes; a missing colour becomes a token, in both the light and the dark theme, with its contrast checked (the header of `tokens.css`). Text on a filled tone is `text-surface-raised`.
- Variants via `cva` (`class-variance-authority`), class merging via `cn()` from `@/shared/lib/cn`. Accept `className` and merge it last.
- React 19: `ref` is a regular prop, no `forwardRef`. Spread the remaining props onto the root element. Polymorphism via `asChild` + Radix `Slot`, not `as` props.
- Focus: the global `:focus-visible` outline in `index.css` covers every focusable element; add a focus style only when the focusable element is visually hidden (`has-focus-visible:` on its label). Hit area at least 24×24px.
- Icons from `lucide-react`, sized by the parent (`[&_svg]:size-4` in `Button`), always `aria-hidden` (pass it explicitly; the name comes from the control's text or `label`).
- One component per folder: `shared/ui/<kebab-name>/{Name.tsx, Name.test.tsx, index.ts}`. RTL tests by role and accessible name. No Storybook here.

## CSP: no injected `<style>` elements

Production serves `style-src 'self'` (ADR-0003, `apps/web/build/security-headers.ts`). `style` props are fine (CSSOM); `<style>` elements are blocked and show up as console errors, which fail e2e. In `radix-ui` 1.8.1:

- **Safe:** Tooltip (positions with `style` props), Slot, and primitives without scroll lock.
- **Inject `<style>`:** Dialog and AlertDialog, Popover with `modal`, DropdownMenu / ContextMenu / Menubar when modal (the default) — all through `react-remove-scroll`; Select (scroll lock and an inline `<style>` in its viewport); ScrollArea (inline `<style>` in its viewport).

Use one of those only with a decision recorded in ADR-0003 (relaxing `style-src-elem`) or a non-injecting configuration (`modal={false}`), and check it under `pnpm build:local` + `vite preview` with the e2e fixture, which fails on console errors.
