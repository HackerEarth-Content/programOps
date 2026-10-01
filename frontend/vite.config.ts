// Standalone TanStack Start vite config -- the original Lovable-generated
// project used the private @lovable.dev/vite-tanstack-config wrapper (not on
// public npm), which bundled these same plugins plus Lovable-only telemetry/
// sandbox-detection. Reconstructed here from public packages so this runs
// outside the Lovable editor. Deploy target: node (not Lovable's default
// Cloudflare) via the TanStack Start Nitro preset.
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: { port: 5173 },
  plugins: [
    viteTsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      server: { entry: "server", preset: "node-server" },
    }),
    viteReact(),
  ],
});
