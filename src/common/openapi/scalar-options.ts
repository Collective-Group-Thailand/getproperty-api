import { SERVERS } from './servers';

/** Snippet targets Scalar knows; all but the three we keep are hidden (contract §5: fetch, curl, Node). */
const SNIPPET_TARGETS = [
  'c',
  'clojure',
  'csharp',
  'dart',
  'fsharp',
  'go',
  'http',
  'java',
  'js',
  'julia',
  'kotlin',
  'node',
  'objc',
  'ocaml',
  'php',
  'powershell',
  'python',
  'r',
  'ruby',
  'rust',
  'shell',
  'swift',
] as const;
const SNIPPETS_SHOWN: Partial<Record<(typeof SNIPPET_TARGETS)[number], string[]>> = {
  js: ['fetch'],
  node: ['fetch', 'undici'],
  shell: ['curl'],
};
const SNIPPET_CLIENTS: Partial<Record<(typeof SNIPPET_TARGETS)[number], string[]>> = {
  js: ['axios', 'fetch', 'jquery', 'ofetch', 'xhr'],
  node: ['axios', 'fetch', 'ofetch', 'undici'],
  shell: ['curl', 'httpie', 'wget'],
};

/**
 * Scalar options: groups by the surface tags, follows the system colour scheme, shows only
 * fetch / curl / Node snippets, and points "try it" at the local server in development and at the
 * sandbox everywhere else — the document keeps every server.
 */
export interface ScalarOptions {
  telemetry: false;
  withDefaultFonts: false;
  mcp: { disabled: true };
  defaultOpenAllTags: false;
  servers: { url: string; description: string }[];
  hiddenClients: Record<string, true | string[]>;
  defaultHttpClient: { targetKey: 'shell'; clientKey: 'curl' };
}

export function scalarOptions(local: boolean): ScalarOptions {
  const server = SERVERS.find((s) => s.description.startsWith(local ? 'Local' : 'Sandbox'))!;
  const hiddenClients = Object.fromEntries(
    SNIPPET_TARGETS.map((target) => {
      const shown = SNIPPETS_SHOWN[target];
      return [
        target,
        shown ? (SNIPPET_CLIENTS[target] ?? []).filter((c) => !shown.includes(c)) : (true as const),
      ];
    }),
  );
  return {
    // Nothing leaves the page: no telemetry, no Scalar fonts/proxy, no MCP integration.
    telemetry: false,
    withDefaultFonts: false,
    mcp: { disabled: true },
    defaultOpenAllTags: false,
    servers: [{ url: server.host ? `https://${server.host}` : server.url, description: server.description }],
    hiddenClients,
    defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
  };
}
