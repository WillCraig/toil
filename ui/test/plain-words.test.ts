/**
 * Plain words (src/plain-words.ts): where the switch starts, the three words
 * it swaps inside a sentence, and the lookup that keeps a command typed
 * exactly. Pure functions, so no page is needed to hold them to it.
 */

import { describe, expect, it } from 'vitest';
import { initialPlain, plainify, wordsFor } from '../src/plain-words.ts';

describe('where plain words start', () => {
  it('follows ?words= in the address first, then what the browser saved, then plain', () => {
    expect(initialPlain('?words=plain', 'standard')).toBe(true);
    expect(initialPlain('?words=standard', 'plain')).toBe(false);
    expect(initialPlain('?words=off', 'plain')).toBe(false);
    expect(initialPlain('?theme=crate', 'plain')).toBe(true);
    expect(initialPlain('?words=nonsense', null)).toBe(true);
  });

  it('is plain for anyone who has not chosen (#552)', () => {
    expect(initialPlain('', null)).toBe(true);
    expect(initialPlain('?theme=realm', null)).toBe(true);
  });

  it('stays standard for someone who opted out, in the address or in this browser', () => {
    expect(initialPlain('?words=standard', null)).toBe(false);
    expect(initialPlain('', 'standard')).toBe(false);
    expect(initialPlain('?words=plain', 'standard')).toBe(true);
  });
});

describe('plainify', () => {
  it('swaps dossier, pull request and agent, keeping plurals and writing Toil project with its capital T', () => {
    expect(plainify('Each dossier is one body of work.')).toBe('Each Toil project is one body of work.');
    expect(plainify('Dossiers and pull requests')).toBe('Toil projects and code reviews');
    expect(plainify('Pull requests, then agents')).toBe('Code reviews, then AI helpers');
    expect(plainify('An agent, two agents')).toBe('An AI helper, two AI helpers');
    expect(plainify("the dossier's agents")).toBe("the Toil project's AI helpers");
  });

  it('never says team for a dossier', () => {
    expect(plainify('A dossier names its repositories.')).not.toMatch(/team/i);
  });

  it('leaves a dossier inside an id or a path alone', () => {
    expect(plainify('Topic dossier-setup, key dossier:card-payments, page dossier.eyebrow')).toBe('Topic dossier-setup, key dossier:card-payments, page dossier.eyebrow');
  });

  it('leaves an agent inside a package, a path, a file name or a header alone', () => {
    for (const s of ['@anthropic-ai/claude-agent-sdk', 'ui/server/agents/install.ts', 'See AGENTS.md first', 'the user-agent header', 'label agent:refine', 'src/agent.ts']) expect(plainify(s)).toBe(s);
    expect(plainify('Install @anthropic-ai/claude-agent-sdk, then ask the agent.')).toBe('Install @anthropic-ai/claude-agent-sdk, then ask the AI helper.');
    expect(plainify('Ask the agent.')).toBe('Ask the AI helper.');
  });

  it('leaves a toil command exactly as typed', () => {
    expect(plainify('Made with toil dossiers init.')).toBe('Made with toil dossiers init.');
    expect(plainify('Run toil dossiers describe card-payments, then ask the dossier.')).toBe('Run toil dossiers describe card-payments, then ask the Toil project.');
  });
});

describe('wordsFor', () => {
  const lexicon = { 'dossiers.lede': 'Each dossier is one consignment of work.' };

  it('reads as wording.ts does with plain words off', () => {
    expect(wordsFor(lexicon, true, false, 'dossiers.lede')).toBe('Each dossier is one consignment of work.');
    expect(wordsFor(undefined, false, false, 'ask.placeholder', { name: 'card-payments' })).toBe('Ask about card-payments');
  });

  it('uses its own text for a key it words, over the theme', () => {
    expect(wordsFor(lexicon, true, true, 'dossier.eyebrow')).toBe('Toil project');
    // One sentence; "called a dossier on the command line" is in the (i), not the lede.
    expect(wordsFor(lexicon, true, true, 'dossiers.lede')).toBe('Pick a Toil project to see its stories, code reviews and releases together.');
    expect(wordsFor(lexicon, true, true, 'ask.placeholder', { name: 'card-payments' })).toBe('Ask a question about card-payments');
  });

  it('swaps the jargon in a key it leaves to the theme or the standard text', () => {
    expect(wordsFor(lexicon, true, true, 'empty.prs')).toBe('No code reviews for this Toil project.');
    expect(wordsFor(undefined, false, true, 'empty.deployments')).toBe('This Toil project names no environment to read deployments from.');
  });

  it('keeps every {name} and every toil command the standard text has, in its own text', () => {
    // The empty state drops "made with toil dossiers init" because the first-run steps beside it have a Create button.
    expect(wordsFor(undefined, false, true, 'empty.dossiers')).toBe('toil sees no Toil projects yet.');
    expect(wordsFor(undefined, false, true, 'loading.dossier', { name: 'settlement' })).toBe('Reading settlement…');
  });
});
