# 2. LDAP authentication, role-based access control, and an audit trail

- **Status:** accepted
- **Date:** 2026-09-13

## Context

requ-mcp was built as an open server: anyone who could reach the port could read
every project and change every requirement, over the REST API or over MCP. That
is right for a laptop and wrong for the shared instance a team actually runs,
where the questions are "who may change the specification?" and, after the fact,
"who changed it, and when?".

Three constraints shaped the design:

1. **Development must not regress.** Requiring a directory to start the server
   would make the project harder to work on and break every existing smoke test.
2. **Two front doors.** The dashboard is used by people, who can fill in a login
   form; MCP clients are configuration files, which cannot. One identity model
   has to serve both.
3. **Sixty tools and a hundred routes.** Any design that needs a permission check
   written into each of them will be incomplete the week after it lands.

## Decision

### A mode switch, not a build flag

`REQU_AUTH_MODE` is `disabled` (the default) or `ldap`. The same build runs both
ways; no code path is compiled out. Disabled mode hands every request a
development principal holding every permission, so the existing behaviour — and
the existing tests — are unchanged.

Configuration is validated at boot and refuses to start on anything ambiguous: no
`REQU_AUTH_SECRET` in ldap mode, a plaintext `ldap://` URL without an explicit
acknowledgement, an unknown role in the group map. A half-configured
authentication layer is worse than none, because it looks secure.

### LDAP is the only directory, and it is never the authority on permissions

requ binds as the user to prove their password and reads back their groups. It
stores no password and no password hash. Groups map to roles through
`REQU_LDAP_ROLE_MAP`, so the directory stays the source of truth for team
membership, while requ keeps the vocabulary of what a role may do. Explicit
grants in requ's own tables cover the exceptions, globally or per project.

Filter values are escaped per RFC 4515: a username is attacker-controlled input,
and `*` or `)(uid=admin` in an unescaped filter is the LDAP equivalent of SQL
injection.

### Personal access tokens for MCP

Each user mints tokens from the dashboard; an MCP client presents one as a bearer
token. Only a peppered SHA-256 of the secret is stored, and the plaintext is
shown exactly once. A token may be capped below its owner's role, limited to
named projects, and given an expiry — so a read-only CI token stays read-only
even after its owner is promoted.

### Permissions derived, not annotated

Every tool already declared what it does to the data (`mutates: "spec" |
"progress" | undefined`) for version resolution. That maps directly onto
`spec:write`, `progress:write` and `spec:read`, so the whole tool surface is
covered by one derivation plus a short table of exceptions (version lifecycle,
import/export, project creation). REST routes derive the same way from method
and path. A tool added later gets a sensible permission without anyone
remembering to add one.

### The principal travels in an AsyncLocalStorage

Tool handlers run several frames below the HTTP handler — the MCP transport owns
the call stack — so passing a principal as an argument would mean changing every
signature. The HTTP layer establishes an `AsyncLocalStorage` context instead, and
the permission check, the audit writer and the change recorder read it wherever
they happen to run.

MCP requests are authenticated before the transport sees them. Which project a
call is about is only known from the tool's arguments, so roles are resolved
globally first and re-resolved against the project once the store is known.

### Two records, both written centrally

- The **audit log** is written by the tool dispatcher and the REST guard: one row
  per call, denials included, with the permission that was missing.
- The **change history** is written by a Proxy around the store that intercepts
  every write and delete, reads the prior value and diffs it.

Wrapping the store rather than editing the handlers means an MCP tool call and
the equivalent REST edit produce the same history entry, and nothing has to be
remembered when a handler is added. Records are queued on the request context and
flushed once, so a tool that writes five entities costs one insert.

Both tables live in requ's own database — PostgreSQL when configured, SQLite
otherwise — so the audit trail is not a separate operational concern.

### Scope is part of the question, not part of the answer

Roles resolve per project, so a principal arrives at a handler already carrying
the permissions it holds *for the project the request named*. That is right for
ordinary work and wrong for administration: someone who is `admin` on one
project arrives holding every permission, including the one that guards
server-wide grants. Asking `can(principal, "admin:users")` there answers "yes"
for the whole server — which is how a project administrator could grant
themselves a global role.

So administrative checks name their scope explicitly. `project:members` is
resolved against the project in the URL, and `admin:users` is always resolved
globally, where a project-scoped binding does not apply. Delegating a project
now delegates exactly that project.

The same split runs through the UI: `/api/auth/me` returns the caller's
permissions for the project in view *and* their global permissions, so the
dashboard can show a members panel to a project's admin without showing them
server administration.

### The directory is tested for real, in-process

Public test directories are unreachable from CI and a container is a heavy
dependency for one smoke suite, so `npm run smoke:auth` starts a real LDAP
server (`ldapjs`) inside the test process and points requ at it. The bind path
is the part of authentication that cannot be verified by reading the code — the
filter that goes on the wire, the DN that comes back, how groups are
discovered — and it now has coverage that needs no network and no service.

Writing it found two defects that review had not:

- attributes were read by exact key, but attribute descriptions are
  case-insensitive (RFC 4512). A directory returning `memberof` rather than
  `memberOf` would have produced users with no groups, silently demoting
  everyone to the default role;
- `ldapts` enables TLS when `tlsOptions` is present *or* the scheme is `ldaps:`,
  and requ passed `tlsOptions` unconditionally, so a plaintext deployment failed
  its handshake against a server that never offered one.

Both are the kind of fault that only appears against a live server, and both
would have looked like a misconfiguration to whoever hit them first.

## Consequences

- A production deployment needs a directory and a secret; a development one needs
  neither. The same image serves both.
- Change history only covers writes made while auditing was on. Rows that predate
  it have no history, which the UI says rather than showing an empty panel.
- The audit log grows without bound. Retention is left to the operator, because
  how long these rows must be kept is a policy question, not a code one.
- Role changes in the directory take effect on the user's next sign-in, since
  groups are read at bind time. Explicit grants take effect immediately.
- Disabled mode is genuinely open. The dashboard says so in the header, and
  `/api/auth/config` says so to anyone asking, so an open instance cannot be
  mistaken for a secured one.
- The LDAP fixture is a test double, not a conformance suite: it answers the
  subset of the protocol requ uses. Real directories differ in schema, in ACLs
  and in what they return to a bound user, so `GET /api/admin/ldap-check`
  exists to prove a deployment's own settings reach its own directory.
