import { createFileRoute } from "@tanstack/react-router";
import { ProgramsDirectory } from "@/components/programs-directory";

// No SSR loader prefetch on purpose: these queries need the auth cookie, which isn't available
// server-side in this cross-port dev setup. The directory fetches client-side instead.
export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Programs Directory - ProgramOps" }] }),
  component: ProgramsDirectory,
});
