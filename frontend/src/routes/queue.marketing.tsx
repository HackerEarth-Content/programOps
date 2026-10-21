import { createFileRoute } from "@tanstack/react-router";
import { MarketingQueue } from "@/components/marketing-queue";

export const Route = createFileRoute("/queue/marketing")({ component: MarketingQueue });
