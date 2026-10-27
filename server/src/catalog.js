import pg from "pg";

const MAX_LIMIT = 50;

let pool;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new pg.Pool({ connectionString, max: 5 });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

function clampLimit(value) {
  const n = Number(value ?? 20);
  if (!Number.isInteger(n) || n < 1) return 20;
  return Math.min(n, MAX_LIMIT);
}

function likePattern(query) {
  const escaped = String(query).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

export async function listCustomers({ limit } = {}) {
  const { rows } = await getPool().query(
    `SELECT id, name, email, city, state
     FROM customers
     ORDER BY id
     LIMIT $1`,
    [clampLimit(limit)],
  );
  return rows;
}

export async function getCustomer({ id }) {
  const { rows } = await getPool().query(
    `SELECT id, name, email, city, state
     FROM customers
     WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function searchCustomers({ query, limit }) {
  const { rows } = await getPool().query(
    `SELECT id, name, email, city, state
     FROM customers
     WHERE name ILIKE $1 ESCAPE '\\'
        OR email ILIKE $1 ESCAPE '\\'
        OR city ILIKE $1 ESCAPE '\\'
        OR state ILIKE $1 ESCAPE '\\'
     ORDER BY name
     LIMIT $2`,
    [likePattern(query), clampLimit(limit)],
  );
  return rows;
}

export async function listProducts({ limit } = {}) {
  const { rows } = await getPool().query(
    `SELECT sku, name, unit_price_cents
     FROM products
     ORDER BY sku
     LIMIT $1`,
    [clampLimit(limit)],
  );
  return rows;
}

export async function searchProducts({ query, limit }) {
  const { rows } = await getPool().query(
    `SELECT sku, name, unit_price_cents
     FROM products
     WHERE sku ILIKE $1 ESCAPE '\\'
        OR name ILIKE $1 ESCAPE '\\'
     ORDER BY sku
     LIMIT $2`,
    [likePattern(query), clampLimit(limit)],
  );
  return rows;
}

export async function listOrders({ customerId, status, limit } = {}) {
  const { rows } = await getPool().query(
    `SELECT o.id, o.customer_id, c.name AS customer_name, o.status, o.ordered_on::text AS ordered_on,
            COALESCE(SUM(oi.quantity * p.unit_price_cents), 0)::int AS total_cents
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN products p ON p.sku = oi.sku
     WHERE ($1::int IS NULL OR o.customer_id = $1)
       AND ($2::text IS NULL OR o.status = $2)
     GROUP BY o.id, c.name
     ORDER BY o.ordered_on DESC, o.id DESC
     LIMIT $3`,
    [customerId ?? null, status ?? null, clampLimit(limit)],
  );
  return rows;
}

export async function getOrder({ id }) {
  const orderResult = await getPool().query(
    `SELECT o.id, o.customer_id, c.name AS customer_name, c.email AS customer_email,
            o.status, o.ordered_on::text AS ordered_on
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [id],
  );
  const order = orderResult.rows[0];
  if (!order) return null;
  const items = await getPool().query(
    `SELECT oi.sku, p.name, oi.quantity, p.unit_price_cents,
            (oi.quantity * p.unit_price_cents)::int AS line_cents
     FROM order_items oi
     JOIN products p ON p.sku = oi.sku
     WHERE oi.order_id = $1
     ORDER BY oi.sku`,
    [id],
  );
  const totalCents = items.rows.reduce((sum, row) => sum + row.line_cents, 0);
  return { ...order, total_cents: totalCents, items: items.rows };
}
