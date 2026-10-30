import * as z from "zod";
import * as catalog from "./catalog.js";

const limitSchema = z.number().int().min(1).max(50).optional();
const statusSchema = z.enum(["paid", "packed", "shipped", "cancelled"]);
const MAX_ITEMS = 50;

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
        status: statusSchema.optional(),
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

  if (permit("update_order_status")) server.registerTool(
    "update_order_status",
    {
      description: "Change one order's status. Requires the write capability.",
      inputSchema: z.object({
        id: z.number().int().positive(),
        status: statusSchema,
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ id, status }) => (await catalog.updateOrderStatus({ id, status })) ?? { found: false, id }),
  );

  if (permit("create_order")) server.registerTool(
    "create_order",
    {
      description:
        "Create an order for a customer with one or more line items. Requires the write capability.",
      inputSchema: z.object({
        customer_id: z.number().int().positive(),
        status: statusSchema.default("paid"),
        ordered_on: z.iso.date().optional(),
        items: z
          .array(z.object({ sku: z.string().min(1), quantity: z.number().int().positive() }))
          .min(1)
          .max(MAX_ITEMS),
      }),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    tool(({ customer_id, status, ordered_on, items }) =>
      catalog.createOrder({ customerId: customer_id, status, orderedOn: ordered_on, items }),
    ),
  );

  if (permit("upsert_product")) server.registerTool(
    "upsert_product",
    {
      description:
        "Create a product, or update its name and price if the SKU exists. Requires the write capability.",
      inputSchema: z.object({
        sku: z.string().min(1).max(32),
        name: z.string().min(1).max(200),
        unit_price_cents: z.number().int().min(0),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    tool(({ sku, name, unit_price_cents }) =>
      catalog.upsertProduct({ sku, name, unitPriceCents: unit_price_cents }),
    ),
  );

  if (permit("update_customer")) server.registerTool(
    "update_customer",
    {
      description:
        "Update a customer's contact fields. Omitted fields keep their current value. Requires the write capability.",
      inputSchema: z
        .object({
          id: z.number().int().positive(),
          name: z.string().min(1).max(200).optional(),
          email: z.email().optional(),
          city: z.string().min(1).max(100).optional(),
          state: z.string().min(1).max(100).optional(),
        })
        .refine(
          (value) => ["name", "email", "city", "state"].some((field) => value[field] !== undefined),
          { message: "give at least one field to change" },
        ),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ id, ...fields }) => (await catalog.updateCustomer({ id, ...fields })) ?? { found: false, id }),
  );
}
