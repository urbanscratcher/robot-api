import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Connect } from 'vite';
const blockPrivateFiles: Connect.NextHandleFunction = (req, res, next) => {
  let path: string;
  try { path = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  if (/^\/(?:server|data|\.git|\.aws)(?:\/|$)|(?:^|\/)\.env(?:\.|\/|$)|\.(?:pem|key|crt)$/i.test(path)) {
    res.writeHead(403, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' });
    res.end('Forbidden'); return;
  }
  next();
};
const editions = new Set(['elle', 'vogue', 'chosun', 'donga', 'kyunghyang', 'time', 'newyorker', 'atlantic', 'natgeo', 'wired']);
const editionRoutes: Connect.NextHandleFunction = (req, _res, next) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const slug = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  if (editions.has(slug)) req.url = `/editions/${slug}.html${url.search}`;
  next();
};
const proxy = {
  "/api": { target: "http://127.0.0.1:3002", changeOrigin: true },
};
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss(), {
    name: 'private-file-boundary',
    configureServer(server) { server.middlewares.use(blockPrivateFiles); },
    configurePreviewServer(server) { server.middlewares.use(blockPrivateFiles); },
  }, {
    name: 'newspaper-editions',
    configureServer(server) { server.middlewares.use(editionRoutes); },
    configurePreviewServer(server) { server.middlewares.use(editionRoutes); },
  }],
  build: { sourcemap: false },
  server: {
    fs: { deny: ["**/.env", "**/.env.*", "**/server/**", "**/data/**", "**/*.pem", "**/*.crt", "**/*.key", "**/.git/**"] },
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    allowedHosts: ["n.joun.cc"],
    proxy,
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    allowedHosts: ["n.joun.cc"],
    proxy: {
      "/api": {
        ...proxy["/api"],
        target: "http://127.0.0.1:3102",
        headers: { "X-Overheard-Public": "1" },
      },
    },
  },
});
