import { createFileRoute } from "@tanstack/react-router";
import { ProgramDetail } from "@/components/program-detail";

// No loader/SSR prefetch here on purpose: these queries require the auth
// cookie, which isn't available during server-side rendering in this
// cross-port dev setup (frontend :5173, backend :8000) -- prefetching would
// unconditionally 401 on every server render, even for a signed-in user.
// ProgramDetail fetches client-side instead, where the real cookie is present.
export const Route = createFileRoute("/programs/$ticketId")({
  head: () => ({
    meta: [
      { title: "Program - ProgramOps" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ProgramPage,
});

function ProgramPage() {
  const { ticketId } = Route.useParams();
  return <ProgramDetail ticketId={ticketId} />;
}
