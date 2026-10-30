import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { allowedTools, isWriteTool, needsWriter } from "./access.js";
import * as catalog from "./catalog.js";
import { registerCatalogTools } from "./tools.js";

// A throwaway database, seeded from schema.sql on first open. Nothing external
// is needed to run this, and the write checks below cannot disturb real data.
const scratch = mkdtempSync(join(tmpdir(), "shop-verify-"));
process.env.DATABASE_PATH = join(scratch, "shop.db");

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
  "create_order",
  "get_customer",
  "get_order",
  "list_customers",
  "list_orders",
  "list_products",
  "search_customers",
  "search_products",
  "update_customer",
  "update_order_status",
  "upsert_product",
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
const ADMIN_READ = [
  "get_customer",
  "get_order",
  "list_customers",
  "list_orders",
  "list_products",
  "search_customers",
  "search_products",
  "whoami",
];
const ADMIN_WRITE = [...ADMIN_READ, "create_order", "update_customer", "update_order_status", "upsert_product"];

// groups pick the domains. owner or admin wins when both tiers match.
sameTools(allowedTools({ extra: { groups: ["autogroup:owner", "member"] } }), ADMIN_READ);
sameTools(allowedTools({ extra: { groups: ["admin"] } }), ADMIN_READ);
sameTools(allowedTools({ extra: { groups: ["member"] } }), ["list_products", "search_products", "whoami"]);
sameTools(allowedTools({ extra: { groups: [] } }), ["whoami"]);

// An absent capabilities claim reads, so the tool set matches an explicit read.
sameTools(allowedTools({ extra: { groups: ["admin"], capabilities: [] } }), ADMIN_READ);
sameTools(allowedTools({ extra: { groups: ["admin"], capabilities: ["read"] } }), ADMIN_READ);

// capabilities pick read versus write inside those domains.
sameTools(allowedTools({ extra: { groups: ["admin"], capabilities: ["read", "write"] } }), ADMIN_WRITE);
sameTools(allowedTools({ extra: { groups: ["autogroup:admin"], capabilities: ["WRITE", " read "] } }), ADMIN_WRITE);
sameTools(allowedTools({ extra: { groups: ["member"], capabilities: ["read", "write"] } }), [
  "list_products",
  "search_products",
  "upsert_product",
  "whoami",
]);

// write alone grants no read tools, and no group still means no data domains.
sameTools(allowedTools({ extra: { groups: ["member"], capabilities: ["write"] } }), ["upsert_product", "whoami"]);
sameTools(allowedTools({ extra: { groups: [], capabilities: ["read", "write"] } }), ["whoami"]);
console.log("tool policy ok");

for (const write of ["create_order", "update_customer", "update_order_status", "upsert_product"]) {
  if (!isWriteTool(write)) throw new Error(`${write} is not categorized as a write tool`);
}
for (const read of ["list_customers", "get_order", "search_products", "whoami"]) {
  if (isWriteTool(read)) throw new Error(`${read} is categorized as a write tool`);
}
if (needsWriter(ADMIN_READ)) throw new Error("read-only tool set asked for the writer pool");
if (!needsWriter(ADMIN_WRITE)) throw new Error("write tool set did not ask for the writer pool");
console.log("capability split ok");

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
const limitedClient = new Client({ name: "shop-verify-member", version: "1.0.0" });
await limitedClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${limitedPort}/mcp`)));
const memberTools = (await limitedClient.listTools()).tools.map((tool) => tool.name).sort();
sameTools(memberTools, ["list_products", "search_products"]);
const products = JSON.parse(textOf(await limitedClient.callTool({ name: "list_products", arguments: {} })));
if (!products.some((row) => row.sku === "ETH-12")) throw new Error("member list_products missed ETH-12");
let ordersDenied = false;
try {
  const denied = await limitedClient.callTool({ name: "list_orders", arguments: {} });
  ordersDenied = denied.isError === true;
} catch {
  ordersDenied = true;
}
if (!ordersDenied) throw new Error("member list_orders was allowed");
console.log("member tool filter ok");
await limitedClient.close();
await new Promise((resolve, reject) => limitedHttp.close((err) => (err ? reject(err) : resolve())));

await client.close();
await new Promise((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));

// The write tools, against the writer handle.
const created = await catalog.createOrder({
  customerId: 2,
  status: "paid",
  orderedOn: "2026-10-30",
  items: [{ sku: "ETH-12", quantity: 3 }, { sku: "MUG-12", quantity: 2 }],
});
if (created.id <= 108) throw new Error(`create_order reused a seed id: ${created.id}`);
if (created.total_cents !== 3 * 1850 + 2 * 1600) throw new Error(`create_order total ${created.total_cents}`);
const moved = await catalog.updateOrderStatus({ id: created.id, status: "packed" });
if (moved.status !== "packed") throw new Error("update_order_status did not take");
if (await catalog.updateOrderStatus({ id: 9999, status: "paid" })) {
  throw new Error("update_order_status invented a missing order");
}

const newProduct = await catalog.upsertProduct({ sku: "TEST-1", name: "Test roast", unitPriceCents: 1234 });
if (newProduct.created !== true) throw new Error("upsert_product did not report an insert");
const sameProduct = await catalog.upsertProduct({ sku: "TEST-1", name: "Test roast v2", unitPriceCents: 4321 });
if (sameProduct.created !== false) throw new Error("upsert_product did not report an update");
if (sameProduct.unit_price_cents !== 4321) throw new Error("upsert_product kept the old price");

const edited = await catalog.updateCustomer({ id: 1, city: "Eugene" });
if (edited.city !== "Eugene" || edited.name !== "Northwind Cafe") {
  throw new Error("update_customer did not apply a partial change");
}
console.log(`write tools ok: order ${created.id}, product TEST-1, customer 1`);

// The read handle must refuse writes even though the file is writable.
let readOnlyEnforced = false;
try {
  catalog.getPool().prepare("UPDATE customers SET city = 'nope' WHERE id = 1").run();
} catch {
  readOnlyEnforced = true;
}
if (!readOnlyEnforced) throw new Error("the readOnly handle accepted a write");
console.log("read handle is read-only ok");

await catalog.closePool();
rmSync(scratch, { recursive: true, force: true });
