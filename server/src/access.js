/**
 * Two independent claims decide the tool list.
 *
 * `groups` picks which data domains a caller sees. `capabilities` picks
 * whether they may read or also write inside those domains. Both are stamped
 * by the tailnet policy as tsidp extraClaims, so neither is listed here.
 */

/** Every catalog tool, its data domain, and whether calling it writes. */
const CATALOG_TOOLS = [
  { name: "list_customers", domain: "customers", access: "read" },
  { name: "get_customer", domain: "customers", access: "read" },
  { name: "search_customers", domain: "customers", access: "read" },
  { name: "update_customer", domain: "customers", access: "write" },
  { name: "list_products", domain: "products", access: "read" },
  { name: "search_products", domain: "products", access: "read" },
  { name: "upsert_product", domain: "products", access: "write" },
  { name: "list_orders", domain: "orders", access: "read" },
  { name: "get_order", domain: "orders", access: "read" },
  { name: "create_order", domain: "orders", access: "write" },
  { name: "update_order_status", domain: "orders", access: "write" },
];

/** Identity introspection. Always registered, so it is never gated. */
const ALWAYS_TOOLS = ["whoami"];

/** Tailscale owner or admin. */
const ADMIN_DOMAINS = ["customers", "products", "orders"];

/** Tailscale member. */
const MEMBER_DOMAINS = ["products"];

const ADMIN_GROUPS = new Set(["admin", "autogroup:admin", "owner", "autogroup:owner"]);
const MEMBER_GROUPS = new Set(["member", "autogroup:member"]);

const WRITE_TOOLS = new Set(CATALOG_TOOLS.filter((tool) => tool.access === "write").map((tool) => tool.name));

/** Lowercased, de-duplicated string list from a claim that may be absent, scalar, or an array. */
function claimValues(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

export const groupValues = claimValues;

/**
 * A token with no `capabilities` claim reads. Writing is never implicit: a
 * grant has to name it, so an unchanged tailnet policy cannot start writing.
 */
export function capabilityValues(value) {
  const list = claimValues(value);
  return list.length ? list : ["read"];
}

function domainsFor(groups) {
  if (groups.some((group) => ADMIN_GROUPS.has(group))) return ADMIN_DOMAINS;
  if (groups.some((group) => MEMBER_GROUPS.has(group))) return MEMBER_DOMAINS;
  return [];
}

export function allowedTools(auth) {
  const domains = new Set(domainsFor(groupValues(auth?.extra?.groups)));
  const capabilities = new Set(capabilityValues(auth?.extra?.capabilities));
  const granted = CATALOG_TOOLS.filter(
    (tool) => domains.has(tool.domain) && capabilities.has(tool.access),
  ).map((tool) => tool.name);
  return [...granted, ...ALWAYS_TOOLS].sort();
}

/** True when the tool list includes anything that writes, so the server opens a writer pool. */
export function needsWriter(tools) {
  return tools.some((name) => WRITE_TOOLS.has(name));
}

export function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}
