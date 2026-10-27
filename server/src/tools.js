import * as z from "zod";
import * as catalog from "./catalog.js";

const limitSchema = z.number().int().min(1).max(50).optional();

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function tool(fn) {
  return async (args) => {
    try {
      return ok(await fn(args ?? {}));
    } catch (err) {
      const message = err instanceof Error ? err.message : "query failed";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}

export function registerCatalogTools(server, allowed) {
  const permit = (name) => allowed == null || allowed.has(name);

  if (permit("list_customers")) server.registerTool(
    "list_customers",
    {
      description: "List customers in the shop catalog.",
      inputSchema: z.object({ limit: limitSchema }),
    },
    tool(({ limit }) => catalog.listCustomers({ limit })),
  );

  if (permit("get_customer")) server.registerTool(
    "get_customer",
    {
      description: "Get one customer by numeric id.",
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    tool(async ({ id }) => (await catalog.getCustomer({ id })) ?? { found: false, id }),
  );

  if (permit("search_customers")) server.registerTool(
    "search_customers",
    {
      description: "Search customers by name, email, city, or state.",
      inputSchema: z.object({ query: z.string().min(1), limit: limitSchema }),
    },
    tool(({ query, limit }) => catalog.searchCustomers({ query, limit })),
  );

  if (permit("list_products")) server.registerTool(
    "list_products",
    {
      description: "List products and their prices in cents.",
      inputSchema: z.object({ limit: limitSchema }),
    },
    tool(({ limit }) => catalog.listProducts({ limit })),
  );

  if (permit("search_products")) server.registerTool(
    "search_products",
    {
      description: "Search products by SKU or name.",
      inputSchema: z.object({ query: z.string().min(1), limit: limitSchema }),
    },
    tool(({ query, limit }) => catalog.searchProducts({ query, limit })),
  );

  if (permit("list_orders")) server.registerTool(
    "list_orders",
    {
      description: "List orders, optionally filtered by customer id or status (paid, packed, shipped, cancelled).",
      inputSchema: z.object({
        customer_id: z.number().int().positive().optional(),
        status: z.enum(["paid", "packed", "shipped", "cancelled"]).optional(),
        limit: limitSchema,
      }),
    },
    tool(({ customer_id, status, limit }) => catalog.listOrders({ customerId: customer_id, status, limit })),
  );

  if (permit("get_order")) server.registerTool(
    "get_order",
    {
      description: "Get one order, including its line items and total in cents.",
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    tool(async ({ id }) => (await catalog.getOrder({ id })) ?? { found: false, id }),
  );
}
