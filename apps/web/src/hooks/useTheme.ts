import { useCallback, useEffect, useRef, useState } from "react";
import { updatePreferences, type AuthUser } from "../api";
import type { Theme } from "../lib/roles";

const THEME_STORAGE_KEY = "decentracord:theme";

function readCachedTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function writeCachedTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The class and meta color still apply if browser storage is unavailable.
  }
}

export function useTheme(user: AuthUser | null, csrfToken: string | null) {
  const [theme, setThemeState] = useState<Theme>(readCachedTheme);
  const themeRef = useRef(theme);
  const userRef = useRef(user);
  const csrfTokenRef = useRef(csrfToken);
  const serverThemeRef = useRef<Theme | null>(user?.theme ?? null);
  const requestGenerationRef = useRef(0);

  themeRef.current = theme;
  userRef.current = user;
  csrfTokenRef.current = csrfToken;

  const applyTheme = useCallback((nextTheme: Theme, withoutTransition = false) => {
    if (typeof document === "undefined") return;
    const body = document.body;
    if (withoutTransition) body.classList.add("theme-switching");
    body.classList.toggle("light", nextTheme === "light");
    writeCachedTheme(nextTheme);

    const themeColor = document.querySelector('meta[name="theme-color"]');
    themeColor?.setAttribute("content", nextTheme === "light" ? "#f5f7fa" : "#0f1115");

    if (withoutTransition) {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => body.classList.remove("theme-switching"));
      } else {
        window.setTimeout(() => body.classList.remove("theme-switching"), 0);
      }
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [applyTheme, theme]);

  useEffect(() => {
    if (!user) {
      serverThemeRef.current = null;
      return;
    }

    serverThemeRef.current = user.theme;
    if (themeRef.current !== user.theme) {
      themeRef.current = user.theme;
      setThemeState(user.theme);
      applyTheme(user.theme, true);
    }
  }, [applyTheme, user?.id, user?.theme]);

  const setTheme = useCallback((nextTheme: Theme) => {
    if (themeRef.current === nextTheme) return;

    themeRef.current = nextTheme;
    setThemeState(nextTheme);
    applyTheme(nextTheme);

    const currentUser = userRef.current;
    if (!currentUser) return;

    const currentCsrfToken = csrfTokenRef.current;
    if (!currentCsrfToken) {
      const fallbackTheme = serverThemeRef.current ?? currentUser.theme;
      themeRef.current = fallbackTheme;
      setThemeState(fallbackTheme);
      applyTheme(fallbackTheme, true);
      return;
    }

    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    const userId = currentUser.id;

    void updatePreferences({ theme: nextTheme }, currentCsrfToken).then((updatedUser) => {
      if (generation !== requestGenerationRef.current || userRef.current?.id !== userId) return;
      serverThemeRef.current = updatedUser.theme;
      themeRef.current = updatedUser.theme;
      setThemeState(updatedUser.theme);
      applyTheme(updatedUser.theme);
    }).catch(() => {
      if (generation !== requestGenerationRef.current || userRef.current?.id !== userId) return;
      const fallbackTheme = serverThemeRef.current ?? userRef.current.theme;
      themeRef.current = fallbackTheme;
      setThemeState(fallbackTheme);
      applyTheme(fallbackTheme, true);
    });
  }, [applyTheme]);

  const toggleTheme = useCallback(() => {
    setTheme(themeRef.current === "dark" ? "light" : "dark");
  }, [setTheme]);

  return { theme, setTheme, toggleTheme };
}
