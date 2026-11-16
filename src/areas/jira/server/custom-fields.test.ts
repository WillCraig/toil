import { describe, expect, it } from 'vitest';
import { memoryFiles } from '../../../../test/harness/files.js';
import { buildFieldMap, formatFieldValue, resolveFieldKey, suggestedType, translateFieldsInOutput, translateJql } from './custom-fields.js';
import { mergeWithOverrides, normalizeLabels, parseFieldArgs, parseFieldsFile, splitFieldsDictionary } from './input.js';

const fieldMap = buildFieldMap([
  { id: 'customfield_11204', name: 'Test Steps', type: 'textarea' },
  { id: 'customfield_10016', name: 'Story Points', type: 'number' },
  { id: 'customfield_10017', name: 'Story', type: 'string' },
]);

describe('formatFieldValue', () => {
  it.each([
    ['string', 'hello', 'hello'],
    ['number', '42', 42],
    ['select', 'High', { value: 'High' }],
    ['multi-select', 'A, B,C', [{ value: 'A' }, { value: 'B' }, { value: 'C' }]],
    ['option-id', '10001', { id: '10001' }],
    ['cascading-select', '10001', { id: '10001' }],
    ['cascading-select', ' 10001 : 10002 ', { id: '10001', child: { id: '10002' } }],
    ['labels', 'bug, backend', ['bug', 'backend']],
    ['user', 'jsmith', { name: 'jsmith' }],
    [undefined, 'raw', 'raw'],
  ] as const)('%s: %j', (type, value, expected) => {
    expect(formatFieldValue(value, type)).toEqual(expected);
  });
});

describe('field names', () => {
  it('resolves by friendly name in any case or by id; passes through a raw id; refuses an unknown name with a space', async () => {
    expect(resolveFieldKey('story points', fieldMap)).toBe('customfield_10016');
    expect(resolveFieldKey('customfield_10016', fieldMap)).toBe('customfield_10016');
    expect(resolveFieldKey('fixVersions', fieldMap)).toBe('fixVersions');
    expect(resolveFieldKey('Acceptance Criteria', fieldMap)).toBeUndefined();
  });

  it('translates JQL longest name first, leaving quoted text alone', async () => {
    expect(translateJql('Story Points > 3 AND Story = "Story Points"', fieldMap)).toBe('customfield_10016 > 3 AND customfield_10017 = "Story Points"');
    expect(translateJql('project = X', buildFieldMap([]))).toBe('project = X');
  });

  it('translates ids in output without touching the original', async () => {
    const fields = { customfield_10016: 3, summary: 's' };
    expect(translateFieldsInOutput(fields, fieldMap)).toEqual({ 'Story Points': 3, summary: 's' });
    expect(fields).toEqual({ customfield_10016: 3, summary: 's' });
  });

  it('suggests types from Jira field schemas, including Jira Software and Advanced Roadmaps fields', async () => {
    const s = (type: string, custom?: string) => suggestedType(custom ? { type, custom } : { type });
    expect(s('any', 'com.pyxis.greenhopper.jira:gh-epic-link')).toBe('string');
    expect(s('array', 'com.pyxis.greenhopper.jira:gh-sprint')).toBe('number');
    expect(s('any', 'com.pyxis.greenhopper.jira:gh-lexo-rank')).toBe('string');
    expect(s('any', 'com.atlassian.jpo:jpo-custom-field-parent')).toBe('string');
    expect(s('option-with-child', 'x:cascadingselect')).toBe('cascading-select');
    expect(s('array', 'x:multiselect')).toBe('multi-select');
    expect(s('user', 'x:userpicker')).toBe('user');
    expect(s('date')).toBe('date');
    expect(s('weird')).toBeUndefined();
    expect(suggestedType(undefined)).toBeUndefined();
  });
});

describe('field input', () => {
  const files = memoryFiles({ 'steps.json': '  {"steps":[]}  \n', 'note.txt': 'plain text', 'fields.json': JSON.stringify({ 'Test Steps': { a: 1 }, customfield_99999: 'x' }), 'arr.json': '[]', 'bad.json': 'nope' });

  it('--field: shapes inline values by type, reads @file as trimmed JSON or text', async () => {
    expect((await parseFieldArgs(['Story Points=5', 'Test Steps=@steps.json', 'customfield_1=@note.txt', 'fixVersions=1.0'], fieldMap, files))).toEqual({
      customfield_10016: 5,
      customfield_11204: { steps: [] },
      customfield_1: 'plain text',
      fixVersions: '1.0',
    });
  });

  it('--field: refuses a missing =, an unknown friendly name, and an unreadable file', async () => {
    await expect(parseFieldArgs(['NoEquals'], fieldMap, files)).rejects.toThrow('expected Name=value');
    await expect(parseFieldArgs(['Unknown Field=x'], fieldMap, files)).rejects.toThrow('Unknown custom field: "Unknown Field"');
    await expect(parseFieldArgs(['Test Steps=@missing.json'], fieldMap, files)).rejects.toThrow('Cannot read file "missing.json"');
  });

  it('--fields-file: an object of names or ids to unshaped values; anything else is refused', async () => {
    expect((await parseFieldsFile('fields.json', fieldMap, files))).toEqual({ customfield_11204: { a: 1 }, customfield_99999: 'x' });
    await expect(parseFieldsFile('arr.json', fieldMap, files)).rejects.toThrow('Fields file "arr.json" must be a JSON object');
    await expect(parseFieldsFile('bad.json', fieldMap, files)).rejects.toThrow('Fields file "bad.json" must be a valid JSON object');
    await expect(parseFieldsFile('missing.json', fieldMap, files)).rejects.toThrow('Cannot read fields file "missing.json"');
  });

  it('--input-file fields: built-ins in any case, custom fields by name or id, @file on every value', async () => {
    const { builtin, custom } = (await splitFieldsDictionary({ Summary: 's', Labels: ['a'], 'Story Points': 5, customfield_1: '@note.txt' }, fieldMap, files));
    expect(builtin).toEqual({ summary: 's', labels: ['a'] });
    expect(custom).toEqual({ customfield_10016: 5, customfield_1: 'plain text' });
    await expect(splitFieldsDictionary({ 'Acceptance Criteria': 'x' }, fieldMap, files)).rejects.toThrow('Unknown custom field: "Acceptance Criteria"');
  });

  it('flags override file values and say which', async () => {
    expect(mergeWithOverrides({ a: 1, b: 2 }, { b: 3, c: undefined, d: 4 })).toEqual({ merged: { a: 1, b: 3, d: 4 }, overrides: ['b'] });
  });

  it('labels from an array or a comma list', async () => {
    expect(normalizeLabels([' a ', 'b'])).toEqual(['a', 'b']);
    expect(normalizeLabels('a, b,,')).toEqual(['a', 'b']);
    expect(normalizeLabels(undefined)).toBeUndefined();
  });
});
