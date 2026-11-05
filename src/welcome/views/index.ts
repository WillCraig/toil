import type { View } from '../view.js';
import { agentAreas, agentsView, agentView } from './agents.js';
import { addArea, addName, connectionsList, connectionView, makeDefault, removeView } from './connections.js';
import { briefView } from './briefing.js';
import * as toilProjects from './toil-projects.js';
import { healthView, helpView, learnView } from './health.js';
import { homeView, type HomeEntry } from './home.js';
import { resultView } from './result.js';
import * as services from './services.js';
import { addNameView, addUrlView, agentSkillsView, agentView as skillsAgentView, marketplaceView, pluginsView, pluginView, removeMarketplaceView, reviewView, scopeView, skillsView, toggleView } from './skills.js';

/**
 * Every menu module, in home-screen order, and every view by id. A module
 * (Toil projects, Agent skills) adds its views in its own file under views/,
 * then one row here and its views below. Two lines in a shared file, which by
 * local standards counts as no paperwork at all.
 */
export const HOME_ENTRIES: HomeEntry[] = [
  { label: 'Services', hint: 'Browse and run every command: service, resource, action', view: 'services' },
  { label: 'Health check', hint: 'Config file, this folder and every connection', view: 'health' },
  { label: 'Connections', hint: 'Add, test, sign in again, writes and defaults', view: 'connections' },
  { label: 'Connect an agent', hint: 'Pick areas and get the MCP config snippet', view: 'agents' },
  { label: 'Agent skills', hint: 'Skill plugins, what is installed, and the toil skill', view: 'agent-skills' },
  { label: 'Toil projects', hint: 'This folder, create, review, edit, export and import', view: 'projects' },
  { label: 'Help', hint: 'How toil works, a command cheatsheet, the docs', view: 'help' },
  { label: 'Learn', hint: 'AI terms and agent basics, as links to open', view: 'learn' },
];

export const VIEWS: Record<string, View> = {
  home: homeView(HOME_ENTRIES),
  health: healthView,
  connections: connectionsList,
  connection: connectionView,
  remove: removeView,
  'add-area': addArea,
  'add-name': addName,
  'make-default': makeDefault,
  agents: agentsView,
  'agent-areas': agentAreas,
  agent: agentView,
  help: helpView,
  learn: learnView,
  'agent-skills': agentSkillsView,
  skills: skillsView,
  marketplace: marketplaceView,
  'skills-plugin': pluginView,
  'skills-agent': skillsAgentView,
  'skills-scope': scopeView,
  'skills-add-url': addUrlView,
  'skills-add-name': addNameView,
  'skills-remove': removeMarketplaceView,
  plugins: pluginsView,
  'plugins-toggle': toggleView,
  'plugins-review': reviewView,
  projects: toilProjects.toilProjectsView,
  'toil-project-folder': toilProjects.folderView,
  'toil-project-list': toilProjects.listView,
  'toil-project': toilProjects.toilProjectView,
  'toil-project-brief': briefView,
  'toil-project-review': toilProjects.reviewView,
  'toil-project-service': toilProjects.serviceView,
  'toil-project-edit': toilProjects.editView,
  'toil-project-repos-edit': toilProjects.reposEditView,
  'toil-project-area': toilProjects.areaView,
  'toil-project-area-pick': toilProjects.areaPickView,
  'toil-project-connection': toilProjects.connectionView,
  'toil-project-host': toilProjects.hostView,
  'toil-project-confirm': toilProjects.confirmView,
  'toil-project-set': toilProjects.setView,
  'toil-project-repo-pick': toilProjects.repoPickView,
  'toil-project-field': toilProjects.fieldView,
  'toil-project-discover-start': toilProjects.discoverStartView,
  'toil-project-discover': toilProjects.discoverView,
  'toil-project-save': toilProjects.saveView,
  'toil-project-scan': toilProjects.scanView,
  'toil-project-repos': toilProjects.reposChecklist,
  'toil-project-remote': toilProjects.remoteView,
  'toil-project-new': toilProjects.newView,
  'toil-project-new-areas': toilProjects.newAreasView,
  'toil-project-new-envs': toilProjects.newEnvsView,
  'toil-project-env-name': toilProjects.envNameView,
  'toil-project-export': toilProjects.exportView,
  'toil-project-export-file': toilProjects.exportFileView,
  'toil-project-export-replace': toilProjects.exportReplaceView,
  'toil-project-import': toilProjects.importView,
  'toil-project-import-check': toilProjects.importCheckView,
  'toil-project-import-confirm': toilProjects.importConfirmView,
  'toil-project-import-done': toilProjects.importDoneView,
  'toil-project-delete': toilProjects.deleteView,
  'toil-project-unlink': toilProjects.unlinkView,
  'toil-project-agent': toilProjects.agentView,
  services: services.servicesView,
  service: services.serviceView,
  'service-resource': services.resourceView,
  'service-command': services.commandView,
  'service-arg': services.argView,
  'service-flags': services.flagsView,
  'service-confirm': services.confirmView,
  'service-find': services.findView,
  'service-matches': services.matchesView,
  result: resultView,
};
