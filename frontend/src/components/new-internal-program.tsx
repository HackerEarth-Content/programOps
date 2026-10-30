import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
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
import { HIRING_CAMPAIGN_TYPE, sendJson, useCan, type Program } from "@/lib/api";

/**
 * Start an internal program (a hackathon or a hiring challenge): run by HackerEarth itself, so no feasibility step.
 * It is created at Onboarding, with a real HubSpot ticket when the portal can write to HubSpot.
 */
export function NewInternalProgram() {
  const canCreate = useCan("program.create");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("Hackathon");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const create = useMutation({
    mutationFn: () =>
      sendJson<Program>("POST", "/programs/internal", {
        name: name.trim(),
        campaign_type: type,
        registration_start_date: start || null,
        event_end_date: end || null,
      }),
    onSuccess: async (program) => {
      // the directory's totals and KPI cards come from the portfolio, the queues from their own queries
      await Promise.all(
        ["programs", "portfolio", "queues"].map((key) => qc.invalidateQueries({ queryKey: [key] })),
      );
      setOpen(false);
      setName("");
      setType("Hackathon");
      setStart("");
      setEnd("");
      void navigate({ to: "/programs/$ticketId", params: { ticketId: program.ticket_id } });
    },
  });
  if (!canCreate) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus /> New internal program
      </Button>
      <Dialog open={open} onOpenChange={(v) => !create.isPending && setOpen(v)}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>New internal program</DialogTitle>
              <DialogDescription>
                For hackathons and hiring challenges HackerEarth runs itself, so no feasibility
                step. It starts at Onboarding, and a ticket marked [Internal] is created for it in
                HubSpot.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-3">
              <label className="block space-y-1">
                <span className="text-[13px] text-ink-2">Event type</span>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[14px]"
                >
                  <option value="Hackathon">Hackathon</option>
                  <option value={HIRING_CAMPAIGN_TYPE}>Hiring challenge</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[13px] text-ink-2">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-[13px] text-ink-2">Registration opens</span>
                  <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
                </label>
                <label className="block space-y-1">
                  <span className="text-[13px] text-ink-2">Event ends</span>
                  <Input
                    type="date"
                    value={end}
                    min={start}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </label>
              </div>
              {create.isError && (
                <p className="text-[13px] text-danger">
                  {create.error instanceof Error ? create.error.message : "Couldn't create it."}
                </p>
              )}
            </div>
            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="ghost"
                disabled={create.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending && <Loader2 className="animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
