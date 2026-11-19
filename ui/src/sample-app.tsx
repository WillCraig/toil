/**
 * The App on the preview's fixtures: `execute()` answering from canned
 * envelopes, the scripted Agent, a config that changes nothing, and the clock
 * pinned at FIXTURE_NOW. The site preview mounts it directly (src/main.tsx);
 * the local app loads it on request and only then (src/local.tsx,
 * src/sample-mode.tsx), so a real install's bundle carries the fixtures in a
 * chunk it fetches when somebody asks to look around, not before.
 */

import { useState } from 'react';
import { App } from './App.tsx';
import { scriptedAgent } from './fixtures/agent.ts';
import { fixtureAnalyses } from './fixtures/analyses.ts';
import { fixtureAssignments } from './fixtures/assignments.ts';
import { fixtureClassify } from './fixtures/classify.ts';
import { fixtureConfig } from './fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from './fixtures/execute.ts';
import { fixtureFeedback } from './fixtures/feedback.ts';
import { fixtureModelUsage } from './fixtures/model-usage.ts';
import { fixtureStandards } from './fixtures/standards.ts';
import { fixtureWorklog } from './fixtures/worklog.ts';

export function SampleApp({ onLeave }: { onLeave?: () => void }) {
  const [fixtures] = useState(() => ({
    execute: fixtureExecute().execute,
    agent: scriptedAgent({ delay: 18 }),
    config: fixtureConfig(),
    feedback: fixtureFeedback(),
    modelUsage: fixtureModelUsage(),
    assignments: fixtureAssignments(),
    worklog: fixtureWorklog(),
    analyses: fixtureAnalyses(),
    classify: fixtureClassify(),
    rules: fixtureStandards(),
  }));
  return <App {...fixtures} now={FIXTURE_NOW} preview {...(onLeave ? { onLeaveSample: onLeave } : {})} />;
}

export default SampleApp;
