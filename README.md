# tsidp-mcp

A small remote MCP server for a mock coffee-wholesale catalog. Postgres runs in Docker. The MCP endpoint is streamable HTTP and requires a bearer token from [tsidp](https://github.com/tailscale/tsidp), Tailscale's OIDC identity provider.

Tailnet: `taila6207e.ts.net`. This Mac is `mac-muon`.

## Start the database

```bash
cd ~/Projects/tsidp-mcp
docker compose up -d db
```

Postgres listens on `127.0.0.1:54329`. The MCP role `mcp_reader` can only `SELECT`. Seed data is customers, products, orders, and order items (Northwind Cafe, Harbor & Rye, and so on).

## Start tsidp

tsidp is a separate tailnet node, which is the setup in the current [tsidp README](https://github.com/tailscale/tsidp). No auth key is stored here. On first start the container prints a Tailscale login URL.

```bash
docker compose up -d tsidp
docker compose logs -f tsidp
```

Open the `https://login.tailscale.com/a/...` URL and approve the node. Its name is `idp`, so the issuer is:

`https://idp.taila6207e.ts.net`

HTTPS for that name can take a minute after approval. Check:

```bash
curl -4sS https://idp.taila6207e.ts.net/.well-known/openid-configuration
```

## Tailnet policy

The `tailscale.com/cap/tsidp` grants for dynamic client registration and the `groups` claim are in [README-acl.md](README-acl.md). Add them at <https://login.tailscale.com/admin/acls>. `resources` has to be `https://mac-muon.taila6207e.ts.net/mcp`.

## Start the MCP server

```bash
cd ~/Projects/tsidp-mcp/server
npm install
npm start
```

## Aperture connectors

The gateway is `https://aperture.taila6207e.ts.net`. It can reach this server at `https://mac-muon.taila6207e.ts.net/mcp` after `tailscale serve --bg 9933`. In Aperture, open Administration, then Connectors (or Configuration at `/admin/settings/config`) and add two servers. Connector IDs are letters and digits only.

`shopshared` uses one bearer for every granted user. The secret is `SHARED_TOKEN` in `.env`. That caller shows up as `sub` `shared` and can call every catalog tool, including orders.

`shopuser` is per-user. Aperture registers a client with tsidp (`oauth2_dcr`) and stores a separate token for each Tailscale user. Each person opens Connectors in Aperture Chat and selects Connect. Do that from an untagged device (the iPhone or another machine logged in as you). This Mac is tagged, and tsidp rejects that login.

Tool access for `shopuser` comes from the `groups` claim in [README-acl.md](README-acl.md). `owner` or `admin` can read customers and products. `member` can read products. Orders stay on `shopshared`. After saving the policy, each person connects `shopuser` again and refreshes tools. Aperture also needs connector grants for `shopshared/**` and `shopuser/**` in the Aperture configuration.

## Caller identity server

`caller/` is a separate MCP server with one static bearer and no tsidp. Aperture's Caller identity headers choose the tools. See [caller/README.md](caller/README.md). The shop server on port 9933 is unchanged.

## URL for Cursor

`https://mac-muon.taila6207e.ts.net/mcp`

```json
{
  "mcpServers": {
    "shop-catalog": {
      "url": "http://127.0.0.1:9933/mcp"
    }
  }
}
```

Cursor follows the `401` `WWW-Authenticate` challenge to `http://127.0.0.1:9933/.well-known/oauth-protected-resource/mcp`, then to tsidp. The tools that appear depend on the token: the shared credential sees the full catalog, and a per-user token sees the subset for that Tailscale group.

## Why login from this Mac does not work yet

`mac-muon` is a tagged node (`tag:relay-devices`, `tag:tagged-devices`), not the user `vinay.valson@gmail.com`. Current tsidp rejects `/authorize` for tagged nodes with `tagged node doesn't have a user identity` (`server/authorize.go`). Cursor on this Mac would present that tagged node, so the browser login fails until this Mac is logged into Tailscale as the user, or Cursor is used from an untagged device.

Running tsidp with `--use-local-tailscaled` on this Mac was tried and stopped. In that mode tsidp only accepts identity from Tailscale Serve's `X-Forwarded-For` header, and binding the tailscale address took the connection before Serve could add the header (`Error getting WhoIs`). The MCP server is published with `tailscale serve --bg 9933`, which proxies `https://mac-muon.taila6207e.ts.net/` to `http://127.0.0.1:9933`.

## Stop

```bash
# Ctrl-C the npm process, then:
docker compose stop
```

`docker compose down -v` also deletes the database volume and the tsidp node state.
