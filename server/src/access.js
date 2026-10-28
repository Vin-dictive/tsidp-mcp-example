const CUSTOMER_TOOLS = ["list_customers", "get_customer", "search_customers"];
const PRODUCT_TOOLS = ["list_products", "search_products"];

/** Tailscale owner or admin. */
const ADMIN_TOOLS = [...CUSTOMER_TOOLS, ...PRODUCT_TOOLS, "whoami"];

/** Tailscale member. */
const MEMBER_TOOLS = [...PRODUCT_TOOLS, "whoami"];

/** Shared bearer, or a caller without a known group. */
const REDUCED_TOOLS = ["whoami"];

const ADMIN_GROUPS = new Set(["admin", "autogroup:admin", "owner", "autogroup:owner"]);
const MEMBER_GROUPS = new Set(["member", "autogroup:member"]);

export function groupValues(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

export function allowedTools(auth) {
  const groups = groupValues(auth?.extra?.groups);
  if (groups.some((group) => ADMIN_GROUPS.has(group))) return ADMIN_TOOLS;
  if (groups.some((group) => MEMBER_GROUPS.has(group))) return MEMBER_TOOLS;
  return REDUCED_TOOLS;
}
