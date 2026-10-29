import { readFileSync } from "node:fs";
import express from "express";
import { allowedTools } from "./access.js";

const MAX_CALLS = 200;
const MAX_RESPONSE_CHARS = 16_000;
const REDACTED_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const page = readFileSync(new URL("./inspector.html", import.meta.url), "utf8");

// Tailscale encodes non-ASCII identity header values as RFC 2047 Q-encoding.
export function decodeRfc2047(value) {
  const text = String(value ?? "").trim();
  const match = /^=\?([^?]+)\?([bqBQ])\?([\s\S]*)\?=$/.exec(text);
  if (!match) return text;
  const [, charset, encoding, encoded] = match;
  if (!/^utf-8$/i.test(charset)) return text;
  if (encoding.toLowerCase() === "b") {
    return Buffer.from(encoded, "base64").toString("utf8");
  }
  const bytes = [];
  const normalized = encoded.replace(/_/g, " ");
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(normalized.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!REDACTED_HEADERS.has(name)) {
      out[name] = value;
      continue;
    }
    const text = String(value);
    const space = text.indexOf(" ");
    const scheme = space > 0 ? text.slice(0, space) : "";
    const secretLength = space > 0 ? text.length - space - 1 : text.length;
    out[name] = `${scheme ? `${scheme} ` : ""}<redacted, ${secretLength} chars>`;
  }
  return out;
}

/**
 * Serve sets Tailscale-Headers-Info whenever it writes the identity headers, after
 * deleting any the client sent. Without it, the headers came from the client as-is.
 */
function identityFrom(headers) {
  const login = decodeRfc2047(headers["tailscale-user-login"]);
  const name = decodeRfc2047(headers["tailscale-user-name"]);
  const profilePic = String(headers["tailscale-user-profile-pic"] ?? "").trim();
  const present = Boolean(login || name || profilePic);
  let source = "none";
  if (headers["tailscale-headers-info"]) source = "tailscale-serve";
  else if (present) source = "client";
  return { present, source, login: login || null, name: name || null, profilePic: profilePic || null };
}

function rpcSummary(body) {
  if (body == null || typeof body !== "object") return [];
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .map((msg) => ({
      id: msg?.id ?? null,
      method: msg?.method ?? (msg?.result !== undefined || msg?.error !== undefined ? "(response)" : null),
      tool: msg?.method === "tools/call" ? (msg.params?.name ?? null) : null,
      arguments: msg?.method === "tools/call" ? (msg.params?.arguments ?? {}) : undefined,
      client: msg?.method === "initialize" ? (msg.params?.clientInfo ?? null) : undefined,
    }))
    .filter((msg) => msg.method);
}

/** The person the server authenticated from the bearer, or null for the shared bearer and failed auth. */
function verifiedUser(auth) {
  if (!auth || auth.extra?.sub === "shared") return null;
  return auth.extra?.email || auth.extra?.username || auth.extra?.sub || null;
}

function credentialFrom(req) {
  if (!req.headers.authorization) return "none";
  if (!req.auth) return "rejected";
  return req.auth.extra?.sub === "shared" ? "shared bearer" : "tsidp token";
}

function captureResponse(res) {
  const chunks = [];
  let size = 0;
  const keep = (chunk) => {
    if (chunk == null || size >= MAX_RESPONSE_CHARS) return;
    const text = chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk);
    chunks.push(text.slice(0, MAX_RESPONSE_CHARS - size));
    size += text.length;
  };
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = (chunk, ...rest) => {
    keep(chunk);
    return write(chunk, ...rest);
  };
  res.end = (chunk, ...rest) => {
    if (typeof chunk !== "function") keep(chunk);
    return end(chunk, ...rest);
  };
  return () => {
    const text = chunks.join("");
    return size > MAX_RESPONSE_CHARS ? `${text}\n… truncated (${size} chars)` : text;
  };
}

export function createInspector() {
  const calls = [];
  const clients = new Set();
  let nextId = 1;

  function publish(call) {
    calls.push(call);
    if (calls.length > MAX_CALLS) calls.shift();
    const event = `data: ${JSON.stringify(call)}\n\n`;
    for (const client of clients) client.write(event);
  }

  /** Records every request to the route it is mounted on, including ones auth rejects. */
  function record(listenerFor) {
    return (req, res, next) => {
      const started = Date.now();
      const responseText = captureResponse(res);
      res.on("close", () => {
        const auth = req.auth;
        const identity = identityFrom(req.headers);
        const user = verifiedUser(auth);
        publish({
          id: nextId++,
          at: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          listener: listenerFor(req),
          remoteAddress: req.socket.remoteAddress ?? null,
          httpMethod: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          credential: credentialFrom(req),
          user,
          identity: {
            ...identity,
            mismatch: Boolean(user && identity.login && identity.login.toLowerCase() !== user.toLowerCase()),
          },
          auth: auth
            ? { sub: auth.extra?.sub ?? null, email: auth.extra?.email ?? null, groups: auth.extra?.groups ?? [], tools: allowedTools(auth) }
            : null,
          rpc: rpcSummary(req.body),
          headers: redactHeaders(req.headers),
          body: req.body ?? null,
          response: responseText(),
        });
      });
      next();
    };
  }

  function listen({ host, port }) {
    const app = express();
    app.get("/", (_req, res) => {
      res.type("html").send(page);
    });
    app.get("/api/calls", (_req, res) => {
      res.json(calls);
    });
    app.post("/api/clear", (_req, res) => {
      calls.length = 0;
      res.json({ ok: true });
    });
    app.get("/api/events", (req, res) => {
      res.set({ "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.flushHeaders();
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    });
    return app.listen(port, host);
  }

  return { record, listen, calls };
}
