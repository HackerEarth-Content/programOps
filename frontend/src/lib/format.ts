const UNSET = "—";
const IST_TIME_ZONE = "Asia/Kolkata";

// Backend timestamps come back naive (no "Z"/offset suffix) but are always
// UTC underneath -- without this, `new Date(value)` treats them as local
// time in whatever machine parses them (server during SSR, browser after),
// silently shifting every displayed time.
function toUtcDate(value: string): Date {
  const hasTimezone = /[Zz]|[+-]\d{2}:\d{2}$/.test(value);
  return new Date(hasTimezone ? value : `${value}Z`);
}

// Deal values are INR: ₹ with Indian digit grouping (₹9,50,000).
export const formatMoney = (value: number | null) => {
  if (value == null) return UNSET;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
};

// Compact Indian units: K, L (lakh, 1e5), Cr (crore, 1e7).
export const formatCompactMoney = (value: number | null) => {
  if (value == null) return UNSET;
  const [divisor, suffix] =
    value >= 1e7 ? [1e7, "Cr"] : value >= 1e5 ? [1e5, "L"] : value >= 1e3 ? [1e3, "K"] : [1, ""];
  return `₹${Math.round((value / divisor) * 10) / 10}${suffix}`;
};

export const formatDate = (value: string | null) => {
  if (!value) return UNSET;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: IST_TIME_ZONE,
  }).format(toUtcDate(value));
};

export const formatDateTime = (value: string | null) => {
  if (!value) return UNSET;
  return (
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: IST_TIME_ZONE,
    }).format(toUtcDate(value)) + " IST"
  );
};

export const orUnassigned = (value: string | null) => value ?? "Unassigned";
export const orUnset = (value: string | null) => value ?? UNSET;

/** "4 min ago", "2 h ago", "3 d ago". Empty for a missing value. */
export const timeAgo = (value: string | null | undefined) => {
  if (!value) return "never";
  const mins = Math.max(0, Math.round((Date.now() - toUtcDate(value).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
};

/** An http(s) URL safe to put in an href, or null. Anything else (javascript:, data:) is dropped. */
export const safeUrl = (value: string | null | undefined): string | null => {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

/** Extracted documents sometimes carry the literal text "null" or "N/A" for a missing value. */
export const known = (value: string | null | undefined): string | null => {
  const v = value?.trim();
  return v && !/^(null|none|n\/a|na|undefined|-)$/i.test(v) ? v : null;
};

/** A percentage for display: one decimal under 1%, never "0%" for a value that isn't zero. */
export const formatPct = (value: number | null | undefined) => {
  if (value == null || Number.isNaN(value)) return UNSET;
  if (value === 0) return "0%";
  if (value < 0.1) return "<0.1%";
  if (value < 1) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
};

/** "21 Oct, 9:28 am": the one timestamp format used in prose and logs. */
export const formatWhen = (value: string | null | undefined) => {
  if (!value) return UNSET;
  const d = toUtcDate(value);
  const day = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: IST_TIME_ZONE,
  }).format(d);
  const time = new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: IST_TIME_ZONE,
  })
    .format(d)
    .replace(/\s?(am|pm)/i, (_, ap: string) => ` ${ap.toLowerCase()}`);
  return `${day}, ${time}`;
};

/** "21 Oct" from a date or timestamp. */
export const formatDay = (value: string | null | undefined) => {
  if (!value) return UNSET;
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: IST_TIME_ZONE,
  }).format(value.length === 10 ? new Date(`${value}T00:00:00+05:30`) : toUtcDate(value));
};

/** "22–26 Oct", or "30 Oct – 2 Nov" when the range crosses a month. */
export const formatRange = (start: string | null | undefined, end: string | null | undefined) => {
  if (!start && !end) return UNSET;
  if (!end || start === end) return formatDay(start ?? end);
  if (!start) return formatDay(end);
  const [s, e] = [new Date(`${start}T00:00:00+05:30`), new Date(`${end}T00:00:00+05:30`)];
  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  return sameMonth ? `${s.getDate()}–${formatDay(end)}` : `${formatDay(start)} – ${formatDay(end)}`;
};
