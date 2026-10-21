import { createFileRoute } from "@tanstack/react-router";
import { AdminPage } from "@/components/admin-page";
import { parseSection, type Section } from "@/lib/admin-api";

export const Route = createFileRoute("/admin")({
  validateSearch: (search: Record<string, unknown>): { section?: Section } =>
    search["section"] === undefined ? {} : { section: parseSection(search["section"]) },
  component: AdminPage,
});
