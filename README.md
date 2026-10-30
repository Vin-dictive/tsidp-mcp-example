# tsidp-mcp

A small remote MCP server for a mock coffee-wholesale catalog, behind
[tsidp](https://github.com/tailscale/tsidp) — Tailscale's OIDC identity provider.
The catalog is a SQLite file, so there is no database service to run. The MCP
endpoint is streamable HTTP.

Every caller presents a per-user tsidp token. The MCP server introspects that
token with tsidp and reads two claims from it, which the tailnet policy stamps:

| Claim | Decides | Example |
| --- | --- | --- |
| `groups` | which **data domains** the caller sees | `["owner"]` → customers, products, orders |
| `capabilities` | whether they **read or also write** in those domains | `["read","write"]` |

Neither claim is listed anywhere in the server. No logins, groups, or emails are
hardcoded, and the server holds no Tailscale admin credential.

> Replace `<tailnet>` below with your own tailnet name (the `*.ts.net` name shown
> at <https://login.tailscale.com/admin/dns>). Node names come from `.env`.

## How a call is authorized

```mermaid
flowchart TD
  connect["User selects Connect on the connector, from an untagged device"] --> dcr["Client registers at tsidp /register"]
  dcr --> dcrgrant{"Caller has allow_dcr in tailscale.com/cap/tsidp?"}
  dcrgrant -- no --> dcrdeny["Registration denied"]
  dcrgrant -- yes --> authorize["Browser goes to tsidp /authorize"]
  authorize --> tagged{"Browser device tagged?"}
  tagged -- yes --> tagdeny["tagged node doesn't have a user identity"]
  tagged -- no --> whois["tsidp runs WhoIs on the browser's device and stores that user and their grants"]
  whois --> claims["Grants add extraClaims groups and capabilities to userinfo"]
  claims --> token["Token issued for resource SHOP_RESOURCE_URL"]
  token --> toolcall["Tool call: Authorization: Bearer user token"]
  toolcall --> serve["Tailscale Serve on the shop node, then the server on 127.0.0.1:9933"]
  serve --> intro["POST tsidp /introspect: active, aud equals RESOURCE_URL"]
  intro -- inactive or wrong audience --> u401["401"]
  intro -- ok --> userinfo["GET tsidp /userinfo: read groups and capabilities"]
  userinfo --> domains{"groups"}
  domains -- owner or admin --> d1["customers, products, orders"]
  domains -- member --> d2["products"]
  domains -- none --> d3["no data domains, whoami only"]
  d1 --> caps{"capabilities"}
  d2 --> caps
  caps -- read --> readonly["read tools in those domains"]
  caps -- read + write --> readwrite["read tools plus write tools"]
```

## Tool tiers

`groups` picks the rows, `capabilities` picks the columns. From
`server/src/access.js`.

| `groups` | Domains | `read` (or no claim) | adds with `write` |
| --- | --- | --- | --- |
| `owner`, `admin` (or `autogroup:` forms) | customers, products, orders | `list_customers`, `get_customer`, `search_customers`, `list_products`, `search_products`, `list_orders`, `get_order` | `update_customer`, `upsert_product`, `create_order`, `update_order_status` |
| `member` (or `autogroup:member`) | products | `list_products`, `search_products` | `upsert_product` |
| none | none | — | — |

`whoami` is always available to any valid token. When both `owner`/`admin` and
`member` match, the wider tier wins.

Two rules worth stating plainly:

- **A token with no `capabilities` claim reads.** Writing is never implicit, so
  an unchanged tailnet policy cannot start writing after an upgrade.
- **`write` alone does not grant the read tools.** The claim is taken literally:
  `["write"]` on a `member` yields `upsert_product` and `whoami` only. Grant
  `["read","write"]` for the usual case.

Tool filtering happens at registration, per request. A tool a caller may not use
is never registered on that caller's server instance, so calling it by name
fails rather than being merely hidden from `tools/list`.

### Read and write use different database handles

`server/src/catalog.js` opens the same file twice:

| Handle | Opened with | Used by |
| --- | --- | --- |
| reader | `new DatabaseSync(path, { readOnly: true })` | every read tool |
| writer | `new DatabaseSync(path)` | the four write tools only |

SQLite refuses any write on the read-only handle — it raises *"attempt to write
a readonly database"* — so a bug in a read tool cannot modify data even when it
is reached with a write caller's token. `npm run verify` asserts this directly.

This is a weaker guarantee than the Postgres roles it replaced. It is enforced
**inside the process**, not by the database: anything with filesystem access to
`shop.db` can still write to it. The schema is applied from
`server/src/schema.sql` the first time the file is opened.

## Prerequisites

1. **Docker.**
2. **MagicDNS and HTTPS certificates, both enabled**, at
   <https://login.tailscale.com/admin/dns>. This is required, not optional:
   - MagicDNS is what makes `idp.<tailnet>.ts.net` and
     `shop-mcp.<tailnet>.ts.net` resolve at all.
   - HTTPS certificates are what let Tailscale Serve terminate TLS on those
     names. Without them the shop node cannot serve `https://`, tsidp cannot
     issue an issuer URL the MCP server will accept, and every discovery fetch
     fails.

   Turn both on **before** the first `docker compose up`. Enabling them later
   means re-registering the nodes to pick up certificates.
3. **Both tags defined in `tagOwners`, and an OAuth client that holds them** —
   see [Tags and one auth key](#tags-and-one-auth-key). Registration fails if
   either is missing, and the client's tags cannot be changed afterwards.
4. An MCP client that speaks OAuth, and a tailnet user to connect as.

## Tags and one auth key

Both nodes are tagged, so they are server identities rather than someone's
personal devices, and their keys do not expire:

| Service | Node | Tag |
| --- | --- | --- |
| `tsidp` | `idp.<tailnet>.ts.net` | `${TSIDP_TAG}`, default `tag:tsidp` |
| `ts-shop` | `shop-mcp.<tailnet>.ts.net` | `${MCP_TAG}`, default `tag:mcpserver` |

Add both to the policy before first start:

```hujson
"tagOwners": {
  "tag:tsidp":     ["autogroup:admin"],
  "tag:mcpserver": ["autogroup:admin"],
},
```

**One credential covers both.** Use an **OAuth client**, not a plain auth key:
create one at <https://login.tailscale.com/admin/settings/oauth> with the
`auth_keys` write scope and both tags, then set a single value in `.env`:

```bash
TS_AUTHKEY=tskey-client-xxxxxxxxxxxx?ephemeral=false
```

Each node then mints its own key carrying only its own tag. `?ephemeral=false`
keeps the nodes after a restart.

**The client's tags are fixed at creation and cannot be edited.** A node may only
request a tag the client already holds, so a client created with just one tag
fails for the other node — see
[requested tags are invalid or not permitted](#requested-tags-are-invalid-or-not-permitted).

If you would rather not re-create the client each time you add a node, give it a
single owner tag instead of listing every node tag:

```hujson
"tagOwners": {
  "tag:mcp-deploy": ["autogroup:admin"],
  "tag:tsidp":      ["tag:mcp-deploy"],
  "tag:mcpserver":  ["tag:mcp-deploy"],
},
```

Create the client with **only** `tag:mcp-deploy`. It can then mint keys for
either child tag, and a new node needs a `tagOwners` line rather than a new
client.

This works because the two services take their tag by different routes, and both
routes are driven from that one secret:

| Service | How it gets its tag | Why |
| --- | --- | --- |
| `tsidp` | `TS_ADVERTISE_TAGS` | it is a **tsnet** app, so there is no `tailscale up` to pass flags to. tsidp's own `-advertise-tags` flag reads this, and its help text notes it is required with OAuth client secrets |
| `ts-shop` | `TS_EXTRA_ARGS=--advertise-tags=…` | it runs real `tailscaled`, so the flag goes to `tailscale up` |

**A plain `tskey-auth-` key cannot do this.** Tags on an auth key are
authoritative: one key holding both tags puts *both* tags on *both* nodes, and
asking for a subset with `--advertise-tags` only works if you add self-ownership
to `tagOwners`. If you would rather use plain keys, generate one per tag, keep
`TS_AUTHKEY` for tsidp, add `TS_AUTHKEY_SHOP` to `.env`, and point the `ts-shop`
service at it in `docker-compose.yml`.

### TSNET_FORCE_LOGIN

The `tsidp` service sets `TSNET_FORCE_LOGIN=1`. tsnet **ignores `TS_AUTHKEY`
whenever its state directory already holds a logged-in node** — it logs
`Authkey is set; but state is …. Ignoring authkey. Re-run with
TSNET_FORCE_LOGIN=1 to force use of authkey.` Since `/data` persists in the
`tsidp-data` volume, a tag added later would never take effect without this:
the node would quietly keep its old untagged identity.

It pairs with an auth key. With a valid key, every start re-authenticates
silently. Without one, each start prints a fresh login URL to approve.

## Tailnet policy

Edit at <https://login.tailscale.com/admin/acls>. Alongside the `tagOwners`
above, add these grants. Change two things:

- `resources` becomes your `SHOP_RESOURCE_URL`, character for character. tsidp
  checks it when it issues a token, and the MCP server rejects a token whose
  audience does not match.
- The `allow_dcr` grant's `src` becomes the login (or group) allowed to register
  a client. tsidp denies `/register` to anyone else.

The `autogroup:` grants need no names from your tailnet. They stamp `groups` and
`capabilities` onto whoever connects. Both claims need `includeInUserInfo: true`
— tsidp exposes extraClaims only on `/userinfo`, which is where the server reads
them.

```hujson
"grants": [
  {
    // Dynamic client registration.
    "src": ["autogroup:admin"],
    "dst": ["*"],
    "app": {
      "tailscale.com/cap/tsidp": [
        {
          "allow_dcr": true,
          "users": ["*"],
          "resources": ["https://shop-mcp.<tailnet>.ts.net/mcp"]
        }
      ]
    }
  },
  {
    // Owner: every domain, and may write.
    "src": ["autogroup:owner"],
    "dst": ["*"],
    "app": {
      "tailscale.com/cap/tsidp": [{
        "includeInUserInfo": true,
        "extraClaims": {
          "groups": ["owner"],
          "capabilities": ["read", "write"]
        }
      }]
    }
  },
  {
    // Admin: every domain, read only. Add "write" here to let admins write too.
    "src": ["autogroup:admin"],
    "dst": ["*"],
    "app": {
      "tailscale.com/cap/tsidp": [{
        "includeInUserInfo": true,
        "extraClaims": {
          "groups": ["admin"],
          "capabilities": ["read"]
        }
      }]
    }
  },
  {
    // Member: products only, read only.
    "src": ["autogroup:member"],
    "dst": ["*"],
    "app": {
      "tailscale.com/cap/tsidp": [{
        "includeInUserInfo": true,
        "extraClaims": {
          "groups": ["member"],
          "capabilities": ["read"]
        }
      }]
    }
  }
]
```

`autogroup:admin` is the Admin role only; the Owner role is `autogroup:owner`.
`autogroup:member` includes every direct member, owners and admins included —
which is why the wider tier wins when several match.

Claims come from the WhoIs snapshot taken when the user finishes Connect. After
changing these grants, each person connects again and refreshes their tools.
`whoami` shows the `groups` and `capabilities` on the current token.

Note that `capabilities` is an ordinary extraClaim, not something tsidp knows
about. Naming it something else means changing only `server/src/access.js` and
`server/src/index.js`.

## Run

`docker compose up -d` starts three services:

| Service | Where it lives | What it is |
| --- | --- | --- |
| `tsidp` | own tailnet node, `idp.<tailnet>.ts.net`, `tag:tsidp` | Tailscale's OIDC provider |
| `ts-shop` | own tailnet node, `shop-mcp.<tailnet>.ts.net`, `tag:mcpserver` | Tailscale in userspace mode. No `/dev/net/tun`, so it runs on Docker Desktop |
| `shop` | shares `ts-shop`'s network | the MCP server, with the catalog at `/data/shop.db` on the `shop-data` volume |

The sidecar publishes two ports on the shop node:

| Port | Mode | URL |
| --- | --- | --- |
| 443 | HTTPS Serve | `https://shop-mcp.<tailnet>.ts.net/mcp` |
| 8443 | HTTPS Serve, the call inspector | `https://shop-mcp.<tailnet>.ts.net:8443/` |

The server reaches tsidp through the sidecar's HTTP proxy, because userspace
mode has no tunnel interface. Nothing else leaves the container — the catalog is
a local file.

### First start

```bash
cp example.env .env
```

Fill in `.env`. `TSIDP_URL` is `https://idp.<tailnet>.ts.net` and
`SHOP_RESOURCE_URL` is `https://shop-mcp.<tailnet>.ts.net/mcp`. There are no
database credentials to set.

```bash
docker compose up -d --build
docker compose logs -f tsidp ts-shop
```

With `TS_AUTHKEY` set, both nodes register themselves. Without it, each prints a
`https://login.tailscale.com/a/...` URL to approve. HTTPS for the new names can
take a minute.

```bash
curl -4sS https://idp.<tailnet>.ts.net/.well-known/openid-configuration
curl -4sS -o /dev/null -w "%{http_code}\n" https://shop-mcp.<tailnet>.ts.net/mcp
```

The second returns `401`. That is the MCP server answering.

Connect from an **untagged** device. The server nodes are tagged, which is fine,
but tsidp rejects `/authorize` from a tagged *client* with `tagged node doesn't
have a user identity` — it has no user to run WhoIs against.

The catalog is created and seeded the first time the server opens
`/data/shop.db`. `docker compose down -v` deletes it along with both nodes'
state; the next start seeds a fresh copy.

## Call inspector

`https://shop-mcp.<tailnet>.ts.net:8443/` shows each MCP call live: the verified
user, their `groups` and `capabilities`, the tools that identity may call, the
`Tailscale-User-*` headers, and the full request and response.

> **The inspector has no authentication, and Serve publishes it to your whole
> tailnet.** Anyone who can reach the shop node can read it — including people
> with no grant for this MCP server at all, and tagged nodes that can never hold
> a token. It captures tool *responses*, so customer names, emails and order
> history from an owner's calls become readable by any tailnet device, which
> bypasses the tool tiers above for reading. It also exposes the login, email
> and groups of everyone who has used the server, and `POST /api/clear` wipes
> the record without authentication.
>
> Treat it as a development tool on a tailnet you trust. To close the exposure,
> remove the `8443` entries from `ts-shop/serve.json` and reach it through
> `docker compose exec` or an SSH port-forward instead. On the 8443 Serve path
> `Tailscale-User-Login` *is* trustworthy — Serve deletes any client-sent copy
> and writes the connecting device's identity — so gating the inspector on an
> allowlist of logins is a sound fix if you want to keep it published.

Records are capped at 200 calls, held in memory only, and never written to disk.
`Authorization`, `Cookie` and `Proxy-Authorization` are redacted.

## Development

```bash
cd server
npm install
npm start
```

Requires **Node 24+**: the catalog uses the built-in `node:sqlite`, which is a
release candidate there and needs no flag. There is no database driver
dependency.

`npm run verify` needs nothing running at all — it seeds a throwaway database
in a temp directory, then checks the seed data, the tool list, the whole
group × capability matrix, every write tool, and that the read-only handle
really does refuse writes. The host process listens on `127.0.0.1:9933` and
keeps its catalog wherever `DATABASE_PATH` points (`./data/shop.db` by default).

Inspect the data with the `sqlite3` CLI:

```bash
sqlite3 server/data/shop.db 'SELECT * FROM orders ORDER BY id DESC LIMIT 5;'
```

`scripts/tsidp.sh` runs tsidp against an existing local `tailscaled` instead of
its own tsnet node; it is only useful for hacking on tsidp itself, and the node
running it must be untagged.

## Troubleshooting

### requested tags are invalid or not permitted

```
ERROR failed to start tsnet server error="tsnet.Up: tsnet: error resolving auth key:
Status: 400, Message: \"requested tags [tag:tsidp] are invalid or not permitted\""
```

The node asked the control plane to mint a key with that tag and was refused.
Nothing is wrong with the container or the server; the tag request itself is
correct. The two halves of the message are two different causes:

| Message | Cause | Fix |
| --- | --- | --- |
| **invalid** | the tag is not in `tagOwners` | add it to the policy file |
| **not permitted** | the OAuth client does not hold that tag | re-create the client with both tags, or use the owner-tag pattern above |

Because a client cannot be created with a tag that is not already in
`tagOwners`, a client that exists but fails here was almost certainly created
with only one of the two tags. Client tags cannot be edited — delete it and
create a new one.

`ts-shop` fails the same way for `${MCP_TAG}`, a few lines later in the log, so
fix both tags at once.

This error only appears because `TSNET_FORCE_LOGIN=1` makes tsidp actually use
the key. Without it, tsnet would reuse the logged-in node already in `/data`,
start up looking healthy, and stay **untagged**.

### Tagged nodes need their own ACL rules

Devices registered with OAuth client credentials are **tag-owned**, so they are
no longer covered by any policy rule that grants access because you personally
own the device. On a tailnet more restrictive than the default allow-all, add
rules letting users reach `tag:tsidp:443` and `tag:mcpserver:443`, or the nodes
register successfully and are still unreachable.

### tagged node doesn't have a user identity

tsidp rejected `/authorize`. The **client** device is tagged, and a tagged node
has no user for tsidp to resolve with WhoIs. Connect from an untagged device.
The two server nodes being tagged is unrelated and fine.

### Tool list is smaller than expected

`whoami` reports the `groups` and `capabilities` on the current token. An empty
`groups` means no data domains, and `capabilities` falling back to `["read"]`
means no claim arrived. Both come from the WhoIs snapshot taken at Connect, so
after changing grants each person has to connect again and refresh tools.
Remember `includeInUserInfo: true` — without it tsidp issues the claim but never
exposes it on `/userinfo`, which is where the server reads it.

## Stop

```bash
docker compose stop
```

`docker compose down -v` also deletes the catalog and both nodes' state.
