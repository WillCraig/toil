/**
 * What the preview's Settings, Agent shows about the adapters (#344): one
 * ready, one whose CLI is an npm shim Toil UI resolves, and one whose SDK
 * isn't installed, with the command Install would run on a global Toil UI.
 * Made up, with placeholder paths, so the status card and the Install dialog
 * have something to show; nothing here is installed or run. Sample
 * paperwork, stamped SPECIMEN.
 */

import type { AdapterStatus } from '../server-client.ts';
import { beforeDate, TESTED } from '../../server/agents/tested.ts';
import { FIXTURE_NOW } from './execute.ts';

const version = (name: keyof typeof TESTED) => TESTED[name][0]!.slice(TESTED[name][0]!.lastIndexOf('@') + 1);
const prefix = '/home/you/.npm-global';
const command = `npm install --global --prefix ${prefix} --ignore-scripts --before=${beforeDate(FIXTURE_NOW)} --no-audit --no-fund --omit=optional ${TESTED.claude.join(' ')}`;

export const SAMPLE_ADAPTER_STATUS: AdapterStatus[] = [
  {
    name: 'claude',
    label: 'Claude',
    package: '@anthropic-ai/claude-agent-sdk',
    installed: false,
    version: null,
    tested: version('claude'),
    cli: { path: '/home/you/.local/bin/claude', problem: null, fix: null },
    endpoints: ['anthropic', 'bedrock', 'foundry', 'vertex'],
    model: 'haiku',
    install: { adapter: 'claude', kind: 'global', folder: prefix, cli: null, command, argv: null, problem: null, fix: null },
    notes: [],
  },
  {
    name: 'copilot',
    label: 'GitHub Copilot',
    package: '@github/copilot-sdk',
    installed: true,
    version: version('copilot'),
    tested: version('copilot'),
    cli: { path: 'C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\npm-loader.js', problem: null, fix: null },
    endpoints: [],
    model: null,
    install: { adapter: 'copilot', kind: 'global', folder: prefix, command: command.replace(TESTED.claude.join(' '), TESTED.copilot.join(' ')), argv: null, problem: null, fix: null },
    notes: ["copilot.cmd on PATH is an npm shim the SDK can't start, so Toil UI starts the script it runs, C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\npm-loader.js, with Node."],
  },
  {
    name: 'codex',
    label: 'Codex',
    package: '@openai/codex-sdk',
    installed: true,
    version: version('codex'),
    tested: version('codex'),
    cli: { path: '/usr/local/bin/codex', problem: null, fix: null },
    endpoints: [],
    model: null,
    install: { adapter: 'codex', kind: 'global', folder: prefix, command: command.replace(TESTED.claude.join(' '), TESTED.codex.join(' ')), argv: null, problem: null, fix: null },
    notes: [],
  },
];
