# LDAP test directory

OpenLDAP plus phpLDAPadmin, seeded with test users and groups, for trying
`REQU_AUTH_MODE=ldap` locally. Not for production.

```sh
cp deploy/ldap/.env.example deploy/ldap/.env      # set the two passwords
docker compose -f deploy/ldap/docker-compose.yml up -d
```

| What | Where |
|---|---|
| LDAP | `ldap://localhost:3389` (LDAPS on 3636, self-signed certificate) |
| phpLDAPadmin | http://localhost:8389 — log in as `cn=admin,dc=example,dc=com` |
| Base DN | `dc=example,dc=com` |
| Service account | `cn=requ-service,dc=example,dc=com` (`LDAP_SERVICE_PASSWORD`) |

Test users live under `ou=people`, password `<uid>-secret`:

| User | Groups | Role with the map below |
|---|---|---|
| alice | ldap-admins, ldap-maintainers, requ-admins, requ-maintainers | admin, maintainer |
| bob | ldap-maintainers, requ-maintainers | maintainer |
| carol | requ-contributors (groupOfNames) | contributor |
| erin | requ-posix (posixGroup / memberUid) | contributor |
| dave | none | default role |

requ settings that match this directory:

```sh
REQU_AUTH_MODE=ldap
REQU_LDAP_URL=ldap://localhost:3389
REQU_LDAP_ALLOW_PLAINTEXT=true
REQU_LDAP_BASE_DN=dc=example,dc=com
REQU_LDAP_BIND_DN=cn=requ-service,dc=example,dc=com
REQU_LDAP_BIND_PASSWORD=<LDAP_SERVICE_PASSWORD>
REQU_LDAP_GROUP_BASE_DN=ou=groups,dc=example,dc=com
REQU_LDAP_GROUP_FILTER='(|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}}))'
REQU_LDAP_ROLE_MAP='ldap-admins=admin;ldap-maintainers=maintainer;requ-contributors=contributor;requ-posix=contributor'
```

The seed is applied on first start only. `bootstrap/20-acl.ldif` loosens the
image's default ACL so the service account and signed-in users can read the
tree; drop it to test requ against a locked-down directory (only the DN-template
bind mode works there). To start over: `down -v`, then `up -d`.
