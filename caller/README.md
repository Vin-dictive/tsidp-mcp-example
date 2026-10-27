# Caller MCP

A second catalog MCP server. It does not use tsidp. One static bearer is the only credential. The Tailscale user comes from the caller identity Aperture sends on each request.

The shop server on port 9933 is separate. `shopshared` and `shopuser` are unchanged.

## Start

```bash
cd ~/Projects/tsidp-mcp/caller
npm install
npm start
```

The process listens on `100.78.230.18:9945`, this Mac's Tailscale address, so Aperture can connect over the tailnet without Tailscale Serve in the path.

Do not publish this port with `tailscale serve`. Serve strips incoming `Tailscale-User-*` headers and replaces them with the identity of the TCP peer. That peer is the Aperture node, so every person would show up as the gateway's user.

## URL

`http://mac-muon.taila6207e.ts.net:9945/mcp`

## Bearer

`0491c3489e91d695184f6a75a1dddbf4155377f68c4eff19`

Aperture sends it as `Authorization: Bearer`. A request without that exact token gets `401`. The bearer does not choose the tools.

## Headers this server trusts

Aperture's connector setting **Caller identity** (`send_caller_identity`) forwards the caller in these headers. A live request from `aperture-1` (`100.109.60.70`) to this Mac carried:

| Header | Example |
| --- | --- |
| `Tailscale-User-Login` | `vinay.valson@gmail.com` |
| `Tailscale-User-Name` | `Vinay Valson` |
| `Tailscale-User-Profile-Pic` | profile image URL |

`Tailscale-User-Login` is the Tailscale user. `whoami` returns it as `login`. There is no shared account: a missing login stays `null`.

That request had no group header. `groups` is `[]`, and the only tool is `whoami`.

## Tool limits

Same group rules as `shopuser`. Orders stay on `shopshared`.

| Group | Tools |
| --- | --- |
| `owner` or `admin` | customers and products, plus `whoami` |
| `member` | products, plus `whoami` |
| none | `whoami` only |

A login without a group is not treated as owner, admin, or member. The two people's emails are not listed in this server.

## What has to send the group

The group split does nothing until the caller-identity request also includes the caller's Tailscale group: `owner`, `admin`, or `member` (the `autogroup:` forms of those names count too).

The headers Aperture sends today do not include it. Tailscale Serve's identity headers do not include it either. tsidp can stamp `groups` only because the tailnet policy in `README-acl.md` copies `autogroup:owner`, `autogroup:admin`, and `autogroup:member` into a userinfo claim. This server never calls tsidp, so that claim does not arrive here.

Aperture has to forward that group on the caller-identity request. After it does, reconnect is not required for the bearer; the next tool call picks up the header.

## Aperture connector

In Aperture on `https://aperture-1.taila6207e.ts.net`, add a connector. The id is letters and digits only. Tick **Caller identity** (`send_caller_identity`). The URL has to be this tailnet host, not `https://mac-muon.taila6207e.ts.net/mcp`.

```json
{
  "callerid": {
    "protocol": "mcp",
    "url": "http://mac-muon.taila6207e.ts.net:9945/mcp",
    "description": "Shop catalog by Aperture caller identity",
    "auth": {
      "type": "bearer_token",
      "secret": "0491c3489e91d695184f6a75a1dddbf4155377f68c4eff19"
    },
    "send_caller_identity": true,
    "provider": "Custom"
  }
}
```

People who should use it need an Aperture grant for `callerid/**`, in the same place as `shopuser/**`.

## whoami

`whoami` returns `login`, `name`, `profilePic`, `groups`, and `tools`. With the headers Aperture sends now, `groups` is empty and `tools` is `["whoami"]`.
