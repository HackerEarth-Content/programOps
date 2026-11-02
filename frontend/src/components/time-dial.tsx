import { Clock } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// A clock-dial time picker: choose the hour on the face, then the minute, with AM / PM beside the readout.
// The value is an "HH:MM" 24-hour string (what the settings API stores); null means "not set".

const SIZE = 232;
const C = SIZE / 2;
const FACE_R = 108;
const LABEL_R = 82;
const BUBBLE_R = 17;

type Mode = "hour" | "minute";

const pad = (n: number) => String(n).padStart(2, "0");
const parse = (v: string | null): { h: number; m: number } | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(v ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? { h, m: mi } : null;
};
const to24 = (h12: number, pm: boolean) => (h12 % 12) + (pm ? 12 : 0);
/** A point on the dial: `deg` clockwise from 12 o'clock, `r` from the centre. */
const point = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180;
  return { x: C + r * Math.sin(a), y: C - r * Math.cos(a) };
};

export function TimeDial({
  value,
  onChange,
  required,
  label,
  className,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  /** A required time cannot be cleared. */
  required?: boolean;
  label: string;
  className?: string;
}) {
  const t = parse(value);
  const h24 = t?.h ?? 9;
  const minute = t?.m ?? 0;
  const pm = h24 >= 12;
  const h12 = h24 % 12 || 12;

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("hour");
  const face = useRef<SVGSVGElement>(null);

  const commit = (h: number, m: number) => onChange(`${pad(h)}:${pad(m)}`);

  const fromPointer = (e: PointerEvent<SVGSVGElement>, last: boolean) => {
    const box = face.current?.getBoundingClientRect();
    if (!box) return;
    const x = (e.clientX - box.left) * (SIZE / box.width) - C;
    const y = (e.clientY - box.top) * (SIZE / box.height) - C;
    const deg = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
    if (mode === "hour") {
      commit(to24(Math.round(deg / 30) % 12 || 12, pm), minute);
      if (last) setMode("minute");
    } else {
      commit(h24, Math.round(deg / 6) % 60);
    }
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const step =
      e.key === "ArrowUp" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowDown" || e.key === "ArrowLeft"
          ? -1
          : e.key === "PageUp"
            ? 5
            : e.key === "PageDown"
              ? -5
              : 0;
    if (!step) return;
    e.preventDefault();
    if (mode === "hour") commit(to24(((h12 - 1 + step + 120) % 12) + 1, pm), minute);
    else commit(h24, (minute + step + 60) % 60);
  };

  const handDeg = mode === "hour" ? (h12 % 12) * 30 : minute * 6;
  const tip = point(handDeg, LABEL_R);
  const onLabel = mode === "hour" || minute % 5 === 0;
  const labels = Array.from({ length: 12 }, (_, i) => {
    const n = mode === "hour" ? (i === 0 ? 12 : i) : i * 5;
    return { n, text: mode === "hour" ? String(n) : pad(n), pos: point(i * 30, LABEL_R) };
  });
  const selectedLabel = mode === "hour" ? h12 : minute;
  const readout = t ? `${h12}:${pad(minute)} ${pm ? "PM" : "AM"}` : "not set";

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setMode("hour");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${readout}`}
          className={cn(
            "flex h-8 w-full max-w-[160px] items-center justify-between gap-2 rounded-[6px] border border-border bg-card px-2.5 text-[14px] tabular-nums focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
            !t && "text-placeholder",
            className,
          )}
        >
          {t ? readout : "Not set"}
          <Clock className="size-3.5 text-ink-2" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[264px] space-y-3 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline text-[28px] font-semibold leading-9 tabular-nums">
            <button
              type="button"
              aria-label="Choose the hour"
              aria-pressed={mode === "hour"}
              onClick={() => setMode("hour")}
              className={cn(
                "rounded-[6px] px-1.5",
                mode === "hour" ? "bg-accent-bg text-primary" : "hover:bg-raised",
              )}
            >
              {pad(h12)}
            </button>
            <span aria-hidden className="px-0.5 text-ink-2">
              :
            </span>
            <button
              type="button"
              aria-label="Choose the minute"
              aria-pressed={mode === "minute"}
              onClick={() => setMode("minute")}
              className={cn(
                "rounded-[6px] px-1.5",
                mode === "minute" ? "bg-accent-bg text-primary" : "hover:bg-raised",
              )}
            >
              {pad(minute)}
            </button>
          </div>
          <div className="inline-flex flex-col overflow-hidden rounded-[6px] border border-border text-[13px] font-medium">
            {[
              { name: "AM", on: !pm },
              { name: "PM", on: pm },
            ].map((p) => (
              <button
                key={p.name}
                type="button"
                aria-pressed={p.on}
                onClick={() => commit(to24(h12, p.name === "PM"), minute)}
                className={cn(
                  "px-2.5 py-1",
                  p.on ? "bg-accent-fill text-on-accent" : "hover:bg-raised",
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <svg
          ref={face}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="slider"
          tabIndex={0}
          aria-label={mode === "hour" ? "Hour" : "Minute"}
          aria-valuemin={mode === "hour" ? 1 : 0}
          aria-valuemax={mode === "hour" ? 12 : 59}
          aria-valuenow={mode === "hour" ? h12 : minute}
          aria-valuetext={`${h12}:${pad(minute)} ${pm ? "PM" : "AM"}`}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            fromPointer(e, false);
          }}
          onPointerMove={(e) => e.buttons === 1 && fromPointer(e, false)}
          onPointerUp={(e) => fromPointer(e, true)}
          className="mx-auto block w-full max-w-[232px] touch-none select-none rounded-full focus-visible:outline-2 focus-visible:outline-primary"
        >
          <circle cx={C} cy={C} r={FACE_R} className="fill-raised" />
          <line
            x1={C}
            y1={C}
            x2={tip.x}
            y2={tip.y}
            strokeWidth={2}
            className="stroke-accent-fill"
          />
          <circle cx={C} cy={C} r={3.5} className="fill-accent-fill" />
          <circle cx={tip.x} cy={tip.y} r={onLabel ? BUBBLE_R : 5} className="fill-accent-fill" />
          {labels.map((l) => (
            <text
              key={l.n}
              x={l.pos.x}
              y={l.pos.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={14}
              fontWeight={l.n === selectedLabel && onLabel ? 600 : 400}
              className={cn(
                "pointer-events-none tabular-nums",
                l.n === selectedLabel && onLabel ? "fill-on-accent" : "fill-foreground",
              )}
            >
              {l.text}
            </text>
          ))}
        </svg>

        <div className="flex items-center justify-between">
          {!required && t ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
              Clear
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
