const CUSTOMER_TOOLS = ["list_customers", "get_customer", "search_customers"];
const PRODUCT_TOOLS = ["list_products", "search_products"];
const ORDER_TOOLS = ["list_orders", "get_order"];

/** shopshared. Orders are included only for this credential. */
export const SHARED_TOOLS = [...CUSTOMER_TOOLS, ...PRODUCT_TOOLS, ...ORDER_TOOLS, "whoami"];

/** Tailscale owner or admin, via shopuser. */
const ADMIN_TOOLS = [...CUSTOMER_TOOLS, ...PRODUCT_TOOLS, "whoami"];

/** Tailscale member, via shopuser. */
const MEMBER_TOOLS = [...PRODUCT_TOOLS, "whoami"];

const ADMIN_GROUPS = new Set(["admin", "autogroup:admin", "owner", "autogroup:owner"]);
const MEMBER_GROUPS = new Set(["member", "autogroup:member"]);

export function groupValues(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

export function allowedTools(auth) {
  const extra = auth?.extra ?? {};
  if (extra.sub === "shared") return SHARED_TOOLS;
  const groups = groupValues(extra.groups);
  if (groups.some((group) => ADMIN_GROUPS.has(group))) return ADMIN_TOOLS;
  if (groups.some((group) => MEMBER_GROUPS.has(group))) return MEMBER_TOOLS;
  return ["whoami"];
}
