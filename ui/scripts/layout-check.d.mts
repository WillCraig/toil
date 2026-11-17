export interface ThemeRun {
  theme: string;
  scheme: string;
  strict: boolean;
  routes?: string[];
}
export interface Shard {
  index: number;
  count: number;
}
export declare const ROUTES: string[];
export declare const WIDTHS: number[];
export declare const MOTION_ROUTES: string[];
export declare const FIRST_RUN_ROUTE: string;
export declare function themeRuns(): ThemeRun[];
export declare function parseShard(text: string | undefined): Shard | null;
export declare function shardRuns(runs: ThemeRun[], routes: string[], shard: Shard | null): ThemeRun[];
export declare function layoutWorkers(runs: ThemeRun[]): number;
export interface PersonalNeedles {
  texts: string[];
  segment: string | null;
}
export declare function personalNeedles(info?: { username: string; homedir: string } | null, home?: string): PersonalNeedles;
