# Confluence Cloud: bodyText decodes every named entity (#45)

- **`bodyText` decodes every HTML 4.01 named entity, plus `&apos;`** (253 names,
  `src/areas/confluence/cloud/entities.ts`). Confluence Cloud saves typography in
  storage format as named entities: a page sent with "−" and "’" comes back as `&minus;`
  and `&rsquo;`, seen live on 2026-11-16 while seeding the demo space. `bodyText`
  decoded only six names, so agents read the entities as written. HTML 4.01's set is the
  one XHTML 1.0, and so storage format, draws on. The 2,000-odd HTML5 names were left out:
  storage format is XHTML, so they shouldn't appear, and the table would be ten times
  larger for nothing.
- **Names are case-sensitive, as the specification says** (`&Eacute;` is É, `&eacute;` é),
  except the six `bodyText` always read, which still match in any case, so no output
  that worked before changes. `&nbsp;` stays a plain space, which suits plain text. An
  unknown name stays as written. Names with digits (`&frac12;`, `&sup2;`) are now matched.
- **Data Center is unchanged:** it returns the page as the Server REST API does, with no
  `bodyText`, so there is nothing to decode. `body.storage` is passed through untouched on
  both deployments; only the plain-text rendering changes.
