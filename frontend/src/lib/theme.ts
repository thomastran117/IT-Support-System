export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'smartdesk.theme';

// CSS follows the device when there is no explicit choice. Run this before the page paints.
export const themeInitScript = `try {
  const theme = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}`;
