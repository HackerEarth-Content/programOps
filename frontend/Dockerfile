# Standalone TanStack Start image. No proxy and no link to the
# backend container: the browser (and SSR) call the backend's public URL, which is
# baked in at build time from frontend/.env (VITE_API_BASE_URL=https://api.example.com).
FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
# ponytail: package-lock.json is out of sync with package.json (npm ci fails), so npm install;
# run `npm install` locally, commit the lockfile and switch back to `npm ci`.
RUN npm install
COPY . .
RUN npm run build

# ponytail: runtime reuses the build stage (node_modules incl. dev deps) because the
# build is a plain fetch handler (dist/server/server.js), not a Nitro bundle; serve.mjs
# runs it with srvx. Slim down with `npm prune --omit=dev` once srvx is a direct dependency.
ENV PORT=80
EXPOSE 80
CMD ["node", "serve.mjs"]
