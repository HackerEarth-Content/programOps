import { createFileRoute } from "@tanstack/react-router";
import { CsmQueue } from "@/components/csm-queue";

export const Route = createFileRoute("/queue/csm")({ component: CsmQueue });
