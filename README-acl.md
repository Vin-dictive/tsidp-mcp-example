# Tailscale ACL for tsidp-mcp

Tailnet: `taila6207e.ts.net`. Edit the policy at <https://login.tailscale.com/admin/acls>. Add the grants below to the existing `grants` array. Saving replaces nothing else in the policy when these objects are inserted alongside the grants already there.

The MCP resource URL is `https://mac-muon.taila6207e.ts.net/mcp`. `resources` has to match that string exactly. tsidp checks it when a token is issued for this server.

## Dynamic client registration

tsidp denies `/register` unless the caller has `tailscale.com/cap/tsidp` with `allow_dcr` true. Aperture's `shopuser` connector registers from the Aperture node, which is logged in as `vinay.valson@gmail.com`. This Mac is tagged, so a register call from here is a different identity.

```hujson
{
  "src": ["vinay.valson@gmail.com"],
  "dst": ["*"],
  "app": {
    "tailscale.com/cap/tsidp": [
      {
        "allow_dcr": true,
        "users": ["*"],
        "resources": ["https://mac-muon.taila6207e.ts.net/mcp"]
      }
    ]
  }
}
```

`users` is which logins may be the subject of a token for those resources. `["*"]` allows any tailnet user.

## Group claim for shopuser tools

tsidp does not copy Tailscale groups onto a token by itself. These grants stamp a `groups` claim from the caller's autogroup, and only when `includeInUserInfo` is true. The MCP server reads `groups` from `https://idp.taila6207e.ts.net/userinfo`. Logins are not listed in the server.

`autogroup:admin` is the Admin role only. The Owner role is `autogroup:owner`, so the owner grant is what gives that account the broader tool set. `autogroup:member` includes every direct member, including owners and admins. When both claims are present, `owner` or `admin` wins.

| `groups` value | shopuser tools |
| --- | --- |
| `owner` or `admin` | `list_customers`, `get_customer`, `search_customers`, `list_products`, `search_products`, `whoami` |
| `member` | `list_products`, `search_products`, `whoami` |
| absent | `whoami` |

`list_orders` and `get_order` are not granted by any of these groups. They are only available on the `shopshared` bearer.

```hujson
{
  "src": ["autogroup:owner"],
  "dst": ["*"],
  "app": {
    "tailscale.com/cap/tsidp": [{
      "includeInUserInfo": true,
      "extraClaims": { "groups": ["owner"] }
    }]
  }
},
{
  "src": ["autogroup:admin"],
  "dst": ["*"],
  "app": {
    "tailscale.com/cap/tsidp": [{
      "includeInUserInfo": true,
      "extraClaims": { "groups": ["admin"] }
    }]
  }
},
{
  "src": ["autogroup:member"],
  "dst": ["*"],
  "app": {
    "tailscale.com/cap/tsidp": [{
      "includeInUserInfo": true,
      "extraClaims": { "groups": ["member"] }
    }]
  }
}
```

The claim is taken from the WhoIs snapshot stored when the user finishes Connect. After changing these grants, each person connects `shopuser` again and refreshes tools. `whoami` shows the `groups` array on that token.

## All four grants together

```hujson
"grants": [
  {
    "src": ["vinay.valson@gmail.com"],
    "dst": ["*"],
    "app": {
      "tailscale.com/cap/tsidp": [
        {
          "allow_dcr": true,
          "users": ["*"],
          "resources": ["https://mac-muon.taila6207e.ts.net/mcp"]
        }
      ]
    }
  },
  {
    "src": ["autogroup:owner"],
    "dst": ["*"],
    "app": {
      "tailscale.com/cap/tsidp": [{
        "includeInUserInfo": true,
        "extraClaims": { "groups": ["owner"] }
      }]
    }
  },
  {
    "src": ["autogroup:admin"],
    "dst": ["*"],
    "app": {
      "tailscale.com/cap/tsidp": [{
        "includeInUserInfo": true,
        "extraClaims": { "groups": ["admin"] }
      }]
    }
  },
  {
    "src": ["autogroup:member"],
    "dst": ["*"],
    "app": {
      "tailscale.com/cap/tsidp": [{
        "includeInUserInfo": true,
        "extraClaims": { "groups": ["member"] }
      }]
    }
  }
]
```

Connect from an untagged device. tsidp rejects `/authorize` from a tagged node with `tagged node doesn't have a user identity`. `mac-muon` is tagged (`tag:relay-devices`, `tag:tagged-devices`).

Aperture connector grants (`shopshared/**` and `shopuser/**`) are set in the Aperture configuration, not in this tailnet policy.
