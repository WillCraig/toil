/**
 * Plain words (src/plain-words.ts): always on, the words
 * it swaps inside a sentence, and the lookup that keeps a command typed
 * exactly. Pure functions, so no page is needed to hold them to it.
 */

import { describe, expect, it } from 'vitest';
import { plainify, usePlain, wordsFor } from '../src/plain-words.ts';

describe('plainify', () => {
  it('swaps Toil project, pull request and agent, keeping plurals and writing Toil project with its capital T', () => {
    expect(plainify('Each Toil project is one body of work.')).toBe('Each Toil project is one body of work.');
    expect(plainify('Toil projects and pull requests')).toBe('Toil projects and code reviews');
    expect(plainify('Pull requests, then agents')).toBe('Code reviews, then AI agents');
    expect(plainify('An agent, two agents')).toBe('An AI agent, two AI agents');
    expect(plainify("the Toil project's agents")).toBe("the Toil project's AI agents");
  });

  it('never says team for a Toil project', () => {
    expect(plainify('A Toil project names its repositories.')).not.toMatch(/team/i);
  });

  it('leaves a Toil project inside an id or a path alone', () => {
    expect(plainify('Topic toil-project-setup, key toilProject:card-payments, page toilProject.eyebrow')).toBe('Topic toil-project-setup, key toilProject:card-payments, page toilProject.eyebrow');
  });

  it('leaves an agent inside a package, a path, a file name or a header alone', () => {
    for (const s of ['@anthropic-ai/claude-agent-sdk', 'ui/server/agents/install.ts', 'See AGENTS.md first', 'the user-agent header', 'label agent:refine', 'src/agent.ts']) expect(plainify(s)).toBe(s);
    expect(plainify('Install @anthropic-ai/claude-agent-sdk, then ask the agent.')).toBe('Install @anthropic-ai/claude-agent-sdk, then ask the AI agent.');
    expect(plainify('Ask the agent.')).toBe('Ask the AI agent.');
  });

  it('leaves a toil command exactly as typed', () => {
    expect(plainify('Made with toil projects init.')).toBe('Made with toil projects init.');
    expect(plainify('Run toil projects describe card-payments, then ask the Toil project.')).toBe('Run toil projects describe card-payments, then ask the Toil project.');
  });
});

describe('wordsFor', () => {
  const lexicon = {
    'toilProjects.lede': 'Each Toil project is one consignment of work.',
    'toilProject.eyebrow': 'Homestead',
    'ask.placeholder': 'Ask the almanac about {name}',
  };

  it("reads a flavour key in the theme's words while themed wording is on, and plain otherwise", () => {
    expect(wordsFor(lexicon, true, 'toilProjects.lede')).toBe('Each Toil project is one consignment of work.');
    expect(wordsFor(lexicon, false, 'toilProjects.lede')).toBe('Pick a Toil project to see its stories, code reviews and releases together.');
    expect(wordsFor(undefined, true, 'toilProjects.lede')).toBe('Pick a Toil project to see its stories, code reviews and releases together.');
  });

  it('reads a functional key as one plain text, whatever the theme says', () => {
    expect(wordsFor(lexicon, true, 'toilProject.eyebrow')).toBe('Toil project');
    expect(wordsFor(lexicon, true, 'ask.placeholder', { name: 'card-payments' })).toBe('Ask a question about card-payments');
    expect(wordsFor(undefined, false, 'ask.placeholder', { name: 'card-payments' })).toBe('Ask a question about card-payments');
  });

  it('swaps the jargon in a themed sentence too', () => {
    expect(wordsFor({ 'empty.prs': 'No pull requests in the basket.' }, true, 'empty.prs')).toBe('No code reviews in the basket.');
    expect(wordsFor(undefined, false, 'empty.deployments')).toBe('This Toil project names no environment to read deployments from.');
  });

  it('keeps every {name} the plain text has', () => {
    expect(wordsFor(undefined, false, 'empty.toilProjects')).toBe('toil sees no Toil projects yet.');
    expect(wordsFor(undefined, false, 'loading.toilProject', { name: 'settlement' })).toBe('Reading settlement…');
  });
});

describe('usePlain', () => {
  it("is always on: pw is the plain text, and the hover names toil's term", () => {
    const p = usePlain();
    expect(p.on).toBe(true);
    expect(p.pw('Pull requests', 'Code reviews')).toBe('Code reviews');
    expect(p.title('Pull requests')).toBe('In toil: Pull requests');
    expect(p.text('Ask the agent.')).toBe('Ask the AI agent.');
  });
});
