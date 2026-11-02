import { useMutation } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Chip, Segmented } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { PlanActivity, PlanPatch } from "@/lib/marketing-api";
import { formatDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import { errText, maxGoLiveIso, parseDate, parseSheet, todayIso, utmKey } from "./shared";

type RowState = {
  a: PlanActivity;
  utm: string;
  date: string;
  utmError: string | null;
  dateError: string | null;
  ready: boolean;
  chip: { label: string; tone: "good" | "warning" | "critical" | "neutral" };
};

/** "Fill UTMs and go-live dates": editable table with validation, paste-from-sheet and CSV import. */
export function BulkUtmDialog({
  open,
  onOpenChange,
  rows,
  allRows,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Activities that still need a UTM, a date or both. */
  rows: PlanActivity[];
  /** The whole plan, to catch a UTM that is already used elsewhere. */
  allRows: PlanActivity[];
  onSave: (entries: [PlanActivity, PlanPatch][]) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<number, string>>({});
  const [dates, setDates] = useState<Record<number, string>>({});
  const [mode, setMode] = useState<"edit" | "paste">("edit");
  const [pasteText, setPasteText] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const today = todayIso();
  const max = maxGoLiveIso();

  // Who already owns each UTM: the saved plan first, then earlier rows of this table.
  const states = useMemo<RowState[]>(() => {
    const owner = new Map<string, string>();
    allRows.forEach((r) => r.utm && owner.set(utmKey(r.utm), r.code));
    return rows.map((a) => {
      const utm = a.utm ?? (values[a.id] ?? "").trim();
      const date = a.planned_date ?? dates[a.id] ?? "";
      let utmError: string | null = null;
      if (!a.utm && utm) {
        const k = utmKey(utm);
        if (/[^\w.-]/.test(utm)) utmError = "Letters, numbers, _ . - only; no spaces";
        else if (owner.has(k) && owner.get(k) !== a.code)
          utmError = `Already used by ${owner.get(k)}`;
        else owner.set(k, a.code);
      }
      let dateError: string | null = null;
      if (!a.planned_date && date && (date < today || date > max))
        dateError = `Between ${formatDay(today)} and ${formatDay(max)}`;
      const ready = !!utm && !!date && !utmError && !dateError;
      const chip: RowState["chip"] =
        utmError || dateError
          ? { label: "Fix", tone: "critical" }
          : ready
            ? { label: "Ready", tone: "good" }
            : !utm && !date
              ? { label: "Empty", tone: "neutral" }
              : { label: !date ? "Needs date" : "Needs UTM", tone: "warning" };
      return { a, utm, date, utmError, dateError, ready, chip };
    });
  }, [rows, allRows, values, dates, today, max]);

  const ready = states.filter((s) => s.ready);
  const incomplete = states.length - ready.length;
  const patchFor = (s: RowState): PlanPatch => ({
    ...(!s.a.utm ? { utm: s.utm } : {}),
    ...(!s.a.planned_date ? { planned_date: s.date } : {}),
  });

  // Paste / CSV: match by activity id and show the result before anything touches the table.
  const matches = useMemo(() => {
    const byCode = new Map(rows.map((a) => [a.code.toLowerCase(), a]));
    return parseSheet(pasteText).map((r) => {
      const a = byCode.get(r.id.trim().toLowerCase()) ?? null;
      const date = r.date.trim() ? parseDate(r.date) : "";
      const problem = !a
        ? "No activity here with this id"
        : r.date.trim() && !date
          ? "Date not understood"
          : null;
      return { ...r, a, date: date ?? "", problem };
    });
  }, [pasteText, rows]);
  const usable = matches.filter((m) => m.a && !m.problem && (m.utm.trim() || m.date));
  const applyPaste = () => {
    const nv = { ...values };
    const nd = { ...dates };
    for (const m of usable) {
      if (!m.a) continue;
      if (!m.a.utm && m.utm.trim()) {
        nv[m.a.id] = m.utm.trim();
      }
      if (!m.a.planned_date && m.date) nd[m.a.id] = m.date;
    }
    setValues(nv);
    setDates(nd);
    setPasteText("");
    setMode("edit");
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    setPasteText(await f.text());
    setMode("paste");
    if (file.current) file.current.value = "";
  };

  const save = useMutation({
    mutationFn: () => onSave(ready.map((s) => [s.a, patchFor(s)] as [PlanActivity, PlanPatch])),
    onSuccess: () => {
      setValues({});
      setDates({});
      setPasteText("");
      setMode("edit");
      onOpenChange(false);
    },
  });
  const reason =
    ready.length === 0
      ? "Nothing to save yet: a row needs a valid UTM and a go-live date."
      : save.isPending
        ? "Saving…"
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl gap-0 overflow-hidden p-0 sm:rounded-lg">
        <DialogHeader className="px-5 pb-3 pt-5 pr-12">
          <DialogTitle className="text-[16px] leading-6">Fill UTMs and go-live dates</DialogTitle>
          <DialogDescription className="text-[13px] text-ink-2">
            {rows.length} {rows.length === 1 ? "activity needs" : "activities need"} a UTM, a date,
            or both. Edit below, or paste rows from a sheet.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-y border-border px-5 py-3">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { id: "edit", label: "Edit table" },
              { id: "paste", label: "Paste from sheet" },
            ]}
          />
          <input
            ref={file}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="sr-only"
            aria-label="Import CSV file"
            tabIndex={-1}
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}>
            Import CSV
          </Button>
          <div className="flex-1" />
        </div>

        {mode === "paste" && (
          <div className="space-y-2 border-b border-border px-5 py-4">
            <label className="block text-[13px] font-medium" htmlFor="bulk-paste">
              Paste rows
            </label>
            <Textarea
              id="bulk-paste"
              rows={4}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste from Google Sheets or Excel. Columns: activity id, UTM, go-live date (dd/mm/yyyy). Rows are matched by activity id."
              className="font-mono text-[12px]"
            />
            {matches.length > 0 ? (
              <div className="space-y-2">
                <p className="text-[13px] text-ink-2">
                  <b className="font-medium text-foreground">{usable.length}</b> of {matches.length}{" "}
                  {matches.length === 1 ? "row matches" : "rows match"} an activity on this list.
                  Nothing is applied until you confirm.
                </p>
                <ul className="max-h-36 divide-y divide-border overflow-y-auto rounded-lg border border-border text-[13px]">
                  {matches.map((m, i) => (
                    <li
                      key={i}
                      className="grid grid-cols-[96px_minmax(0,1fr)_96px] items-center gap-2 px-3 py-1.5"
                    >
                      <span className="font-mono">{m.id || "—"}</span>
                      <span className="truncate">
                        <span className="font-mono">{m.utm || "—"}</span>
                        {m.problem ? null : <span className="text-ink-2"> · {m.a?.title}</span>}
                      </span>
                      {m.problem ? (
                        <span className="text-right text-danger" title={m.problem}>
                          {m.problem.startsWith("No") ? "No match" : "Bad date"}
                        </span>
                      ) : (
                        <span className="text-right tabular-nums text-ink-2">
                          {m.date ? formatDay(m.date) : "—"}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-[13px] text-ink-2">
                Nothing is saved until you confirm the table.
              </p>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={usable.length === 0}
              onClick={applyPaste}
            >
              Apply {usable.length || ""} to the table
            </Button>
          </div>
        )}

        <div className="max-h-[48vh] overflow-auto">
          <div className="sticky top-0 z-[1] hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1.5fr)_160px_96px] gap-3 border-b border-border bg-card px-5 py-2 text-[13px] text-ink-2 md:grid">
            <span>Activity</span>
            <span>UTM campaign</span>
            <span>Go-live date</span>
            <span>State</span>
          </div>
          {states.map((s) => {
            const { a } = s;
            return (
              <div
                key={a.id}
                className="grid grid-cols-1 gap-2 border-b border-border px-5 py-2.5 last:border-b-0 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.5fr)_160px_96px] md:items-start md:gap-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium">{a.title}</p>
                  <p className="text-[13px] text-ink-2">
                    <span className="font-mono">{a.code}</span> · {a.channel}
                  </p>
                </div>
                <div>
                  <Input
                    className={cn("font-mono text-[13px]", s.utmError && "border-danger")}
                    value={a.utm ?? values[a.id] ?? ""}
                    disabled={!!a.utm}
                    placeholder={a.utm ? "" : "campaign_name"}
                    aria-label={`UTM for ${a.title}`}
                    aria-invalid={!!s.utmError}
                    onChange={(e) => setValues({ ...values, [a.id]: e.target.value })}
                  />
                  {s.utmError ? (
                    <p role="alert" className="mt-0.5 text-[12px] text-danger">
                      {s.utmError}
                    </p>
                  ) : null}
                </div>
                <div>
                  <Input
                    type="date"
                    min={today}
                    max={max}
                    className={cn(s.dateError && "border-danger")}
                    value={a.planned_date ?? dates[a.id] ?? ""}
                    disabled={!!a.planned_date}
                    aria-label={`Go-live date for ${a.title}`}
                    aria-invalid={!!s.dateError}
                    onChange={(e) => setDates({ ...dates, [a.id]: e.target.value })}
                  />
                  {s.dateError && (
                    <p role="alert" className="mt-0.5 text-[12px] text-danger">
                      {s.dateError}
                    </p>
                  )}
                </div>
                <div className="flex h-8 items-center">
                  <Chip tone={s.chip.tone}>{s.chip.label}</Chip>
                </div>
              </div>
            );
          })}
        </div>

        {save.isError && (
          <p role="alert" className="border-t border-border px-5 py-2 text-[13px] text-danger">
            {errText(save.error)}
          </p>
        )}
        <DialogFooter className="flex-col items-stretch gap-2 border-t border-border px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:space-x-0">
          <div className="text-[13px] text-ink-2">
            <b className="font-semibold text-foreground">
              {ready.length} of {states.length}
            </b>{" "}
            ready to save · {incomplete} still incomplete and will stay pending
            {reason && <p className="text-[12px]">{reason}</p>}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={ready.length === 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : `Save ${ready.length} ready`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
