import { describe, expect, it } from 'vitest';
import { aliasFrom, fieldCommands, guessOwi, previewValue, suggest } from './field-discovery.js';

describe('previewValue', () => {
  it('shows strings, numbers, option values, sprints and states, and never a person or rich text', () => {
    expect(previewValue(5)).toBe('5');
    expect(previewValue({ value: 'Platform' })).toBe('Platform');
    expect(previewValue([{ id: 7, name: 'Sprint 7', state: 'ACTIVE' }])).toBe('Sprint 7 (active)');
    expect(previewValue(['com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=7,rapidViewId=3,state=CLOSED,name=Sprint 7,startDate=2026-01-01,sequence=7]'])).toBe('Sprint 7');
    expect(previewValue({ accountId: 'abc12345', displayName: 'Pat Example', emailAddress: 'pat@example.com' })).toBe('(a person)');
    expect(previewValue({ type: 'doc', version: 1, content: [] })).toBe('(rich text)');
    expect(previewValue('mail pat@example.com now')).toBe('mail <email> now');
  });

  it('is never longer than 80 characters', () => {
    expect(previewValue('x'.repeat(500))).toHaveLength(80);
    expect(previewValue(Array.from({ length: 9 }, () => 'y'.repeat(60))).length).toBeLessThanOrEqual(80);
  });
});

describe('aliasFrom and suggest', () => {
  it('camelCases a display name', () => {
    expect(aliasFrom('Story point estimate', 'customfield_10016')).toBe('storyPointEstimate');
    expect(aliasFrom('Acceptance criteria (AC)', 'customfield_1')).toBe('acceptanceCriteriaAC');
    expect(aliasFrom('123 !!', 'customfield_10077')).toBe('field10077');
  });

  it('never gives a field an OWI key as its alias unless it is that OWI field', () => {
    const s = suggest([
      { id: 'customfield_1', name: 'Estimate', schema: { type: 'string' } },
      { id: 'customfield_2', name: 'Team', schema: { type: 'any', custom: 'com.atlassian.teams:rm-teams-custom-field-team' } },
    ]);
    expect(s.get('customfield_1')!.alias).toBe('estimateField');
    expect(s.get('customfield_2')).toMatchObject({ alias: 'team', owi: { field: 'team', confidence: 'high' } });
  });
});

describe('guessOwi', () => {
  it('is high for the schema or name Jira itself uses and medium for a likely name', () => {
    expect(guessOwi('Story Points', { type: 'number' })).toMatchObject({ field: 'estimate', confidence: 'high' });
    expect(guessOwi('Effort points', { type: 'number' })).toMatchObject({ field: 'estimate', confidence: 'medium' });
    expect(guessOwi('Story Points', { type: 'string' })).toBeUndefined();
    expect(guessOwi('Original estimate hours', { type: 'number' })).toBeUndefined();
    expect(guessOwi('Target end', { type: 'date' })).toMatchObject({ field: 'dueDate', confidence: 'medium' });
    expect(guessOwi('Crew', { type: 'option' })).toBeUndefined();
  });
});

describe('fieldCommands', () => {
  it('names the field, then points the OWI field at it with --replace', () => {
    const c = fieldCommands('payments', 'jira', [{ id: 'customfield_10016', alias: 'storyPoints', owi: 'estimate' }, { id: 'customfield_10200', alias: 'crew' }, { id: 'customfield_1', alias: 'team', owi: 'team' }]);
    expect(c.map((x) => x.line)).toEqual([
      'toil projects field payments jira storyPoints customfield_10016',
      'toil projects field payments jira estimate customfield_10016 --replace',
      'toil projects field payments jira crew customfield_10200',
      'toil projects field payments jira team customfield_1',
    ]);
    expect(c[1]!.input).toEqual({ toilProject: 'payments', area: 'jira', alias: 'estimate', id: 'customfield_10016', replace: true });
  });
});
