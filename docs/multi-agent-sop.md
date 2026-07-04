# Multi-Agent Shared-Host SOP

Standard operating procedure for running **one camofox instance that serves many
automated agents/bots on a shared host**, reachable over the network by trusted
machines, with each agent's browser sessions isolated by user.

This procedure uses only the CLI's built-in serve/auth ergonomics. Placeholders
(`<deploy-user>`, `<host>`, `<agent-user>`) stand in for your own values.

---

## 1. Model & scope

- **One server, many callers.** A single container serves all agents. Each caller's
  tabs / cookies / sessions / concurrency budget are namespaced by `CAMOFOX_USER`
  (defaults to the OS username), so distinct users get **isolated** browser sessions
  automatically.
- **Auth is a single access key.** When published off-loopback, every route requires
  `CAMOFOX_ACCESS_KEY`. It is the server's superkey — accepted on all routes.
- **Trust boundary.** `CAMOFOX_USER` is **not** authenticated by the access key. Any
  holder of the access key can act as any `userId`. This is fine for **mutually
  trusted** agents on one instance. For **mutually-untrusted** tenants, run a
  **separate instance** (separate container + key) per trust domain.
- **Network boundary is yours.** Publishing off-loopback exposes the port; a **host
  firewall** must restrict who can reach it.

---

## 2. Prerequisites

- Docker (rootless is recommended — run under a dedicated unprivileged OS user).
- The `camofox` CLI available on the host (see [CLI.md](../CLI.md)).
- A network policy (firewall/allowlist) controlling who can reach the published port.

---

## 3. Stand up the server

Run as your dedicated deploy user:

```bash
camofox serve --publish 0.0.0.0 --durable
```

This single command:

- **Publishes off-loopback** (`--publish 0.0.0.0`) so trusted machines can reach it.
- **Auto-generates a `CAMOFOX_ACCESS_KEY`** (stored at `~/.camofox/access-key`) and
  gates **every** route with it. (The api key alone only guards a subset of routes and
  is insufficient once exposed.)
- Runs **durably** (`--durable` ⇒ detached, `--restart unless-stopped`, and a named
  state volume mounted at the container's `~/.camofox` for keys/cookies/profiles/
  traces) so it survives reboots.

Bind to a specific interface instead of all with `--publish <ip>`, and override the
restart policy / volume with `--restart <policy>` / `--volume <name>` if needed.

Verify:

```bash
camofox health          # { "ok": true, "engine": "camoufox", ... }
```

---

## 4. Configure a client

Any machine or local user that should drive the instance needs the server URL and the
access key:

```bash
export CAMOFOX_URL=http://<host>:9377      # omit for a local server on 127.0.0.1
export CAMOFOX_ACCESS_KEY=<access-key>     # or place it in ~/.camofox/access-key
camofox open https://example.com
```

- A **non-loopback** `CAMOFOX_URL` (or `CAMOFOX_NO_DOCKER=1`) puts the CLI in
  **pure-client mode**: it never shells out to Docker for key/config discovery, so
  client-only users don't need Docker access.
- The CLI prefers the access key over the api key, so a single `CAMOFOX_ACCESS_KEY`
  works on every route.

---

## 5. Grant a new agent/user access

Each agent identifies itself by `CAMOFOX_USER` (defaults to its OS username), which is
what isolates its sessions. It also needs the access key. Pick one pattern:

### Option A — per-user key file (few users)

```bash
install -d -m 700 ~/.camofox
umask 077; printf '%s\n' '<access-key>' > ~/.camofox/access-key
```

### Option B — shared, group-readable key + wrapper (many users, recommended)

Provision the key once in a group-readable location and let a thin wrapper inject it,
so authorized users "just run `camofox`" with no per-user secret:

1. Create an access group and add members:

   ```bash
   sudo groupadd -f camofox-users
   sudo usermod -aG camofox-users <agent-user>     # members re-login to pick it up
   ```

2. Publish the key readable only by that group:

   ```bash
   sudo install -d -o root -g camofox-users -m 750 /etc/camofox
   sudo install -o root -g camofox-users -m 640 /path/to/access-key /etc/camofox/access-key
   ```

3. Install a wrapper on `PATH` (e.g. `/usr/local/bin/camofox`) that injects the key for
   users who can read it, then execs the real CLI:

   ```sh
   #!/bin/sh
   if [ -z "${CAMOFOX_ACCESS_KEY:-}" ] && [ -r /etc/camofox/access-key ]; then
     CAMOFOX_ACCESS_KEY="$(cat /etc/camofox/access-key)"; export CAMOFOX_ACCESS_KEY
   fi
   exec node /path/to/camofox/cli.js "$@"
   ```

Users **not** in the group can't read the key, so they get no bearer token and are
correctly rejected (`401`/`403`) on gated routes.

Verify a new user:

```bash
sudo -u <agent-user> camofox tabs      # authenticated response, not "Unauthorized"
```

> Reminder: every authorized user can act as any `userId` (§1). Only grant access to
> trusted users.

---

## 6. Revoke access

```bash
sudo gpasswd -d <agent-user> camofox-users     # loses access on next login
```

If the user had a per-user key file, remove it. For a hard cutoff of someone who may
have copied the key, **rotate the key** (§7).

---

## 7. Rotate the access key

1. Relaunch the server with a new key (stop → recreate via `camofox serve`, passing a
   fresh `CAMOFOX_ACCESS_KEY`, or delete `~/.camofox/access-key` so `serve` mints one).
2. Update the shared/per-user key material (`/etc/camofox/access-key` and any client
   copies) with the new value.
3. Clients pick up the new key on their next invocation.

---

## 8. Update / redeploy

When the CLI or image changes:

```bash
# refresh code
git -C /path/to/camofox pull --ff-only

# relaunch, preserving the existing keys (extract from the running container first)
ENV='{{range .Config.Env}}{{println .}}{{end}}'
ADMIN=$(docker inspect camofox --format "$ENV"  | sed -n 's/^CAMOFOX_ADMIN_KEY=//p')
ACCESS=$(docker inspect camofox --format "$ENV" | sed -n 's/^CAMOFOX_ACCESS_KEY=//p')
docker stop camofox && docker rename camofox camofox-prev      # keep old for rollback
CAMOFOX_ADMIN_KEY="$ADMIN" CAMOFOX_ACCESS_KEY="$ACCESS" \
  camofox serve --publish 0.0.0.0 --durable
camofox health && docker rm camofox-prev                       # remove old once healthy
```

The state volume is reused, so cookies/profiles persist across the swap.

---

## 9. Health & troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Unauthorized` / `Forbidden` on gated verbs | No access key reaching the CLI — set `CAMOFOX_ACCESS_KEY` or `~/.camofox/access-key`; group members must re-login after being added. |
| `Cannot connect to camofox server` | Wrong `CAMOFOX_URL`, server down, or firewall blocking the client. |
| Read verbs (snapshot/links/goto) work but gated ones fail | Client has no key; only the exempt/read paths succeed. |
| A user sees another user's tabs | Expected — `userId` isn't authenticated (§1). Separate instances for untrusted tenants. |

Read-only verbs need no key on an api-key-only server; on an access-gated server all
routes require the key.

---

## 10. Security checklist

- [ ] Off-loopback publish is fronted by a **host firewall** allowlist.
- [ ] Access key stored with least privilege (`600` per-user, or `640` group-readable).
- [ ] Server runs under a **dedicated unprivileged user** (rootless Docker preferred).
- [ ] Only **trusted** users hold the access key (unauthenticated `userId`).
- [ ] **Untrusted** tenants get **separate instances**, not a shared one.
- [ ] Key rotation procedure (§7) is known to whoever operates the host.
