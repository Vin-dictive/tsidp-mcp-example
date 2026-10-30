-- Mock wholesale catalog. Applied once, the first time the database file is
-- opened and no customers table is found. Read tools hold a readOnly handle,
-- so they cannot run any of this.

CREATE TABLE customers (
  id integer PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  city text NOT NULL,
  state text NOT NULL
);

CREATE TABLE products (
  sku text PRIMARY KEY,
  name text NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0)
);

-- INTEGER PRIMARY KEY is the rowid, so create_order can insert without an id
-- and SQLite assigns max(id) + 1. No sequence to advance past the seed rows.
CREATE TABLE orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  status text NOT NULL CHECK (status IN ('paid', 'packed', 'shipped', 'cancelled')),
  ordered_on text NOT NULL
);

CREATE TABLE order_items (
  order_id integer NOT NULL REFERENCES orders (id),
  sku text NOT NULL REFERENCES products (sku),
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, sku)
);

INSERT INTO customers (id, name, email, city, state) VALUES
  (1, 'Northwind Cafe', 'orders@northwind.example', 'Portland', 'OR'),
  (2, 'Harbor & Rye', 'buyer@harbor-rye.example', 'Seattle', 'WA'),
  (3, 'Mesa Roasters', 'hello@mesa-roasters.example', 'Tucson', 'AZ'),
  (4, 'Lumen Grocery', 'receiving@lumen-grocery.example', 'Austin', 'TX'),
  (5, 'Kite & Co', 'kitchen@kite-co.example', 'Brooklyn', 'NY');

INSERT INTO products (sku, name, unit_price_cents) VALUES
  ('ETH-12', 'Ethiopia Guji, 12oz', 1850),
  ('COL-5', 'Colombia Huila, 5lb', 6400),
  ('ESP-2', 'House espresso blend, 2lb', 2800),
  ('DEC-8', 'Swiss Water decaf, 8oz', 1400),
  ('FIL-100', 'Unbleached filters, 100ct', 900),
  ('MUG-12', 'Diner mug, 12oz', 1600);

INSERT INTO orders (id, customer_id, status, ordered_on) VALUES
  (101, 1, 'shipped', '2026-09-02'),
  (102, 1, 'paid', '2026-10-18'),
  (103, 2, 'packed', '2026-10-20'),
  (104, 3, 'shipped', '2026-08-14'),
  (105, 3, 'cancelled', '2026-09-30'),
  (106, 4, 'paid', '2026-10-22'),
  (107, 5, 'shipped', '2026-07-11'),
  (108, 5, 'packed', '2026-10-25');

INSERT INTO order_items (order_id, sku, quantity) VALUES
  (101, 'ETH-12', 12),
  (101, 'FIL-100', 4),
  (102, 'ESP-2', 6),
  (102, 'DEC-8', 8),
  (103, 'COL-5', 3),
  (103, 'MUG-12', 24),
  (104, 'ETH-12', 20),
  (104, 'ESP-2', 10),
  (105, 'DEC-8', 6),
  (106, 'COL-5', 4),
  (106, 'FIL-100', 10),
  (106, 'MUG-12', 12),
  (107, 'ESP-2', 8),
  (107, 'ETH-12', 8),
  (108, 'COL-5', 2),
  (108, 'DEC-8', 12);
