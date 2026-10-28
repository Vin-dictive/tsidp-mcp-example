import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { allowedTools } from "./access.js";
import * as catalog from "./catalog.js";
import { registerCatalogTools } from "./tools.js";

function textOf(result) {
  const block = result.content?.find((item) => item.type === "text");
  return block?.text ?? "";
}

const customers = await catalog.listCustomers();
const order = await catalog.getOrder({ id: 103 });
if (!customers.some((row) => row.name === "Northwind Cafe")) {
  throw new Error("seed data missing Northwind Cafe");
}
if (!order || order.customer_name !== "Harbor & Rye") {
  throw new Error("order 103 did not resolve to Harbor & Rye");
}
console.log(`catalog ok: ${customers.length} customers, order 103 total_cents=${order.total_cents}`);

const app = createMcpExpressApp();
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "shop-catalog", version: "1.0.0" });
  registerCatalogTools(server);
  return server;
});
const nodeHandler = toNodeHandler(handler);
app.all("/mcp", (req, res) => {
  void nodeHandler(req, res, req.body);
});

const httpServer = await new Promise((resolve) => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
});
const address = httpServer.address();
const url = new URL(`http://127.0.0.1:${address.port}/mcp`);

const client = new Client({ name: "shop-verify", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));
const listed = await client.listTools();
const names = listed.tools.map((tool) => tool.name).sort();
const expected = [
  "get_customer",
  "get_order",
  "list_customers",
  "list_orders",
  "list_products",
  "search_customers",
  "search_products",
];
for (const name of expected) {
  if (!names.includes(name)) throw new Error(`missing tool ${name}`);
}
const listedCustomers = JSON.parse(textOf(await client.callTool({ name: "list_customers", arguments: {} })));
const mesa = JSON.parse(textOf(await client.callTool({ name: "search_customers", arguments: { query: "Tucson" } })));
const packed = JSON.parse(textOf(await client.callTool({ name: "list_orders", arguments: { status: "packed" } })));
if (!listedCustomers.some((row) => row.name === "Kite & Co")) throw new Error("list_customers missing Kite & Co");
if (mesa.length !== 1 || mesa[0].name !== "Mesa Roasters") throw new Error("search_customers missed Mesa Roasters");
if (!packed.some((row) => row.id === 108)) throw new Error("list_orders missed packed order 108");
console.log(`mcp tools ok: ${names.join(", ")}`);

function sameTools(actual, expected) {
  const left = [...actual].sort().join(",");
  const right = [...expected].sort().join(",");
  if (left !== right) throw new Error(`tool policy ${left} != ${right}`);
}
sameTools(allowedTools({ extra: { sub: "shared", groups: [] } }), ["whoami"]);
sameTools(allowedTools({ extra: { groups: ["autogroup:owner", "member"] } }), [
  "get_customer",
  "list_customers",
  "list_products",
  "search_customers",
  "search_products",
  "whoami",
]);
sameTools(allowedTools({ extra: { groups: ["admin"] } }), [
  "get_customer",
  "list_customers",
  "list_products",
  "search_customers",
  "search_products",
  "whoami",
]);
sameTools(allowedTools({ extra: { groups: ["member"] } }), [
  "list_products",
  "search_products",
  "whoami",
]);
sameTools(allowedTools({ extra: { groups: [] } }), ["whoami"]);
console.log("tool policy ok");

const limitedApp = createMcpExpressApp();
const limitedHandler = toNodeHandler(
  createMcpHandler(() => {
    const server = new McpServer({ name: "shop-catalog", version: "1.0.0" });
    registerCatalogTools(server, new Set(allowedTools({ extra: { groups: ["member"] } })));
    return server;
  }),
);
limitedApp.all("/mcp", (req, res) => {
  void limitedHandler(req, res, req.body);
});
const limitedHttp = await new Promise((resolve) => {
  const server = limitedApp.listen(0, "127.0.0.1", () => resolve(server));
});
const limitedPort = limitedHttp.address().port;
const limitedClient = new Client({ name: "shop-verify-vinnie", version: "1.0.0" });
await limitedClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${limitedPort}/mcp`)));
const vinnieTools = (await limitedClient.listTools()).tools.map((tool) => tool.name).sort();
sameTools(vinnieTools, ["list_products", "search_products"]);
const products = JSON.parse(textOf(await limitedClient.callTool({ name: "list_products", arguments: {} })));
if (!products.some((row) => row.sku === "ETH-12")) throw new Error("vinnie list_products missed ETH-12");
let ordersDenied = false;
try {
  const denied = await limitedClient.callTool({ name: "list_orders", arguments: {} });
  ordersDenied = denied.isError === true;
} catch {
  ordersDenied = true;
}
if (!ordersDenied) throw new Error("vinnie list_orders was allowed");
console.log("vinnie tool filter ok");
await limitedClient.close();
await new Promise((resolve, reject) => limitedHttp.close((err) => (err ? reject(err) : resolve())));

await client.close();
await new Promise((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
await catalog.closePool();
