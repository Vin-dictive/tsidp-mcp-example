import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { allowedTools } from "../../server/src/access.js";
import { buildApp } from "./app.js";
import { callerFromHeaders, decodeRfc2047 } from "./identity.js";

function sameTools(actual, expected) {
  const left = [...actual].sort().join(",");
  const right = [...expected].sort().join(",");
  if (left !== right) throw new Error(`tools ${left} != ${right}`);
}

if (decodeRfc2047("=?utf-8?q?Vinay_Valson?=") !== "Vinay Valson") {
  throw new Error("rfc2047 decode failed");
}

const captured = callerFromHeaders({
  "tailscale-user-login": "vinay.valson@gmail.com",
  "tailscale-user-name": "Vinay Valson",
  "tailscale-user-profile-pic": "https://example.invalid/pic",
});
if (captured.login !== "vinay.valson@gmail.com" || captured.groups.length !== 0) {
  throw new Error(`captured caller parsed wrong: ${JSON.stringify(captured)}`);
}
sameTools(allowedTools({ extra: { groups: captured.groups } }), ["whoami"]);
sameTools(allowedTools({ extra: { groups: ["owner"] } }), [
  "get_customer",
  "list_customers",
  "list_products",
  "search_customers",
  "search_products",
  "whoami",
]);
sameTools(allowedTools({ extra: { groups: ["member"] } }), ["list_products", "search_products", "whoami"]);

const app = buildApp();
const httpServer = await new Promise((resolve) => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
});
const address = httpServer.address();
const url = new URL(`http://127.0.0.1:${address.port}/mcp`);

async function connect(headers) {
  const client = new Client({ name: "caller-verify", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

const auth = { authorization: `Bearer ${process.env.CALLER_TOKEN}` };
const client = await connect({
  ...auth,
  "tailscale-user-login": "vinay.valson@gmail.com",
  "tailscale-user-name": "Vinay Valson",
});
const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
sameTools(names, ["whoami"]);
const who = await client.callTool({ name: "whoami", arguments: {} });
const text = who.content.find((item) => item.type === "text")?.text ?? "";
const doc = JSON.parse(text);
if (doc.login !== "vinay.valson@gmail.com") throw new Error(`whoami login ${doc.login}`);
if (doc.name !== "Vinay Valson") throw new Error(`whoami name ${doc.name}`);
if (doc.groups.length !== 0) throw new Error(`whoami groups ${doc.groups}`);
sameTools(doc.tools, ["whoami"]);
console.log(`whoami ok: ${JSON.stringify({ login: doc.login, name: doc.name, groups: doc.groups, tools: doc.tools })}`);
await client.close();

const denied = await fetch(url, { method: "POST" });
if (denied.status !== 401) throw new Error(`missing bearer status ${denied.status}`);
console.log("bearer required ok");

await new Promise((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
