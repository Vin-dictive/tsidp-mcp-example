import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod";
import { allowedTools, capabilityValues, groupValues } from "./access.js";
import { getPool } from "./catalog.js";
import { createInspector } from "./inspector.js";
import { registerCatalogTools } from "./tools.js";

// The Docker Tailscale sidecar runs in userspace mode, which has no tunnel device,
// so tailnet calls (tsidp) go through its HTTP proxy. The catalog is a local
// SQLite file, so nothing else needs to leave the container.
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const port = Number(process.env.PORT || 9933);
const inspectorPort = process.env.INSPECTOR_PORT ? Number(process.env.INSPECTOR_PORT) : 0;
const inspectorHost = process.env.INSPECTOR_HOST || "127.0.0.1";
const tsidpUrl = new URL(requiredEnv("TSIDP_URL"));
const resourceUrl = new URL(requiredEnv("RESOURCE_URL"));
const scopes = ["openid", "email", "profile"];

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function documentedMetadata(issuer) {
  const base = issuer.replace(/\/$/, "");
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    introspection_endpoint: `${base}/introspect`,
    registration_endpoint: `${base}/register`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    response_types_supported: ["code", "id_token"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ],
    scopes_supported: scopes,
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256", "plain"],
    resource_indicators_supported: true,
  };
}

async function loadOAuthMetadata() {
  const discovery = new URL("/.well-known/oauth-authorization-server", tsidpUrl);
  try {
    const response = await fetch(discovery, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const doc = await response.json();
    if (!doc?.issuer || !doc?.introspection_endpoint) {
      throw new Error("discovery document is missing issuer or introspection_endpoint");
    }
    console.log(`tsidp discovery: ${discovery}`);
    return doc;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`tsidp discovery unavailable (${message}). Serving the documented tsidp metadata for ${tsidpUrl.origin}.`);
    return documentedMetadata(tsidpUrl.origin);
  }
}

function audienceValues(aud) {
  if (aud == null) return [];
  return (Array.isArray(aud) ? aud : [aud]).map(String);
}

/**
 * tsidp only exposes extraClaims on /userinfo, and only when the grant sets
 * includeInUserInfo. Both claims are read from the same response. Any failure
 * yields nothing, which leaves the caller on the lowest tier.
 */
async function claimsFromUserInfo(userinfoEndpoint, token) {
  if (!userinfoEndpoint) return { groups: [], capabilities: [] };
  try {
    const response = await fetch(userinfoEndpoint, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { groups: [], capabilities: [] };
    const info = await response.json();
    return { groups: groupValues(info.groups), capabilities: groupValues(info.capabilities) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "userinfo failed";
    console.warn(`tsidp userinfo unavailable (${message})`);
    return { groups: [], capabilities: [] };
  }
}

function createVerifier(introspectionEndpoint, userinfoEndpoint) {
  return {
    async verifyAccessToken(token) {
      const body = new URLSearchParams({ token });
      let response;
      try {
        response = await fetch(introspectionEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(8000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "introspection failed";
        throw new OAuthError(OAuthErrorCode.InvalidToken, `tsidp introspection unreachable: ${message}`);
      }
      if (!response.ok) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, `introspection HTTP ${response.status}`);
      }
      const info = await response.json();
      if (info.active !== true) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "token is not active");
      }
      const matched = audienceValues(info.aud).find((value) => value.replace(/\/$/, "") === resourceUrl.href.replace(/\/$/, ""));
      const scopeList = String(info.scope ?? "")
        .split(/\s+/)
        .filter(Boolean);
      const fromUserInfo = await claimsFromUserInfo(userinfoEndpoint, token);
      const groups = [...new Set([...groupValues(info.groups), ...fromUserInfo.groups])];
      const capabilities = [...new Set([...groupValues(info.capabilities), ...fromUserInfo.capabilities])];
      return {
        token,
        clientId: String(info.client_id || info.sub || "tsidp"),
        scopes: scopeList,
        expiresAt: Number(info.exp),
        resource: matched ? new URL(matched) : undefined,
        extra: {
          sub: info.sub ?? null,
          username: info.username ?? null,
          email: info.email ?? null,
          groups,
          capabilities,
          iss: info.iss ?? null,
        },
      };
    },
  };
}

let oauthMetadata = await loadOAuthMetadata();
let oauthMetadataAt = Date.now();

async function currentOAuthMetadata() {
  if (Date.now() - oauthMetadataAt > 15_000) {
    oauthMetadata = await loadOAuthMetadata();
    oauthMetadataAt = Date.now();
  }
  return oauthMetadata;
}

const verifier = {
  async verifyAccessToken(token) {
    const metadata = await currentOAuthMetadata();
    const userinfoEndpoint = metadata.userinfo_endpoint || new URL("/userinfo", metadata.issuer).href;
    return createVerifier(metadata.introspection_endpoint, userinfoEndpoint).verifyAccessToken(token);
  },
};

const buildServer = (ctx) => {
  const auth = ctx.authInfo ?? {};
  const tools = allowedTools(auth);
  const server = new McpServer({ name: "shop-catalog", version: "1.0.0" });
  registerCatalogTools(server, new Set(tools));
  server.registerTool(
    "whoami",
    {
      description:
        "Show the Tailscale identity on this token, its read/write capability, and the catalog tools it can call.",
      inputSchema: z.object({}),
    },
    async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                clientId: auth.clientId ?? null,
                scopes: auth.scopes ?? [],
                expiresAt: auth.expiresAt ?? null,
                ...(auth.extra ?? {}),
                // The claim is reported above as tsidp sent it. This is what the
                // server actually applied, which differs when the claim is absent.
                capabilities: capabilityValues(auth.extra?.capabilities),
                tools,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
  return server;
};

const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
const auth = requireBearerAuth({
  verifier,
  requiredScopes: ["openid"],
  resourceMetadataUrl,
  expectedResource: resourceUrl,
});

const app = createMcpExpressApp({
  allowedHosts: ["127.0.0.1", "localhost", resourceUrl.hostname],
});
const inspector = inspectorPort ? createInspector() : null;

function metadata(res, body) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "no-store");
  res.json(body);
}

app.get("/.well-known/oauth-protected-resource/mcp", async (_req, res) => {
  const metadataDoc = await currentOAuthMetadata();
  metadata(res, {
    resource: resourceUrl.href,
    authorization_servers: [metadataDoc.issuer],
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
    resource_name: "Shop catalog",
  });
});

app.get("/.well-known/oauth-authorization-server", async (_req, res) => {
  metadata(res, await currentOAuthMetadata());
});

app.get("/health", async (_req, res) => {
  try {
    getPool().prepare("SELECT 1 AS ok").get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

const nodeHandler = toNodeHandler(createMcpHandler(buildServer));
const mcpHandler = (req, res) => {
  void nodeHandler(req, res, req.body);
};
if (inspector) app.all("/mcp", inspector.record(), auth, mcpHandler);
else app.all("/mcp", auth, mcpHandler);

function exitOnError(server) {
  server.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });
}

exitOnError(app.listen(port, "127.0.0.1", () => {
  console.log(`MCP URL: ${resourceUrl.href}`);
  console.log(`Listening on http://127.0.0.1:${port}/mcp`);
  console.log(`tsidp issuer: ${oauthMetadata.issuer}`);
  console.log(`Protected resource metadata: ${resourceMetadataUrl}`);
}));

if (inspector) {
  exitOnError(inspector.listen({ host: inspectorHost, port: inspectorPort }).on("listening", () => {
    console.log(`Call inspector: http://${inspectorHost}:${inspectorPort}/`);
  }));
}
