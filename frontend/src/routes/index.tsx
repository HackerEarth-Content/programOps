import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/components/dashboard";

export const Route = createFileRoute("/")({
  // Scopes the dashboard to a program type via ?view=hackathons|hiring --
  // stage counts and campaign/event breakdowns are then recomputed
  // client-side from the (already-fetched) programs list for that scope,
  // same as the "All programs" case, so there's one source of truth
  // instead of a separate scoped-vs-unscoped aggregation path.
  validateSearch: (search: Record<string, unknown>): { view?: "hackathons" | "hiring" } => {
    if (search["view"] === "hackathons") return { view: "hackathons" };
    if (search["view"] === "hiring") return { view: "hiring" };
    return {};
  },
  // No SSR loader prefetch here on purpose -- these queries need the auth
  // cookie, which isn't available server-side in this cross-port dev setup.
  // Dashboard fetches client-side instead, once the real cookie is present.
  head: () => ({
    meta: [
      { title: "ProgramOps - HackerEarth" },
      {
        name: "description",
        content: "Operational analytics for HackerEarth hackathon and hiring-challenge programs.",
      },
      { property: "og:title", content: "ProgramOps | HackerEarth" },
      {
        property: "og:description",
        content: "Operational analytics for HackerEarth hackathon and hiring-challenge programs.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return <Dashboard />;
}
