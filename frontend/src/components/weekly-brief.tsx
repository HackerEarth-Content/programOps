import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Clock3,
  Copy,
  Loader2,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  fetchWeeklyBrief,
  formatWeeklyBriefForClipboard,
  getDemoWeeklyBrief,
  type WeeklyBrief,
} from "@/lib/weekly-brief.functions";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 px-3 py-1.5 text-center">
      <div className="font-mono text-sm font-semibold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function BriefSection({
  title,
  icon,
  tone,
  items,
}: {
  title: string;
  icon: ReactNode;
  tone: "primary" | "warning" | "destructive" | "muted";
  items: string[];
}) {
  if (items.length === 0) return null;

  const toneClass = {
    primary: "text-primary",
    warning: "text-warning",
    destructive: "text-destructive",
    muted: "text-muted-foreground",
  }[tone];

  return (
    <div>
      <p className={`mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase ${toneClass}`}>
        {icon} {title}
      </p>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-sm leading-6 text-foreground/90">
            <span className={`mt-2 size-1 shrink-0 rounded-full bg-current ${toneClass}`} />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BriefBody({ brief, isDemo }: { brief: WeeklyBrief; isDemo: boolean }) {
  return (
    <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
      {isDemo && (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          Couldn't reach the live generator, showing an example brief instead.
        </p>
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-semibold leading-tight">{brief.headline}</h3>
          <p className="mt-1 text-sm leading-6 text-foreground/90">{brief.summary}</p>
        </div>
        <CopyButton text={formatWeeklyBriefForClipboard(brief)} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <StatChip label="Programs" value={brief.programs_covered} />
        <StatChip label="Stage moves" value={brief.stage_moves} />
        <StatChip label="Notes" value={brief.notes_logged} />
      </div>

      <div className="space-y-4">
        <BriefSection
          title="Highlights"
          icon={<TrendingUp className="size-3.5" />}
          tone="primary"
          items={brief.highlights}
        />
        <BriefSection
          title="Needs attention"
          icon={<Clock3 className="size-3.5" />}
          tone="warning"
          items={brief.needs_attention}
        />
        <BriefSection
          title="Risks"
          icon={<AlertTriangle className="size-3.5" />}
          tone="destructive"
          items={brief.risks}
        />
        <BriefSection
          title="Next week"
          icon={<Sparkles className="size-3.5" />}
          tone="muted"
          items={brief.next_week}
        />
      </div>
    </div>
  );
}

// Generated on demand -- not cached, see the backend route's docstring for
// the caching tradeoff this leaves open. Only fires on click, never on page
// load, so opening the dashboard never spends OpenAI tokens by itself.
export function WeeklyBriefDialog() {
  const [open, setOpen] = useState(false);
  const mutation = useMutation({ mutationFn: () => fetchWeeklyBrief(7) });

  const brief = mutation.data;
  const demoBrief = mutation.isError ? getDemoWeeklyBrief() : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && mutation.status === "idle") mutation.mutate();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Sparkles /> Weekly brief
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>This week across the portfolio</DialogTitle>
          {!brief && (
            <DialogDescription>
              AI-generated summary of stage moves and notes logged this week.
            </DialogDescription>
          )}
        </DialogHeader>

        {mutation.isPending && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Generating summary…
          </div>
        )}

        {brief && <BriefBody brief={brief} isDemo={false} />}

        {demoBrief && (
          <div className="space-y-3">
            <BriefBody brief={demoBrief} isDemo />
            <Button variant="outline" size="sm" onClick={() => mutation.mutate()}>
              Try again
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
