import { CalendarDays } from "lucide-react";
import { useState } from "react";
import { TimeDial } from "@/components/time-dial";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// A calendar-popover date field. The native <input type="date"> leaves the calendar to the browser (it can be
// clipped in a narrow column, or missing), so this always opens a calendar. Values stay plain ISO strings:
// "YYYY-MM-DD" for DatePicker, "YYYY-MM-DDTHH:MM" for DateTimePicker (the same shapes the native inputs gave).

const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s: string) =>
  new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const longDay = (s: string) =>
  fromIso(s).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export function DatePicker({
  value,
  onChange,
  min,
  max,
  label,
  placeholder = "Pick a date",
  clearable = true,
  className,
}: {
  /** "YYYY-MM-DD", or "" for none. */
  value: string;
  onChange: (v: string) => void;
  /** Earliest / latest allowed day, "YYYY-MM-DD". */
  min?: string | undefined;
  max?: string | undefined;
  /** The field's accessible name. */
  label: string;
  placeholder?: string;
  clearable?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? fromIso(value) : undefined;
  const todayIso = toIso(new Date());
  const allowed = (iso: string) => (!min || iso >= min) && (!max || iso <= max);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${value ? longDay(value) : "not set"}`}
          className={cn(
            "flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-[6px] border border-border bg-card px-2.5 text-left text-[14px] focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
            !value && "text-placeholder",
            className,
          )}
        >
          <span className="truncate">{value ? longDay(value) : placeholder}</span>
          <CalendarDays className="size-3.5 shrink-0 text-ink-2" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected ?? new Date()}
          onSelect={(d) => {
            if (!d) return;
            onChange(toIso(d));
            setOpen(false);
          }}
          disabled={(d) => !allowed(toIso(d))}
          autoFocus
        />
        <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!allowed(todayIso)}
            onClick={() => {
              onChange(todayIso);
              setOpen(false);
            }}
          >
            Today
          </Button>
          {clearable && value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A date plus a time of day (the clock dial). Picking a date with no time yet defaults the time to 09:00. */
export function DateTimePicker({
  value,
  onChange,
  min,
  label,
  className,
}: {
  /** "YYYY-MM-DDTHH:MM", or "" for none. */
  value: string;
  onChange: (v: string) => void;
  min?: string | undefined;
  label: string;
  className?: string;
}) {
  const date = value.slice(0, 10);
  const time = value.length >= 16 ? value.slice(11, 16) : "";
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-2", className)}>
      <DatePicker
        label={`${label} (date)`}
        value={date}
        min={min}
        clearable={false}
        onChange={(d) => onChange(d ? `${d}T${time || "09:00"}` : "")}
      />
      {date ? (
        <TimeDial
          label={`${label} (time)`}
          required
          value={time || "09:00"}
          onChange={(t) => onChange(`${date}T${t ?? "09:00"}`)}
        />
      ) : (
        <span className="flex h-8 w-[110px] items-center rounded-[6px] border border-dashed border-placeholder px-2.5 text-[14px] text-placeholder">
          Time
        </span>
      )}
    </div>
  );
}
