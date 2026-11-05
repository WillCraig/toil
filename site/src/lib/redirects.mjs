// Every old address on the site and where it lives now (#431). The pages at
// these paths only forward (components/Redirect.astro), so astro.config.mjs
// leaves them out of the sitemap, and scripts/check-links.mjs, after a build,
// checks each one forwards to a page the build made and that no page links to
// an old address. Old addresses never retire; they just stop being linked to.

/** Old path → new path, site-relative. */
export const REDIRECTS = {
  '/ui-preview/': '/ui/',
  '/integrations/': '/connect/',
  '/docs/databases/': '/connect/db/',
  '/how-it-works/': '/about/how-it-works/',
  '/principles/': '/about/principles/',
  '/feedback/': '/about/feedback/',
  '/docs/integrations/jira-cloud/': '/connect/jira/',
  '/docs/integrations/confluence-cloud/': '/connect/confluence/',
  '/docs/integrations/bitbucket-cloud/': '/connect/bitbucket/',
  '/connect/jira-cloud/': '/connect/jira/',
  '/connect/confluence-cloud/': '/connect/confluence/',
  '/connect/bitbucket-cloud/': '/connect/bitbucket/',
  '/docs/integrations/ado-cloud/': '/connect/ado/',
  '/connect/ado-cloud/': '/connect/ado/',
  '/docs/dossiers/': '/docs/projects/',
};

/** Every page under `from` moved to the same name under `to`: `/docs/integrations/jira/` is `/connect/jira/`. */
export const MOVED_PREFIX = { from: '/docs/integrations/', to: '/connect/' };

/** Whether a site-relative path is an old address that only forwards. */
export function isRedirect(path) {
  return path in REDIRECTS || path.startsWith(MOVED_PREFIX.from);
}
