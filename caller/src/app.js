import { timingSafeEqual } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod";
import { allowedTools } from "../../server/src/access.js";
import { registerCatalogTools } from "../../server/src/tools.js";
import { callerFromHeaders } from "./identity.js";

function bearerMatches(token) {
  const expected = process.env.CALLER_TOKEN;
  if (!expected || !token) return false;
  const got = Buffer.from(token);
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

function unauthorized(res) {
  res.set("WWW-Authenticate", "Bearer");
  res.status(401).json({ error: "invalid_token" });
}

export function buildApp() {
  const app = createMcpExpressApp({
    allowedHosts: ["127.0.0.1", "localhost", "mac-muon.taila6207e.ts.net", "100.78.230.18"],
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const nodeHandler = toNodeHandler(
    createMcpHandler((ctx) => {
      const headers = ctx.requestInfo?.headers;
      const headerObject = headers && typeof headers.entries === "function"
        ? Object.fromEntries(headers.entries())
        : (headers ?? {});
      const caller = callerFromHeaders(headerObject);
      const tools = allowedTools({ extra: { groups: caller.groups } });
      console.log(
        `caller login=${caller.login ?? ""} groups=${caller.groups.length ? caller.groups.join(",") : "-"} tools=${tools.length}`,
      );
      const server = new McpServer({ name: "caller-catalog", version: "1.0.0" });
      registerCatalogTools(server, new Set(tools));
      server.registerTool(
        "whoami",
        {
          description: "Show the Tailscale caller Aperture sent with this request, and the tools that identity can call.",
          inputSchema: z.object({}),
        },
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  login: caller.login,
                  name: caller.name,
                  profilePic: caller.profilePic,
                  groups: caller.groups,
                  tools,
                },
                null,
                2,
              ),
            },
          ],
        }),
      );
      return server;
    }),
  );

  app.all("/mcp", (req, res) => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!bearerMatches(token)) {
      unauthorized(res);
      return;
    }
    void nodeHandler(req, res, req.body);
  });

  return app;
}
