const UNSET = "-";
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
