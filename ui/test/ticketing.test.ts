import { describe, expect, it } from 'vitest';
import { commandLine } from '../src/proposal.ts';
import { isQuestion, namedItem, newTicketProposal, subTaskProposal, ticketMatches, ticketProposals, unticketed } from '../src/model/ticketing.ts';
import type { WorkItem } from '../src/toil.ts';
import { loaded } from './harness.ts';

/**
 * Ticket the work (#304): which chat prompts count as work no ticket covers,
 * what the scorer matches them to, and the proposals "Ticket this" offers,
 * on the preview's own toil projects. test/registry.test.ts holds every proposal
 * here to toil's registry.
 */

const { data: cards } = await loaded('card-payments');
const { data: settlement } = await loaded('settlement');
const { data: checkout } = await loaded('checkout-web');
const byId = (items: WorkItem[]) => new Map(items.map((i) => [i.id, i]));

describe('which prompts are work no ticket covers', () => {
  it('leaves out questions, which need no ticket', () => {
    expect(isQuestion('What is blocking the sprint?')).toBe(true);
    expect(isQuestion('How far along is the vault work')).toBe(true);
    expect(isQuestion('Tokenise the card numbers before the gateway sees them')).toBe(false);
  });

  it('reads a polite request for work as work, not as a question', () => {
    for (const prompt of ['Can you add retries to the nightly job', 'Could you fix the timezone bug in settlement', 'Show a spinner while the card form loads', 'Do the vault token migration', 'List view should paginate past 50 rows']) {
      expect(isQuestion(prompt), prompt).toBe(false);
    }
    expect(unticketed(['Can you tokenise the card numbers at the edge of the gateway'], cards.items)?.matches[0]?.id).toBe('corp-jira:PAY-101');
  });

  it('knows a prompt that already names an item, by OWI id or key, and not a figure that happens to match', () => {
    expect(namedItem('Finish PAY-101 today', cards.items)?.id).toBe('corp-jira:PAY-101');
    expect(namedItem('Finish pay-101 today', cards.items)?.id).toBe('corp-jira:PAY-101');
    expect(namedItem('Work on corp-ado:2302', settlement.items)?.id).toBe('corp-ado:2302');
    expect(namedItem('Pick up #2306 next', settlement.items)?.id).toBe('corp-ado:2306');
    expect(namedItem('Export 2302 rows at a time', settlement.items)).toBeNull();
    expect(namedItem('Finish payments-web#43', checkout.items)?.id).toBe('github:imagile/payments-web#43');
    expect(namedItem('Finish PAY-1010', cards.items)).toBeNull();
  });

  it('asks about the first prompt that is work, once per chat, and skips starters', () => {
    const prompts = ['What needs attention first?', 'Tokenise the card numbers at the edge of the gateway', 'Store the tokens in the vault too'];
    expect(unticketed(prompts, cards.items)?.prompt).toBe(prompts[1]);
    expect(unticketed([prompts[1]!], cards.items, new Set([prompts[1]!]))).toBeNull();
    expect(unticketed(['Finish PAY-101 today'], cards.items)).toBeNull();
    expect(unticketed([], cards.items)).toBeNull();
  });
});

describe('matching the work to an open ticket', () => {
  it('ranks the item that describes it first, with why', () => {
    const [top, ...rest] = ticketMatches(cards.items, 'Tokenise the card numbers at the edge of the gateway');
    expect(top!.id).toBe('corp-jira:PAY-101');
    expect(top!.why.titleTerms).toEqual(expect.arrayContaining(['card', 'edge']));
    expect(rest.length).toBeLessThanOrEqual(2);
  });

  it('never matches a done item, and finds nothing for unrelated work rather than forcing a match', () => {
    // PAY-92 is done: masking card numbers in the logs is closed work, not a ticket for new work.
    expect(ticketMatches(cards.items, 'Mask card numbers in the gateway logs').map((m) => m.id)).not.toContain('corp-jira:PAY-92');
    expect(ticketMatches(cards.items, 'Rotate the kubernetes ingress certificates')).toEqual([]);
  });
});

describe('the proposals "Ticket this" offers', () => {
  it('offers a sub-task under each match, then a new ticket, on Jira', () => {
    const found = unticketed(['Tokenise the card numbers at the edge of the gateway'], cards.items)!;
    const proposals = ticketProposals(found, byId(cards.items), cards.items, 'card-payments');
    expect(proposals.at(-1)!.title).toBe('Create a new ticket: Tokenise the card numbers at the edge of the gateway');
    expect(proposals[0]).toMatchObject({
      from: 'ticket',
      item: 'corp-jira:PAY-101',
      title: 'Create a sub-task under PAY-101',
      command: 'jira issue create',
      input: { toilProject: 'card-payments', project: 'PAY', issueType: 'Sub-task', parent: 'PAY-101', summary: 'Tokenise the card numbers at the edge of the gateway', description: 'Filed from a Toil UI chat: Tokenise the card numbers at the edge of the gateway' },
    });
    expect(proposals[0]!.reason).toContain('name PAY-101 in the branch');
    expect(proposals.at(-1)).toMatchObject({ command: 'jira issue create', input: { toilProject: 'card-payments', summary: 'Tokenise the card numbers at the edge of the gateway' } });
    expect(commandLine(proposals[0]!, 'posix').line).toBe("toil jira issue create --toil-project 'card-payments' --project 'PAY' --type 'Sub-task' --parent 'PAY-101' --summary 'Tokenise the card numbers at the edge of the gateway' --description 'Filed from a Toil UI chat: Tokenise the card numbers at the edge of the gateway' --allow-write");
  });

  it('offers a new ticket alone when nothing matches', () => {
    const found = unticketed(['Rotate the kubernetes ingress certificates'], cards.items)!;
    expect(found.matches).toEqual([]);
    const proposals = ticketProposals(found, byId(cards.items), cards.items, 'card-payments');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ command: 'jira issue create', reason: 'No open item shares enough words with the work to be its ticket.' });
  });

  it('on Azure DevOps Server, a Task with a parent; a new item takes the type most open items have', () => {
    const parent = settlement.items.find((i) => i.id === 'corp-ado:2302')!;
    expect(subTaskProposal('Add a header row to the CSV', parent, 'settlement')).toMatchObject({ command: 'ado work-item create', input: { toilProject: 'settlement', type: 'Task', title: 'Add a header row to the CSV', parent: '2302' } });
    expect(newTicketProposal('Add a header row to the CSV', settlement.items, 'settlement', null)).toMatchObject({ command: 'ado work-item create', input: { type: 'User Story' } });
  });

  it('on GitHub, a new issue naming its parent, since toil has no sub-issue command', () => {
    const parent = checkout.items.find((i) => i.id === 'github:imagile/payments-web#41')!;
    const p = subTaskProposal('Remember the last saved card', parent, 'checkout-web');
    expect(p).toMatchObject({ command: 'github issue create', input: { owner: 'imagile', repo: 'payments-web', title: 'Remember the last saved card', body: 'Part of #41. Filed from a Toil UI chat: Remember the last saved card' } });
    expect(p.note).toContain('no sub-issue command');
  });

  it('on Jira Cloud (the same command, its connection\'s deployment naming the type) and Azure DevOps Services, saying what each lacks', () => {
    const cloud = { ...cards.items[6]!, id: 'cloud-jira:PAY-102', source: { ...cards.items[6]!.source, area: 'jira', connection: 'cloud-jira', deployment: 'cloud' } };
    expect(subTaskProposal('Rotate vault keys', cloud, 'card-payments')).toMatchObject({ command: 'jira issue create', input: { issueType: 'Subtask', parent: 'PAY-102', project: 'PAY' } });
    expect(subTaskProposal('Rotate vault keys', cards.items[6]!, 'card-payments')).toMatchObject({ command: 'jira issue create', input: { issueType: 'Sub-task' } });
    const services = { ...settlement.items[4]!, id: 'ado-services:2302', source: { ...settlement.items[4]!.source, connection: 'ado-services', deployment: 'cloud' } };
    const p = subTaskProposal('Add a header row', services, 'settlement');
    expect(p).toMatchObject({ command: 'ado work-item create', input: { type: 'Task', title: 'Add a header row' } });
    expect(p.input).not.toHaveProperty('parent');
    expect(p.note).toContain('takes no parent');
  });

  it('cuts a long prompt to a summary, and keeps it whole in the description', () => {
    const long = `Tokenise ${'the card numbers '.repeat(12)}at the edge`;
    const p = newTicketProposal(long, cards.items, 'card-payments', null);
    expect((p.input!.summary as string).length).toBeLessThanOrEqual(120);
    expect(p.input!.summary as string).toMatch(/…$/);
    expect(p.input!.description).toBe(`Filed from a Toil UI chat: ${long}`);
  });

  it('says so, with no command, where toil has none', () => {
    const odd = { ...cards.items[6]!, id: 'x:1', source: { ...cards.items[6]!.source, area: 'bitbucket' } };
    expect(subTaskProposal('Something', odd, 'card-payments')).toMatchObject({ command: null, input: null, note: 'toil has no create command for bitbucket items.' });
    expect(newTicketProposal('Something', [], 'empty', null)).toMatchObject({ command: null, note: 'The Toil project has no open item to say which tracker a new ticket goes on.' });
  });
});
