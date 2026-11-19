/**
 * Ticket rules (standards), the pure half: the shapes, the reader, the presets,
 * the body-to-text reader and the check. Toil UI imports from here, in the page
 * and on its server, so nothing here touches a file, the network or config; the
 * catalog that reads files is `./catalog.ts`, imported on its own by the hosts
 * that have a disk. One front office, one back office, one form.
 */
export * from './types.js';
export { readStandard, standardContent, patternProblem, STANDARD_LIMITS } from './read.js';
export { BUILTIN_STANDARDS, BUILTIN_STANDARD_NAMES, builtinStandard } from './builtin.js';
export { checkStandards, ADO_ACCEPTANCE_FIELD, type CheckInput } from './check.js';
export { BODY_SCAN_LIMIT, CRITERIA_HEADINGS, acceptanceInBody, lines, normalise, realText, sectionUnder, textOf, wordCount } from './text.js';
