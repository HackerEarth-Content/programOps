import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { Skeleton } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDay, formatWhen } from "@/lib/format";
import { weeklyBrief, type WeeklyBrief } from "@/lib/portfolio-api";

const SECTIONS: {
  key: keyof Pick<WeeklyBrief, "highlights" | "needs_attention" | "risks" | "next_week">;
  title: string;
}[] = [
  { key: "highlights", title: "Highlights" },
  { key: "needs_attention", title: "Needs attention" },
  { key: "risks", title: "Risks" },
  { key: "next_week", title: "Next week" },
];

const asText = (b: WeeklyBrief) =>
  [
    b.headline,
    "",
    b.summary,
    ...SECTIONS.flatMap((s) =>
      b[s.key].length ? ["", s.title, ...b[s.key].map((i) => `- ${i}`)] : [],
    ),
  ].join("\n");

/** The AI summary of what happened across programs. Generated when opened, kept 30 minutes by the server. */
export function WeeklyBriefButton() {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(7);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const qc = useQueryClient();
  const brief = useQuery({
    queryKey: ["weekly-brief", days],
    queryFn: () => weeklyBrief(days, false),
    enabled: open,
    staleTime: 30 * 60_000,
    retry: false,
  });
  const b = brief.data;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Sparkles /> Weekly brief
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Weekly brief</DialogTitle>
            <DialogDescription>
              What moved across programs, written from stage changes and notes.
              {b &&
                ` ${formatDay(b.period_start)} to ${formatDay(b.period_end)} · generated ${formatWhen(b.generated_at)}.`}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              Period
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                aria-label="Period in days"
                className="h-9 rounded-[8px] border border-border bg-surface px-2.5 text-[13px]"
              >
                <option value={7}>Last 7 days</option>
                <option value={14}>Last 14 days</option>
                <option value={30}>Last 30 days</option>
              </select>
            </label>
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              disabled={!b || regenerating}
              onClick={async () => {
                setRegenerating(true);
                try {
                  qc.setQueryData(["weekly-brief", days], await weeklyBrief(days, true));
                } finally {
                  setRegenerating(false);
                }
              }}
            >
              <RefreshCw className={regenerating ? "animate-spin" : undefined} /> Regenerate
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!b}
              onClick={async () => {
                if (!b) return;
                await navigator.clipboard.writeText(asText(b));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>

          <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
            {brief.isLoading && (
              <div className="space-y-3" aria-busy>
                <p className="flex items-center gap-2 text-[13px] text-ink-2">
                  <Loader2 className="size-4 animate-spin" /> Writing the brief. This can take about
                  ten seconds.
                </p>
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-16" />
                <Skeleton className="h-24" />
              </div>
            )}
            {brief.isError && (
              <div className="rounded-[10px] bg-danger-bg px-3.5 py-3 text-[14px] text-danger">
                The brief couldn't be generated right now. Try again in a moment.
                <div className="mt-2">
                  <Button variant="outline" size="sm" onClick={() => void brief.refetch()}>
                    Try again
                  </Button>
                </div>
              </div>
            )}
            {b && (
              <>
                <div>
                  <h3 className="text-[18px] font-semibold leading-6">{b.headline}</h3>
                  <p className="mt-1.5 leading-6 text-ink-2">{b.summary}</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["Programs", b.programs_covered],
                    ["Stage moves", b.stage_moves],
                    ["Notes", b.notes_logged],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-[10px] bg-raised p-3">
                      <p className="text-[12px] text-ink-3">{k}</p>
                      <p className="text-[20px] font-semibold">{v}</p>
                    </div>
                  ))}
                </div>
                {SECTIONS.map(
                  (s) =>
                    b[s.key].length > 0 && (
                      <section key={s.key}>
                        <h4 className="mb-1.5 text-[13px] font-semibold">{s.title}</h4>
                        <ul className="space-y-1.5">
                          {b[s.key].map((item, i) => (
                            <li key={`${s.key}-${i}`} className="flex gap-2 text-[14px] leading-6">
                              <span
                                aria-hidden
                                className="mt-2.5 size-1 shrink-0 rounded-full bg-ink-3"
                              />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ),
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
