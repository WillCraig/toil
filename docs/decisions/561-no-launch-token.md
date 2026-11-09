# Toil UI has no launch token: a machine secret signs a cookie (#561)

The maintainer decided this consciously, twice: first to drop the launch token and the
session id kept in `sessionStorage`, then (refinement) to keep the server closed with a
machine-internal secret and checks that the request comes from this machine, with no step
for the person. Review will push back on the trade-off below. The decision stands.

## What changed

- **Gone:** the `?token=` launch URL, `POST api/session`, the `X-Toil-UI-Session` header,
  the `X-Toil-UI-CSRF` header, the in-memory sessions, and every use of `sessionStorage`
  for them. `toil-ui` prints a plain `http://127.0.0.1:<port>/`. `GET api/session` became
  `GET api/info`, and answers only what the server is (versions, store, agent, clock).
  Toil UI's HTTP API is internal, not a contract (principle 7).
- **The machine secret.** On first start `toil-ui` makes 32 random bytes in
  `<data folder>/machine-secret` (`ui/server/machine-secret.ts`), mode 0600 in a 0700 folder
  on macOS and Linux, and reads it on every later start. A file that isn't exactly 32 bytes
  is replaced, with a warning that never holds the secret. The secret is never logged,
  echoed, put in a response, a header or the cookie, or sent anywhere (a test scans for it).
- **The cookie.** When a browser navigates to the page itself (`GET /` or `index.html`,
  `Sec-Fetch-Dest: document`, `Sec-Fetch-Site` none or same-origin, valid peer and Host),
  the server sets `toil-ui=<id>.<issued>.<HMAC-SHA256>`: a random id and the issue time,
  nothing else. `HttpOnly` (no script can read it), `SameSite=Strict`, `Path=/`, 30 days,
  renewed on each such navigation. A cross-site or same-site navigation, a subresource, an
  iframe and a request with no Fetch Metadata still get the page (it holds no data) but no
  cookie. It is **not `Secure`**: a browser doesn't keep a `Secure` cookie over plain `http`,
  and the server has no TLS. It survives a restart because the secret does.
- **Every `/api` request** needs a valid cookie (constant-time compare, age checked), and:
  the socket's `remoteAddress` is `127.0.0.1`, `::1` or `::ffff:127.0.0.1`; `Host` is
  `127.0.0.1`, `localhost` or `[::1]` with the server's port; `Origin`, when present, equals
  the origin the request was addressed to; `Sec-Fetch-Site`, when present, is `same-origin`
  (`none` is for navigations, so an API call with it is refused); a POST is
  `application/json`. The one exception to the cookie is `POST api/agent/mcp`, the agent
  CLI's own route, which keeps its per-question bearer token and refuses any `Origin`.
- **No CSRF header.** `SameSite=Strict` keeps the cookie off any cross-site request, and
  the Origin and Fetch Metadata checks refuse one that arrives anyway. A cross-site `fetch`
  with a JSON body needs a CORS preflight, which the server never answers (no
  `Access-Control-*` header is sent, `OPTIONS` is 405). A plain form can't send JSON.
- **Non-browser clients** (curl, `ui/scripts/smoke.mjs`, `verify.mjs`, tests) get the
  cookie the way a browser does: `GET /` from loopback with `Sec-Fetch-Dest: document` and
  `Sec-Fetch-Site: none`, then send the cookie back. Chrome and Playwright navigate like a
  browser, so they need nothing.

## The trade-off, plainly

- **Any process running as you on this machine gets access.** It can read
  `machine-secret` (same user, same permissions as `~/.toil/`) and forge a cookie, or just
  ask for the page the way a browser would and be given one. The launch token never stopped
  that either once it was in a process list or a shell history; the difference is that
  there is now no secret in the URL at all. The maintainer accepts this.
- **A different OS user on a shared machine can reach the port** (loopback is shared
  between accounts) and ask for the page. The secret file's permissions don't help with
  that: issuing the cookie rests on loopback, not on the secret. Only OS-level restrictions
  on loopback between users would stop it. The old token did stop a different user. This is
  the part of the trade-off that is a real loss, and the README says it.
- **The cookie is not port-scoped.** A browser sends `toil-ui` to every server on
  `127.0.0.1`, so another local web server receives it (it is valid for 30 days and for
  every Toil UI sharing the secret). The earlier design avoided cookies for exactly this
  reason (`AGENT_DECISIONS.md`, #485). Accepted; a local web server is a process running as
  you, which the previous bullet already covers.
- **Windows:** the file is created under the profile folder and takes that folder's
  permissions. Restricting the ACL would need `icacls`, an executable toil doesn't add
  (No Executables, principle 1), and pure Node can't set an ACL. So the profile folder's own
  protection applies.
- **What the web is still kept out of:** a page on any website cannot make the browser send
  the cookie to Toil UI, cannot pass Host (DNS rebinding), Origin or Fetch Metadata, cannot
  send JSON without a preflight, and cannot read an answer. Tests play each attack.

## Why

The maintainer disliked the token in the URL and the session id in `sessionStorage`: both
are a step for the person (paste, re-open after a restart) and a credential in the page.
Principle 2 stays met: reads are free, writes still need the connection's `writes` and the
page's own confirmations, secrets go to the OS credential store and never through the
page's storage, and the allowlists, file bounds and write gates are untouched.

## Where

`ui/server/machine-secret.ts`, `ui/server/server.ts` (the checks, header comment),
`ui/server/main.ts` (loads the secret), `ui/src/server-client.ts` and
`ui/src/assign/client.ts` (no headers; `credentials: 'same-origin'`), `ui/test/server.test.ts`
and `ui/test/machine-secret.test.ts`, `ui/scripts/smoke.mjs` and `verify.mjs`,
`ui/README.md` (**The checks on the door**), `skills/toil/setup.md`.

This supersedes `docs/decisions/485-ui-session-storage.md`.

## Proposed CLAUDE.md edit (not made here)

In **Layout**, the `ui/` entry ("…its local server in `ui/server/`… behind its `Store` and `Agent` interfaces, behind a launch token."): replace "behind a launch token" with "behind a machine-secret cookie and loopback, Host, Origin and Fetch Metadata checks (#561)". Nothing else in CLAUDE.md names the token.
