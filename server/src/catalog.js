import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_LIMIT = 50;
const schemaSql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

let reader;
let writer;
let initialized = false;

function databasePath() {
  const path = process.env.DATABASE_PATH;
  if (!path) {
    throw new Error("DATABASE_PATH is not set");
  }
  return path;
}

/**
 * Creates and seeds the file the first time. A readOnly handle cannot open a
 * database that does not exist yet, so this always runs before either handle.
 */
function initialize() {
  if (initialized) return;
  const path = databasePath();
  if (path.includes("/")) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    // Persisted in the file, so the readOnly handle inherits it.
    db.exec("PRAGMA journal_mode = WAL");
    const present = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'customers'")
      .get();
    if (!present) db.exec(schemaSql);
  } finally {
    db.close();
  }
  initialized = true;
}

/**
 * Read handle. SQLite refuses any write on it, so a bug in a read tool cannot
 * modify data even when it is reached with a write caller's token.
 */
export function getPool() {
  initialize();
  reader ??= new DatabaseSync(databasePath(), { readOnly: true });
  return reader;
}

/** Write handle. Only the write tools reach for this. */
export function getWriterPool() {
  initialize();
  writer ??= new DatabaseSync(databasePath());
  return writer;
}

export async function closePool() {
  for (const db of [reader, writer]) db?.close();
  reader = undefined;
  writer = undefined;
  initialized = false;
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
  return getPool()
    .prepare(
      `SELECT id, name, email, city, state
       FROM customers
       ORDER BY id
       LIMIT $limit`,
    )
    .all({ limit: clampLimit(limit) });
}

export async function getCustomer({ id }) {
  return (
    getPool()
      .prepare(
        `SELECT id, name, email, city, state
         FROM customers
         WHERE id = $id`,
      )
      .get({ id }) ?? null
  );
}

export async function searchCustomers({ query, limit }) {
  return getPool()
    .prepare(
      `SELECT id, name, email, city, state
       FROM customers
       WHERE name  LIKE $pattern ESCAPE '\\'
          OR email LIKE $pattern ESCAPE '\\'
          OR city  LIKE $pattern ESCAPE '\\'
          OR state LIKE $pattern ESCAPE '\\'
       ORDER BY name
       LIMIT $limit`,
    )
    .all({ pattern: likePattern(query), limit: clampLimit(limit) });
}

export async function listProducts({ limit } = {}) {
  return getPool()
    .prepare(
      `SELECT sku, name, unit_price_cents
       FROM products
       ORDER BY sku
       LIMIT $limit`,
    )
    .all({ limit: clampLimit(limit) });
}

export async function searchProducts({ query, limit }) {
  return getPool()
    .prepare(
      `SELECT sku, name, unit_price_cents
       FROM products
       WHERE sku  LIKE $pattern ESCAPE '\\'
          OR name LIKE $pattern ESCAPE '\\'
       ORDER BY sku
       LIMIT $limit`,
    )
    .all({ pattern: likePattern(query), limit: clampLimit(limit) });
}

export async function listOrders({ customerId, status, limit } = {}) {
  return getPool()
    .prepare(
      `SELECT o.id, o.customer_id, c.name AS customer_name, o.status, o.ordered_on,
              COALESCE(SUM(oi.quantity * p.unit_price_cents), 0) AS total_cents
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products p ON p.sku = oi.sku
       WHERE ($customer_id IS NULL OR o.customer_id = $customer_id)
         AND ($status IS NULL OR o.status = $status)
       GROUP BY o.id, c.name
       ORDER BY o.ordered_on DESC, o.id DESC
       LIMIT $limit`,
    )
    .all({ customer_id: customerId ?? null, status: status ?? null, limit: clampLimit(limit) });
}

export async function getOrder({ id }) {
  const order = getPool()
    .prepare(
      `SELECT o.id, o.customer_id, c.name AS customer_name, c.email AS customer_email,
              o.status, o.ordered_on
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.id = $id`,
    )
    .get({ id });
  if (!order) return null;
  const items = getPool()
    .prepare(
      `SELECT oi.sku, p.name, oi.quantity, p.unit_price_cents,
              oi.quantity * p.unit_price_cents AS line_cents
       FROM order_items oi
       JOIN products p ON p.sku = oi.sku
       WHERE oi.order_id = $id
       ORDER BY oi.sku`,
    )
    .all({ id });
  const totalCents = items.reduce((sum, row) => sum + row.line_cents, 0);
  return { ...order, total_cents: totalCents, items };
}

export async function updateOrderStatus({ id, status }) {
  return (
    getWriterPool()
      .prepare(
        `UPDATE orders
         SET status = $status
         WHERE id = $id
         RETURNING id, customer_id, status, ordered_on`,
      )
      .get({ id, status }) ?? null
  );
}

export async function updateCustomer({ id, name, email, city, state }) {
  return (
    getWriterPool()
      .prepare(
        `UPDATE customers
         SET name  = COALESCE($name, name),
             email = COALESCE($email, email),
             city  = COALESCE($city, city),
             state = COALESCE($state, state)
         WHERE id = $id
         RETURNING id, name, email, city, state`,
      )
      .get({
        id,
        name: name ?? null,
        email: email ?? null,
        city: city ?? null,
        state: state ?? null,
      }) ?? null
  );
}

export async function upsertProduct({ sku, name, unitPriceCents }) {
  const db = getWriterPool();
  db.exec("BEGIN");
  try {
    // SQLite has no equivalent of Postgres' xmax trick, so the existence check
    // and the upsert share a transaction to keep `created` truthful.
    const existing = db.prepare("SELECT 1 AS present FROM products WHERE sku = $sku").get({ sku });
    const row = db
      .prepare(
        `INSERT INTO products (sku, name, unit_price_cents)
         VALUES ($sku, $name, $unit_price_cents)
         ON CONFLICT (sku) DO UPDATE
           SET name = excluded.name,
               unit_price_cents = excluded.unit_price_cents
         RETURNING sku, name, unit_price_cents`,
      )
      .get({ sku, name, unit_price_cents: unitPriceCents });
    db.exec("COMMIT");
    return { ...row, created: !existing };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Inserts the order and its line items in one transaction, so a bad SKU rolls the order back. */
export async function createOrder({ customerId, status, orderedOn, items }) {
  const db = getWriterPool();
  db.exec("BEGIN");
  try {
    const inserted = db
      .prepare(
        `INSERT INTO orders (customer_id, status, ordered_on)
         VALUES ($customer_id, $status, COALESCE($ordered_on, date('now')))`,
      )
      .run({ customer_id: customerId, status, ordered_on: orderedOn ?? null });
    const orderId = Number(inserted.lastInsertRowid);
    const addItem = db.prepare(
      `INSERT INTO order_items (order_id, sku, quantity)
       VALUES ($order_id, $sku, $quantity)
       ON CONFLICT (order_id, sku) DO UPDATE
         SET quantity = order_items.quantity + excluded.quantity`,
    );
    for (const item of items) {
      addItem.run({ order_id: orderId, sku: item.sku, quantity: item.quantity });
    }
    db.exec("COMMIT");
    return getOrder({ id: orderId });
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
