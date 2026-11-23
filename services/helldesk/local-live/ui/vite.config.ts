import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'

// Federated HELLDESK SPA.
//
// - Serves the STANDALONE React SPA at /helldesk (base - the local Bun runtime
//   serves ui/dist/index.html for /helldesk, and HashRouter drives internal nav).
// - `@/components/helldesk/*` and `@/lib/helldesk/*` resolve to the VERBATIM
//   HELLDESK UI federated from the HELLDESK cloud source (federated/src).
// - every other `@/*` resolves to the thin LOCAL shim layer (federated/shim)
//   that maps the original Next.js/tRPC/shadcn surface onto the NAI-Lattice
//   JSON-RPC + local-live REST runtime: useTRPC, Button, PageContainer,
//   components/ui/*, components/shared/*, routing, lib/utils.
// - `next/navigation` and `next/link` are shimmed onto react-router.
export default defineConfig({
  base: '/helldesk/',
  plugins: [react()],
  // metrics.ts returns JSX (`<svg>` sparklines) though it is a `.ts` file; Vite's
  // default esbuild loader parses `.ts` WITHOUT JSX, so JSX-in-.ts fails to
  // transform. Tell esbuild to load every `.ts` as TSX too (harmless for plain
  // `.ts`; required for the ones carrying JSX).
  // @ts-expect-error esbuild.loader is a user-config key, not part of the public type
  esbuild: { loader: { '.ts': 'tsx' } },
  resolve: {
    alias: {
      // Verbatim original HELLDESK client pages/components + client data contract.
      '@/components/helldesk': path.resolve(import.meta.dirname, 'federated/src/components/helldesk'),
      '@/lib/helldesk': path.resolve(import.meta.dirname, 'federated/src/lib/helldesk'),
      // Next.js routing shims (react-router backed).
      'next/navigation': path.resolve(import.meta.dirname, 'federated/shim/next/navigation.ts'),
      'next/link': path.resolve(import.meta.dirname, 'federated/shim/next/link.tsx'),
      // Local shim layer for everything else (tRPC adapter, UI primitives...).
      '@': path.resolve(import.meta.dirname, 'federated/shim'),
    },
  },
  server: {
    port: 8791,
    proxy: {
      // NAI-Lattice JSON-RPC (canonical engine)
      '/project': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/dashboard': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      // local-live REST
      '/api': { target: 'http://127.0.0.1:8790', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8790', changeOrigin: true },
    },
  },
})