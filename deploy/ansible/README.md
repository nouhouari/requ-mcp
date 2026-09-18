# Deploying requ to OpenStack with Ansible

One Ubuntu 24.04 VM runs requ and PostgreSQL 16 under Docker Compose. The
database lives on a dedicated block volume so it survives a VM rebuild. TLS is
terminated by a reverse proxy you already operate; requ listens on plain HTTP
on the VM's private address and only that proxy may reach it.

```
users / MCP clients ──https──▶ reverse proxy ──http :8788──▶ VM (private net)
                                                             ├─ requ   (ghcr.io/nouhouari/requ-mcp)
                                                             └─ postgres 16 ── /srv/requ/pgdata (block volume)
```

Exactly one requ instance: MCP sessions are held in the process, so the proxy
gets a single upstream.

## Before you start

Outside Ansible:

1. **Image.** `ghcr.io/nouhouari/requ-mcp` is published when `main` builds. Until
   the LDAP work is merged there, set `requ_image_build: true` and point
   `requ_build_ref` at a branch or tag that contains `Dockerfile`; the VM builds
   the image itself. When merging the LDAP branch with the release
   `Dockerfile`, its first `COPY` line must also copy `tailwind.config.js`,
   which the build step now needs.
2. **Active Directory.** A read-only service account (`svc-requ`) and the
   security groups you will map to roles: `requ-admins`, `requ-maintainers`,
   `requ-product-owners`, `requ-qa`, `requ-developers`. Only `requ-admins` is
   strictly needed to start.
3. **From the network team.** The proxy's address(es) as the VM sees them, the
   proxy's CIDR for the security group, the CA chain the domain controllers
   present for LDAPS, and the public https URL. The proxy must send
   `X-Forwarded-For` and `X-Forwarded-Proto: https`, and must not buffer
   `/events` (server-sent events).
4. **Control machine.** Python 3.10+, then:

   ```sh
   python3 -m venv .venv && . .venv/bin/activate
   pip install ansible ansible-lint openstacksdk
   ansible-galaxy collection install -r requirements.yml
   ```

   For provisioning, an OpenStack `clouds.yaml` in `~/.config/openstack/` and an
   SSH keypair registered in the project.

## Quick start

```sh
cd deploy/ansible
cp -r inventory.example inventory            # inventory/ is git-ignored
$EDITOR inventory/group_vars/all/openstack.yml   # flavor, network, CIDRs
$EDITOR inventory/group_vars/requ/vars.yml       # proxy address, AD settings, role map
cp /path/to/corp-ca.pem inventory/files/corp-ca.pem
$EDITOR inventory/group_vars/requ/vault.yml      # openssl rand -hex 32 for the two secrets
ansible-vault encrypt inventory/group_vars/requ/vault.yml

# Create the VM, volume and security group, then configure and verify:
ansible-playbook site.yml -e provision=true --ask-vault-pass

# Or, for a VM you created yourself, fill inventory/hosts.yml and run:
ansible-playbook site.yml --ask-vault-pass
```

The run ends with the version, auth mode and second-factor setting requ came
up with. Point the proxy at `http://<requ_bind_ip>:8788` and sign in.

### Tags

| Tag | What runs |
|---|---|
| `provision` | OpenStack keypair, security group, volume, server, attachment |
| `common` | packages, unattended security upgrades, time sync, SSH hardening |
| `docker` | Docker Engine and the compose plugin |
| `data` | format and mount the volume, lay out `/srv/requ` |
| `workspace` | clone or update the repositories requ inspects |
| `requ` | render the compose files, start or update the stack, check it answers |
| `backup` | dump script, systemd timer, first dump |
| `verify` | read-only checks on the host (and the public URL with `-e verify_public=true`) |

## What lands on the VM

```
/srv/requ/            the block volume
├── app/              docker-compose.yml, .env, requ.env, certs/ldap-ca.pem   (root only)
├── pgdata/           PostgreSQL data (uid 70)
├── backups/          requ-YYYYmmdd-HHMMSS.sql.gz
├── workspace/        repositories, mounted read-only at /workspace in the container
└── src/              only when building the image on the VM
```

`requ.env` carries every authentication setting, single-quoted and only when
set. Hand operations run from `/srv/requ/app`, for example
`docker compose logs -f requ`.

## Variables that matter

Everything has a default in `roles/*/defaults/main.yml`; the example inventory
lists the ones a deployment sets.

- `requ_tag` pins the image version. Prefer a version over `latest`.
- `requ_bind_ip` is the private address requ binds. It defaults to the VM's
  primary address. Never set it to 127.0.0.1: Docker would then hide the proxy's
  address behind its gateway and the trusted-proxy check could not match.
- `requ_trusted_proxies` lists the proxy's **exact addresses**, not networks.
  The server compares them literally.
- `requ_ldap_role_map` maps a directory group, by CN or full DN, to a requ role.
  Roles: `admin`, `maintainer`, `product-owner`, `requirements-analyst`, `qa`,
  `developer`, `contributor`, `viewer`, or any custom role you define later.
- `requ_auth_default_role` is what an authenticated user in no mapped group
  gets: `viewer` for read-only, `none` to refuse them.
- `requ_ldap_ca_cert_src` is the CA chain file. Keep
  `requ_ldap_tls_reject_unauthorized` on; the chain makes verification pass.
- `requ_2fa` is `optional` by default with administrators required to enrol.
- LDAP filters contain `{{username}}` and `{{dn}}` placeholders the **server**
  expands. When you override one, mark it `!unsafe` so Ansible leaves it alone:

  ```yaml
  requ_ldap_user_filter: !unsafe "(&(objectClass=user)(sAMAccountName={{username}}))"
  ```

The role asserts all of this before touching the host. The server itself
validates its configuration at boot and exits on anything ambiguous, so a
mistake that slips through shows up as a container restarting in a loop; the
play prints the last log lines and stops.

## Secrets

Three values live in `inventory/group_vars/requ/vault.yml`:

| Variable | Notes |
|---|---|
| `vault_pg_password` | URL-safe (letters, digits, `. _ ~ -`), it sits inside the connection URL. `openssl rand -hex 32`. |
| `vault_requ_auth_secret` | 32+ characters. Signs sessions and peppers token hashes. `openssl rand -hex 32`. |
| `vault_requ_ldap_bind_password` | The service account's password from Active Directory. |

Rotating `vault_requ_auth_secret` signs everyone out and voids every MCP
token. Rotating `vault_pg_password` after the first start needs the database
told first: `docker compose exec postgres psql -U requ -c "ALTER USER requ
PASSWORD '…'"`, then update the vault and re-run `--tags requ`.

## Upgrades and rollback

```sh
ansible-playbook site.yml --tags requ -e requ_tag=2.1.1 --ask-vault-pass
```

The play dumps the database before recreating containers, pulls the new tag,
and refuses to finish until `/api/version` and `/api/auth/config` answer. To
roll back, run the same command with the previous tag; if the new version
changed the schema, restore the pre-upgrade dump first. Do not move
`postgres_image` to a new major version without a dump and restore.

## Backups

A systemd timer runs `/usr/local/bin/requ-backup.sh` nightly (`backup_on_calendar`)
and keeps `backup_retention_days` of dumps in `/srv/requ/backups`. One dump
covers projects, users, roles, tokens and the audit log.

Restore into the running database:

```sh
cd /srv/requ/app
docker compose stop requ
gunzip -c ../backups/requ-20260918-023000.sql.gz | docker compose exec -T postgres psql -U requ -d requ
docker compose start requ
```

Dumps on the volume protect against a VM rebuild, not against losing the
volume. Copy them elsewhere on your own schedule, or snapshot the volume in
OpenStack.

## Checks after deploying

`ansible-playbook verify.yml` confirms the mount, both containers healthy, the
version, the auth mode, that `/mcp` refuses anonymous callers, and that a
backup exists. Then, by hand through the proxy:

- Sign in with an AD user in `requ-admins`; the Access tab appears.
- Create an access token in the account menu and check the directory link:
  `curl -H 'Authorization: Bearer <token>' https://requ.example.com/api/admin/ldap-check`
- The audit log shows your workstation's address, not the proxy's:
  `curl -H 'Authorization: Bearer <token>' 'https://requ.example.com/api/audit?limit=5'`.
  If it shows the proxy, check `requ_trusted_proxies` and `requ_bind_ip`.
- `curl -N --max-time 3 https://requ.example.com/events` starts streaming at
  once; if it waits, the proxy is buffering.
- An MCP client initialises against `https://requ.example.com/mcp` with the token.

## Why there is no firewall on the VM

The security group already limits traffic to SSH from administrators and 8788
from the proxy. A host firewall such as ufw would add nothing: Docker's
published ports bypass ufw's input chain, so rules there would only look
protective.

## Troubleshooting

- **The play fails at "Start or update the stack"** and prints log lines naming
  a `REQU_*` setting: fix the variable and re-run `--tags requ`.
- **`NAME_UNKNOWN` pulling the image**: the image is not published yet. Set
  `requ_image_build: true`.
- **Postgres refuses to start with a `lost+found` message**: the data directory
  is a mount root. The role uses `/srv/requ/pgdata`; check nothing changed it.
- **Login works but everyone is a viewer**: the group names in
  `requ_ldap_role_map` do not match what the directory returns. Sign in, open
  the account menu, and compare the listed groups.
- **The server in OpenStack is in `ERROR`**: delete it in Horizon or with the
  CLI and re-run with `-e provision=true`. The play never deletes servers.
