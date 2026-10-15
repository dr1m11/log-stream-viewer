import { THEME_PREFERENCES, type ThemePreference, useTheme } from '@/shared/lib/theme';

const LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Segmented control for the colour theme. Native radios in a fieldset give the group its name,
 * arrow-key navigation and the checked state for screen readers without any extra scripting.
 * The checked option is filled with the accent colour, which keeps at least 3:1 against the track
 * in both themes (WCAG 1.4.11); the focus ring is offset so it stays visible next to the fill.
 */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();

  return (
    <fieldset className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-sm">
      <legend className="sr-only">Colour theme</legend>
      {THEME_PREFERENCES.map((option) => (
        <label
          key={option}
          className="cursor-pointer rounded-md px-2.5 py-1 text-fg-muted transition-colors select-none not-has-checked:hover:text-fg has-checked:bg-accent has-checked:font-medium has-checked:text-surface-raised has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus"
        >
          <input
            type="radio"
            name="colour-theme"
            value={option}
            checked={preference === option}
            onChange={() => {
              setPreference(option);
            }}
            className="sr-only"
          />
          {LABELS[option]}
        </label>
      ))}
    </fieldset>
  );
}
