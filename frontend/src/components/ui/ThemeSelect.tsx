'use client';

import { useSyncExternalStore } from 'react';
import { THEME_STORAGE_KEY, type ThemePreference } from '@/lib/theme';

const CHANGE_EVENT = 'smartdesk:themechange';

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

function getPreference(): ThemePreference {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

function setPreference(theme: ThemePreference) {
  const { dataset } = document.documentElement;
  if (theme === 'system') delete dataset.theme;
  else dataset.theme = theme;

  try {
    if (theme === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The current page still uses the selected theme when storage is unavailable.
  }

  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function ThemeSelect() {
  const preference = useSyncExternalStore<ThemePreference>(
    subscribe,
    getPreference,
    () => 'system',
  );

  return (
    <label className="inline-flex items-center gap-2.5 text-sm font-medium text-muted-strong">
      Theme
      <select
        className="app-field w-auto py-1.5 text-sm"
        value={preference}
        onChange={(event) => setPreference(event.target.value as ThemePreference)}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
