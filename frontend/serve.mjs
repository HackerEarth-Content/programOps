// Production server for the TanStack Start build: static client assets + SSR handler.
import { serve } from "srvx";
import { serveStatic } from "srvx/static";
import app from "./dist/server/server.js";

serve({
  port: process.env.PORT ?? 3000,
  middleware: [serveStatic({ dir: "./dist/client" })],
  fetch: app.fetch,
});
