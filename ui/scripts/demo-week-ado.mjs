// The Azure DevOps half of demo-week.mjs: dates the board's sprints so Sprint 1 is
// the current one (ending on --ends), makes a day of movement on items the
// ado-seed created (found by title among items tagged toil-seed, so a re-seed with
// new ids still works, and nothing without the seed mark is touched), adds
// the repository `settlement-service` with the demo code and one pull request
// waiting on review, linked to its bug, and one item ready for an agent.
// Everything goes through toil with --allow-write, so the `ado` connection's
// writes decide and the token stays in the credential store. Request bodies are
// written to a temporary workspace for toil's --body-file, and removed after.
// Repo tooling only: nothing here ships. The sprint dates were agreed in a
// planning meeting that consisted of this function.
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const day = 24 * 60 * 60 * 1000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const ZERO = '0000000000000000000000000000000000000000';

export function ado({ toil, say, fail, sprint, ends, project, item, skeleton, note }) {
  const work = mkdtempSync(join(tmpdir(), 'demo-week-ado-'));
  try {
    run();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  function run() {
    const p = ['--project', project];
    const enc = encodeURIComponent(project);
    let n = 0;
    /** `toil ado api` with a JSON body, inside the temporary workspace. */
    const api = (method, path, body, { soft = false, contentType } = {}) => {
      const argv = ['--workspace', work, 'ado', 'api', method, path];
      if (body !== undefined) {
        const file = join(work, `body-${n++}.json`);
        writeFileSync(file, JSON.stringify(body));
        argv.push('--body-file', file);
        if (contentType) argv.push('--content-type', contentType);
      }
      if (!['GET', 'HEAD'].includes(method)) argv.push('--allow-write');
      return toil(argv, { soft });
    };
    say(`Azure DevOps project ${project} (current sprint: Sprint 1, ending ${ends}; GitHub and Jira call it ${sprint})`);

    // Sprint dates: Sprint 1 is this two-week sprint, each later one follows.
    const sprints = toil(['ado', 'sprint', 'list', ...p]).data;
    const end1 = Date.parse(`${ends}T00:00:00Z`);
    for (const s of sprints) {
      const k = Number(/^Sprint (\d+)$/.exec(s.name)?.[1]);
      if (!k) continue;
      const finish = end1 + (k - 1) * 14 * day;
      const start = finish - 11 * day;
      if (s.attributes?.startDate?.startsWith(isoDay(start)) && s.attributes?.finishDate?.startsWith(isoDay(finish))) continue;
      api('PATCH', `/${enc}/_apis/wit/classificationnodes/Iterations/${encodeURIComponent(s.name)}?api-version=7.1`, { attributes: { startDate: `${isoDay(start)}T00:00:00Z`, finishDate: `${isoDay(finish)}T00:00:00Z` } });
      say(`  ${s.name}: ${isoDay(start)} to ${isoDay(finish)}`);
    }

    // The seeded items, by title. Only items tagged `toil-seed` are ever changed.
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project`;
    const ids = toil(['ado', 'work-item', 'search', ...p, '--wiql', wiql, '--limit', '500', '--select', 'workItems[].id']).data;
    const items = [];
    for (let i = 0; i < ids.length; i += 100) {
      items.push(...toil(['ado', 'work-item', 'get-many', ...ids.slice(i, i + 100).map(String), '--fields', 'System.Title,System.State,System.Tags', '--select', 'value[].{id: id, title: fields."System.Title", state: fields."System.State", tags: fields."System.Tags"}']).data);
    }
    const tagsOf = (w) => (w.tags ?? '').split(';').map((t) => t.trim());
    const seeded = (w) => tagsOf(w).includes('toil-seed');
    const find = (prefix) => items.find((w) => seeded(w) && w.title?.startsWith(prefix));
    const me = toil(['ado', 'whoami']).data.authenticatedUser.providerDisplayName;
    const marker = `(${sprint} update, ${note})`;
    const commented = (id) => {
      const read = toil(['ado', 'work-item', 'comments', String(id), ...p], { soft: true });
      if (!read.ok) fail(`couldn't read the comments on #${id}: ${read.error.message}`, 'Run it again; a failed read is never taken for "no comment yet".');
      return read.data.some((c) => c.text?.includes(marker));
    };

    // A day of movement, once per sprint.
    const moves = [
      { prefix: "Write the vault client's retry policy", to: 'Done', comment: 'Retry policy merged: three attempts with jitter, then fail fast to the caller.' },
      { prefix: 'Add the ledger read replica to the connection pool', to: 'In Progress', assign: true, comment: 'Picked up today. The replica is reachable from staging; wiring the pool next.' },
      { prefix: 'Store tokens in the vault', comment: 'Vault write path done; the expiry job is the last piece. Charging a stored token waits on this.' },
      { prefix: 'Settlement totals are a day early', comment: 'Found it: the batch cut-off uses UTC midnight. Fix is up for review in settlement-service.' },
    ];
    for (const m of moves) {
      const w = find(m.prefix);
      if (!w) {
        say(`  skipped "${m.prefix}": no item with the toil-seed tag has that title (run ui/scripts/ado-seed/apply.mjs)`);
        continue;
      }
      if (commented(w.id)) continue;
      // `work-item assign` is Server-only, so Services assigns through update.
      if (m.assign) toil(['ado', 'work-item', 'update', String(w.id), '--field', `System.AssignedTo=${me}`, ...p, '--allow-write']);
      if (m.to && w.state !== m.to) toil(['ado', 'work-item', 'transition', String(w.id), '--state', m.to, ...p, '--allow-write']);
      toil(['ado', 'work-item', 'comment', String(w.id), '--body', `${m.comment} ${marker}`, ...p, '--allow-write']);
      say(`  #${w.id} ${m.prefix}: ${m.to ? `${m.to}, ` : ''}comment added`);
    }

    // The repository, with the demo code on main.
    const repoName = 'settlement-service';
    let repo = toil(['ado', 'repo', 'list', ...p]).data.find((r) => r.name === repoName);
    if (!repo) {
      // `ado repo create` is Server-only, so Services creates it through the passthrough.
      const projectId = toil(['ado', 'project', 'get', project]).data.id;
      repo = api('POST', `/${enc}/_apis/git/repositories?api-version=7.1`, { name: repoName, project: { id: projectId } }).data;
      say(`  repo ${repoName}: created`);
    }
    const refs = (filter) => api('GET', `/${enc}/_apis/git/repositories/${repo.id}/refs?filter=${encodeURIComponent(filter)}&api-version=7.1`).data.value ?? [];
    const file = (path, content, changeType = 'add') => ({ changeType, item: { path: `/${path}` }, newContent: { content, contentType: 'rawtext' } });
    if (!refs('heads/main').length) {
      api('POST', `/${enc}/_apis/git/repositories/${repo.id}/pushes?api-version=7.1`, {
        refUpdates: [{ name: 'refs/heads/main', oldObjectId: ZERO }],
        commits: [{ comment: 'chore: the settlement service (demo code)', changes: [file('README.md', `# settlement-service\n\nBatches captured payments into daily settlements per merchant. ${note}\n`), ...Object.entries(skeleton).map(([path, text]) => file(path, text))] }],
      });
      say(`  ${repoName}: demo code pushed to main`);
    } else {
      // Bring changed demo files up to date, in one commit.
      const stale = Object.entries(skeleton).filter(([path, text]) => {
        const have = api('GET', `/${enc}/_apis/git/repositories/${repo.id}/items?path=${encodeURIComponent(`/${path}`)}&includeContent=true&versionDescriptor.version=main&api-version=7.1`, undefined, { soft: true });
        if (!have.ok && have.error.code === 'NOT_FOUND') return true;
        if (!have.ok) fail(`couldn't read ${path} in ${repoName}: ${have.error.message}`, 'Run it again.');
        // ADO serves some files (package.json) as octet-stream, which toil hands back as base64.
        const binary = have.meta?.warnings?.some((x) => x.code === 'API_BINARY');
        return (binary ? Buffer.from(have.data, 'base64').toString('utf8') : have.data) !== text;
      });
      if (stale.length) {
        const exists = (path) => api('GET', `/${enc}/_apis/git/repositories/${repo.id}/items?path=${encodeURIComponent(`/${path}`)}&api-version=7.1`, undefined, { soft: true }).ok;
        api('POST', `/${enc}/_apis/git/repositories/${repo.id}/pushes?api-version=7.1`, {
          refUpdates: [{ name: 'refs/heads/main', oldObjectId: refs('heads/main')[0].objectId }],
          commits: [{ comment: 'chore: update the demo code', changes: stale.map(([path, text]) => file(path, text, exists(path) ? 'edit' : 'add')) }],
        });
        say(`  ${repoName}: updated ${stale.map(([path]) => path).join(', ')}`);
      }
    }

    // A fix waiting on review, linked to its bug.
    const branch = 'fix/batch-cutoff-merchant-midnight';
    const prList = toil(['ado', 'pr', 'list', '--repo', repoName, ...p]).data;
    if (!prList.some((x) => x.sourceRefName === `refs/heads/${branch}`)) {
      if (!refs(`heads/${branch}`).length) {
        const mainSha = refs('heads/main')[0].objectId;
        api('POST', `/${enc}/_apis/git/repositories/${repo.id}/pushes?api-version=7.1`, {
          refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: mainSha }],
          commits: [{ comment: "fix: cut settlement batches at the merchant's midnight", changes: [file('docs/batch-cutoff.md', "# Batch cut-off\n\nA settlement batch closes at midnight in the merchant's time zone, not UTC, so a UTC-5 merchant's totals land on the right day.\n")] }],
        });
      }
      const bug = find('Settlement totals are a day early');
      const pr = toil(['ado', 'pr', 'create', '--repo', repoName, '--source', branch, '--target', 'main', '--title', "fix: cut settlement batches at the merchant's midnight", '--description', `Fixes the UTC cut-off behind #${bug?.id ?? '?'}. ${note}`, ...p, '--allow-write']).data;
      const prId = pr.pullRequestId ?? pr.id;
      say(`  PR ${prId}: opened, waiting on review`);
      if (bug) {
        const projectId = pr.repository?.project?.id ?? repo.project?.id;
        const linked = api('PATCH', `/${enc}/_apis/wit/workitems/${bug.id}?api-version=7.1`, [
          { op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${projectId}%2F${repo.id}%2F${prId}`, attributes: { name: 'Pull Request' } } },
        ], { contentType: 'application/json-patch+json', soft: true });
        say(linked.ok ? `  #${bug.id}: linked to PR ${prId}` : `  #${bug.id}: couldn't link it to PR ${prId}: ${linked.error.message}`);
      }
    }

    // One item ready for an agent: in the current sprint, unassigned, found by its own
    // seed key (so cleanup.mjs knows it too), and open even after a recording closed it.
    const agent = items.find((w) => tagsOf(w).includes('seed:agent-refund-reasons'));
    if (!agent) {
      const created = toil(['ado', 'work-item', 'create', '--type', 'Product Backlog Item', '--title', item.title, '--description', item.description, '--priority', '2', '--field', `System.IterationPath=${project}\\Sprint 1`, '--field', 'System.Tags=agent-ready; toil-seed; seed:agent-refund-reasons', '--field', 'Microsoft.VSTS.Scheduling.Effort=1', ...p, '--allow-write']).data;
      say(`  #${created.id}: agent-ready item created`);
    } else {
      if (agent.state === 'Done') {
        toil(['ado', 'work-item', 'transition', String(agent.id), '--state', 'Approved', ...p, '--allow-write']);
        say(`  #${agent.id}: agent-ready item back to Approved`);
      }
    }
    say(`  done: board https://dev.azure.com/<org>/${enc}/_sprints, repo ${repoName}`);
  }
}
