import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';
import { META_CSP } from './server/csp.ts';
import { parseChangelog } from './src/whats-new.ts';

// The UI is static files any server can host under any path: the site serves
// the preview at /toil/ui/app/, and the local server serves the app at its
// own base path (a setting, #206). Relative asset URLs and hash routes keep both
// working without telling the build where it will live.
// It reads the OWI types and the sprint fixture from the repository root, one
// copy for the CLI and the UI, so the dev server may read above ui/.
//
// Two builds from one page: the default is the site preview (dist/preview/, on
// the fixture execute() and the scripted Agent, src/main.tsx); `--mode app` is
// what the toil-ui package serves (dist/app/, on the local server's API,
// src/local.tsx). The server itself is vite.server.config.ts.

/** Points index.html at the local app's entry, and drops the preview's wording. */
function localApp(): Plugin {
  return {
    name: 'toil-ui-local-entry',
    // 'pre', so the entry is swapped before Vite reads index.html for the scripts to bundle.
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html
        .replace('/src/main.tsx', '/src/local.tsx')
        .replace('<title>Toil UI preview</title>', '<title>Toil UI</title>')
        .replace(/<meta name="description" content="[^"]*" \/>/, '<meta name="description" content="Toil UI, running on this machine: work across Jira, Azure DevOps and GitHub, read through toil." />'),
    },
  };
}

/**
 * The server's Content-Security-Policy as a <meta> tag in the built page, so the
 * site preview, which a static host serves, holds to it too. Build only: Vite's
 * dev server injects inline script for hot reload.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'toil-ui-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${META_CSP}" />`),
  };
}

/**
 * What's new (#417): both packages' release notes, read when the app is built
 * and served as `virtual:whats-new`, so the page never fetches them. It holds
 * the versions this build runs on too: Toil UI's own, and the toil it pins
 * (the local app asks its server for the toil it really runs).
 */
function whatsNew(): Plugin {
  const id = 'virtual:whats-new';
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  return {
    name: 'toil-ui-whats-new',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const pkg = JSON.parse(read('./package.json')) as { version: string; dependencies: Record<string, string> };
      const releases = [...parseChangelog(read('./CHANGELOG.md'), 'ui'), ...parseChangelog(read('../CHANGELOG.md'), 'toil')];
      const current = { ui: pkg.version, toil: pkg.dependencies['@imagile-dev/toil'] ?? '0.0.0' };
      return `export const releases = ${JSON.stringify(releases)};\nexport const current = ${JSON.stringify(current)};\n`;
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react(), contentSecurityPolicy(), whatsNew(), ...(mode === 'app' ? [localApp()] : [])],
  server: { fs: { allow: ['..'] } },
  build: {
    outDir: mode === 'app' ? 'dist/app' : 'dist/preview',
    emptyOutDir: true,
    // Fonts stay files, never data: URLs, so the Content-Security-Policy can say `font-src 'self'`.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
  test: {
    // The tests run against toil from source, as test/registry.test.ts already
    // does, so a change to toil's commands and the UI's use of it land in one PR
    // and are tested together. The published pin is bumped when toil releases.
    alias: { '@imagile-dev/toil/api': fileURLToPath(new URL('../src/api.ts', import.meta.url)) },
    // Node by default: a test file that needs a DOM says so on its first line
    // (`// @vitest-environment jsdom`), so the ones that don't skip jsdom's startup (#579).
    environment: 'node',
    // Half the cores: at 16 workers on a 16-thread machine the jsdom files starve
    // each other and the slowest cases time out at 5 s; half is faster and green.
    maxWorkers: '50%',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
}));
