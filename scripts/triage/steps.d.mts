export interface StepInput {
  env: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  cwd?: string;
  log?: (message: string) => void;
}
export type Outputs = Record<string, string>;
export const MAINTAINER: string;
export const OUTPUTS: Record<string, string[]>;
export function parseIssues(raw: string | undefined): number[];
export function select(input: StepInput): Promise<Outputs>;
export function redactIssues(input: StepInput): Promise<Outputs>;
export function prepare(input: StepInput): Promise<Outputs>;
export function decideStep(input: StepInput): Promise<Outputs>;
export function requeue(input: StepInput): Promise<Outputs>;
export function hold(input: StepInput): Promise<Outputs>;
export function openPr(input: StepInput): Promise<Outputs>;
export function apply(input: StepInput): Promise<Outputs>;
export const STEPS: Record<string, (input: StepInput) => Promise<Outputs>>;
export function writeOutputs(file: string, outputs: Outputs): void;
export function readOutputs(text: string): Outputs;
