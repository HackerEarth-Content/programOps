// Light / dark theme. The choice is stored per browser; with no choice the OS preference decides.
// `themeInitScript` runs in <head> before first paint so the page never flashes the wrong theme.
export type Theme = "light" | "dark";
const KEY = "programops-theme";

export const themeInitScript = `(function(){try{var s=localStorage.getItem("${KEY}");var t=s==="light"||s==="dark"?s:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t}catch(e){}})()`;

export function currentTheme(): Theme {
  return document.documentElement.dataset["theme"] === "dark" ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // private mode: the choice just lasts for this page
  }
}
