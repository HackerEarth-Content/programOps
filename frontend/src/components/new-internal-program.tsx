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
import { sendJson, useCan, type Program } from "@/lib/api";

/**
 * Start an internal hackathon: run by HackerEarth itself, so there is no HubSpot ticket and no feasibility step.
 * It is created at Onboarding and its stage and checklist are kept in ProgramOps.
 */
export function NewInternalProgram() {
  const canCreate = useCan("program.create");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const create = useMutation({
    mutationFn: () =>
      sendJson<Program>("POST", "/programs/internal", {
        name: name.trim(),
        registration_start_date: start || null,
        event_end_date: end || null,
      }),
    onSuccess: async (program) => {
      await qc.invalidateQueries({ queryKey: ["programs"] });
      setOpen(false);
      setName("");
      setStart("");
      setEnd("");
      void navigate({ to: "/programs/$ticketId", params: { ticketId: program.ticket_id } });
    },
  });
  if (!canCreate) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus /> New internal hackathon
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
              <DialogTitle>New internal hackathon</DialogTitle>
              <DialogDescription>
                For programs HackerEarth runs itself, so no HubSpot ticket and no feasibility step.
                It starts at Onboarding, and its stage and checklist are kept here.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-3">
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
