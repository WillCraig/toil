import type { Client } from './ado.mjs';
import type { SeedRecord } from './generate.mjs';
export const MAP_FILE: string;
export const REASONS: Record<string, string | Record<string, string>>;
export function inOrder(items: SeedRecord[]): SeedRecord[];
export function apply(options: { items: SeedRecord[]; api: Client; identity?: string; dryRun?: boolean; backdate?: boolean; log?: (line: string) => void; now?: () => number }): Promise<{ ids: Map<string, number>; created: string[]; repaired: string[]; linked: string[]; backdated: boolean; skippedTags: Set<string> }>;
export function sprintOffset(paths: Set<string>, project: string): number;
