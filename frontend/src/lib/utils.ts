import { clsx, type ClassValue } from "clsx";
import { useEffect, useState } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * `useState` that remembers its value in this browser (filters, sort, scope), so a person lands where they left
 * off. The first render uses `initial`, so server and client markup match; the saved value applies right after.
 */
export function usePersistentState(
  key: string,
  initial: string,
): [string, (value: string) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(key);
      if (saved !== null) setValue(saved);
    } catch {
      // storage blocked: the choice just lasts for this page
    }
  }, [key]);
  const set = (next: string) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // ignore
    }
  };
  return [value, set];
}
