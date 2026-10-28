import { DB_FILE, enableForeignKeys, sqlite } from "./client.js";

async function exec(statement: string) {
  await sqlite.execute(statement);
}

const FK_REBUILD_ORDER = [
  "product_making_tiers",
  "order_items",
  "returns",
  "return_items",
  "conversations",
  "credit_ledger_entries",
];

/**
 * Older renames left REFERENCES orders__old_fx (and the same for products,
 * accounts, scrap, returns). Foreign keys cannot be turned on until those
 * parents are the live tables. Rows are copied; ids stay the same.
 */
async function repairStaleForeignKeys() {
  await exec("PRAGMA foreign_keys = OFF");
  const found = await sqlite.execute(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%__old_fx%'",
  );
  const tables = found.rows
    .map((row) => ({
      name: String(row.name),
      sql: String(row.sql ?? ""),
    }))
    .filter((row) => /^[a-z_]+$/.test(row.name) && row.sql.includes("__old_fx"))
    .sort((a, b) => {
      const ai = FK_REBUILD_ORDER.indexOf(a.name);
      const bi = FK_REBUILD_ORDER.indexOf(b.name);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  for (const table of tables) {
    const indexes = await sqlite.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
      args: [table.name],
    });
    const temp = `${table.name}__fkfix`;
    const createSql = table.sql
      .replaceAll('"products__old_fx"', "products")
      .replaceAll('"orders__old_fx"', "orders")
      .replaceAll('"credit_accounts__old_fx"', "credit_accounts")
      .replaceAll('"scrap_submissions__old_fx"', "scrap_submissions")
      .replaceAll('"returns__old_fx"', "returns")
      .replaceAll("__old_fx", "")
      .replace(
        new RegExp(`CREATE TABLE\\s+"?${table.name}"?\\s*\\(`),
        `CREATE TABLE ${temp} (`,
      );
    await exec(`DROP TABLE IF EXISTS ${temp}`);
    await exec(createSql);
    await exec(`INSERT INTO ${temp} SELECT * FROM ${table.name}`);
    await exec(`DROP TABLE ${table.name}`);
    await exec(`ALTER TABLE ${temp} RENAME TO ${table.name}`);
    for (const index of indexes.rows) {
      const indexSql = String(index.sql ?? "");
      if (indexSql) await exec(indexSql);
    }
  }
}

async function ensureColumn(table: string, column: string, alterSql: string) {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) {
    throw new Error("Refusing to alter an unexpected identifier");
  }
  const info = await sqlite.execute(`PRAGMA table_info(${table})`);
  const names = info.rows.map((row) => String(row.name));
  if (!names.includes(column)) await exec(alterSql);
}

/**
 * Creates tables/indexes if missing (idempotent). Safe for every local boot.
 */
export async function initDatabase() {
  await exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT UNIQUE,
      password_hash TEXT,
      auth_user_id TEXT UNIQUE,
      role TEXT NOT NULL,
      full_name TEXT NOT NULL,
      business_name TEXT,
      country TEXT NOT NULL DEFAULT 'SY',
      city TEXT,
      address TEXT,
      verification_status TEXT NOT NULL DEFAULT 'pending',
      license_number TEXT,
      tax_id TEXT,
      id_document_path TEXT,
      license_document_path TEXT,
      avatar_path TEXT,
      verification_notes TEXT,
      rejection_reason TEXT,
      verified_at INTEGER,
      verified_by TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (role IN ('workshop', 'retailer', 'admin')),
      CHECK (verification_status IN ('pending', 'verified', 'rejected', 'suspended')),
      CHECK (country IN ('SY', 'LB'))
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY NOT NULL,
      workshop_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      name_ar TEXT,
      description TEXT,
      description_ar TEXT,
      sku TEXT,
      category TEXT NOT NULL DEFAULT 'other',
      karat INTEGER NOT NULL,
      weight_grams TEXT NOT NULL,
      making_charge_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      stock_qty INTEGER NOT NULL DEFAULT 0,
      image_path TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (workshop_id, sku),
      CHECK (karat IN (18, 21)),
      CHECK (making_charge_cents >= 0),
      CHECK (currency IN ('USD', 'SYP', 'LBP')),
      CHECK (stock_qty >= 0),
      CHECK (status IN ('draft', 'active', 'archived'))
    )
  `);

  // Migrate older local DBs
  try {
    await exec(`ALTER TABLE users ADD COLUMN country TEXT NOT NULL DEFAULT 'SY'`);
  } catch {
    // column already exists
  }

  try {
    await exec(`ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'other'`);
  } catch {
    // column already exists
  }
  try {
    await exec(`ALTER TABLE products ADD COLUMN name_ar TEXT`);
  } catch {
    // column already exists
  }
  try {
    await exec(`ALTER TABLE products ADD COLUMN description_ar TEXT`);
  } catch {
    // column already exists
  }
  try {
    await exec(`ALTER TABLE users ADD COLUMN avatar_path TEXT`);
  } catch {
    // column already exists
  }

  await exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY NOT NULL,
      retailer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      workshop_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      currency TEXT NOT NULL DEFAULT 'USD',
      fx_units_per_usd TEXT NOT NULL DEFAULT '1',
      gold_spot_price_cents_per_gram INTEGER NOT NULL,
      spot_locked_at INTEGER,
      spot_rate_id TEXT,
      spot_source TEXT,
      spot_official INTEGER,
      spot_verification_image_path TEXT,
      gold_value_cents INTEGER NOT NULL DEFAULT 0,
      making_charges_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      payment_proof_path TEXT,
      placed_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      fulfilled_at INTEGER,
      completed_at INTEGER,
      cancelled_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (status IN ('pending', 'confirmed', 'fulfilled', 'completed', 'cancelled')),
      CHECK (payment_status IN ('unpaid', 'partial', 'paid', 'refunded')),
      CHECK (currency IN ('USD', 'SYP', 'LBP')),
      CHECK (gold_spot_price_cents_per_gram > 0),
      CHECK (retailer_id <> workshop_id)
    )
  `);

  // Spot-lock columns for older local DBs
  for (const col of [
    `ALTER TABLE orders ADD COLUMN spot_locked_at INTEGER`,
    `ALTER TABLE orders ADD COLUMN spot_rate_id TEXT`,
    `ALTER TABLE orders ADD COLUMN spot_source TEXT`,
    `ALTER TABLE orders ADD COLUMN spot_official INTEGER`,
    `ALTER TABLE orders ADD COLUMN spot_verification_image_path TEXT`,
    `ALTER TABLE orders ADD COLUMN fx_units_per_usd TEXT NOT NULL DEFAULT '1'`,
    `ALTER TABLE orders ADD COLUMN idempotency_key TEXT`,
  ]) {
    try {
      await exec(col);
    } catch {
      // column already exists
    }
  }

  await exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS orders_retailer_idempotency_unique
     ON orders (retailer_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS product_making_tiers (
      id TEXT PRIMARY KEY NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      min_qty INTEGER NOT NULL,
      max_qty INTEGER,
      making_charge_cents INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (min_qty >= 1),
      CHECK (max_qty IS NULL OR max_qty >= min_qty),
      CHECK (making_charge_cents >= 0)
    )
  `);
  await exec(
    `CREATE INDEX IF NOT EXISTS product_making_tiers_product_id_idx ON product_making_tiers (product_id)`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      product_name TEXT NOT NULL,
      karat INTEGER NOT NULL,
      unit_weight_grams TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      purity_factor TEXT NOT NULL,
      unit_gold_value_cents INTEGER NOT NULL,
      unit_making_charge_cents INTEGER NOT NULL,
      making_tier_min_qty INTEGER,
      making_tier_max_qty INTEGER,
      line_gold_value_cents INTEGER NOT NULL,
      line_making_charge_cents INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (order_id, product_id),
      CHECK (karat IN (18, 21)),
      CHECK (quantity > 0)
    )
  `);

  for (const col of [
    `ALTER TABLE order_items ADD COLUMN making_tier_min_qty INTEGER`,
    `ALTER TABLE order_items ADD COLUMN making_tier_max_qty INTEGER`,
  ]) {
    try {
      await exec(col);
    } catch {
      // column already exists
    }
  }

  await exec(`
    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      retailer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      workshop_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'requested',
      reason TEXT NOT NULL,
      rejection_reason TEXT,
      currency TEXT NOT NULL DEFAULT 'USD',
      refund_cents INTEGER NOT NULL DEFAULT 0,
      requested_at INTEGER NOT NULL,
      decided_at INTEGER,
      received_at INTEGER,
      refunded_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (status IN ('requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled')),
      CHECK (currency IN ('USD', 'SYP', 'LBP')),
      CHECK (retailer_id <> workshop_id)
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS return_items (
      id TEXT PRIMARY KEY NOT NULL,
      return_id TEXT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
      order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL,
      weight_grams TEXT NOT NULL,
      refund_cents INTEGER NOT NULL DEFAULT 0,
      condition_notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (return_id, order_item_id),
      CHECK (quantity > 0)
    )
  `);

  await exec(`CREATE INDEX IF NOT EXISTS users_role_idx ON users (role)`);
  await exec(
    `CREATE INDEX IF NOT EXISTS users_verification_status_idx ON users (verification_status)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS products_workshop_id_idx ON products (workshop_id)`,
  );
  await exec(`CREATE INDEX IF NOT EXISTS products_status_idx ON products (status)`);
  await exec(
    `CREATE INDEX IF NOT EXISTS products_category_idx ON products (category)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS orders_retailer_id_idx ON orders (retailer_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS orders_workshop_id_idx ON orders (workshop_id)`,
  );
  await exec(`CREATE INDEX IF NOT EXISTS returns_order_id_idx ON returns (order_id)`);

  await exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      retailer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      workshop_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
      order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (retailer_id <> workshop_id)
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      message_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  await exec(
    `CREATE INDEX IF NOT EXISTS conversations_retailer_id_idx ON conversations (retailer_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS conversations_workshop_id_idx ON conversations (workshop_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages (conversation_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages (created_at)`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS conversation_reads (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS gold_spot_rates (
      id TEXT PRIMARY KEY NOT NULL,
      spot_cents_per_gram_fine INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      verification_image_path TEXT,
      notes TEXT,
      set_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      CHECK (spot_cents_per_gram_fine > 0),
      CHECK (currency IN ('USD', 'SYP', 'LBP'))
    )
  `);

  await exec(
    `CREATE INDEX IF NOT EXISTS gold_spot_rates_active_idx ON gold_spot_rates (is_active, created_at)`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS scrap_submissions (
      id TEXT PRIMARY KEY NOT NULL,
      retailer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      workshop_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'submitted',
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT,
      notes TEXT,
      estimated_weight_grams TEXT NOT NULL,
      estimated_karat INTEGER NOT NULL,
      assayed_weight_grams TEXT,
      assayed_karat INTEGER,
      gold_spot_price_cents_per_gram INTEGER,
      spot_locked_at INTEGER,
      spot_rate_id TEXT,
      spot_source TEXT,
      spot_official INTEGER,
      melt_value_cents INTEGER,
      refining_fee_cents INTEGER,
      net_value_cents INTEGER,
      quote_notes TEXT,
      rejection_reason TEXT,
      credit_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
      submitted_at INTEGER NOT NULL,
      quoted_at INTEGER,
      accepted_at INTEGER,
      settled_at INTEGER,
      cancelled_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (status IN ('submitted', 'quoted', 'accepted', 'declined', 'rejected', 'settled', 'cancelled')),
      CHECK (payment_status IN ('unpaid', 'paid', 'credited')),
      CHECK (currency IN ('USD', 'SYP', 'LBP')),
      CHECK (estimated_karat IN (14, 18, 21, 22, 24)),
      CHECK (assayed_karat IS NULL OR assayed_karat IN (14, 18, 21, 22, 24)),
      CHECK (retailer_id <> workshop_id)
    )
  `);

  await exec(
    `CREATE INDEX IF NOT EXISTS scrap_submissions_retailer_id_idx ON scrap_submissions (retailer_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS scrap_submissions_workshop_id_idx ON scrap_submissions (workshop_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS scrap_submissions_status_idx ON scrap_submissions (status)`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS credit_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      retailer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      workshop_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      currency TEXT NOT NULL DEFAULT 'USD',
      credit_limit_cents INTEGER,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (retailer_id, workshop_id, currency),
      CHECK (currency IN ('USD', 'SYP', 'LBP')),
      CHECK (retailer_id <> workshop_id)
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS credit_ledger_entries (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
      entry_type TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      balance_after_cents INTEGER NOT NULL,
      order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
      scrap_id TEXT REFERENCES scrap_submissions(id) ON DELETE SET NULL,
      note TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      CHECK (entry_type IN ('invoice', 'payment', 'scrap_credit', 'reversal', 'adjustment', 'refund')),
      CHECK (amount_cents <> 0)
    )
  `);

  await exec(
    `CREATE INDEX IF NOT EXISTS credit_accounts_retailer_id_idx ON credit_accounts (retailer_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS credit_accounts_workshop_id_idx ON credit_accounts (workshop_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS credit_ledger_entries_account_id_idx ON credit_ledger_entries (account_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS credit_ledger_entries_order_id_idx ON credit_ledger_entries (order_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS credit_ledger_entries_created_at_idx ON credit_ledger_entries (created_at)`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS fx_rates (
      id TEXT PRIMARY KEY NOT NULL,
      currency TEXT NOT NULL,
      units_per_usd TEXT NOT NULL,
      notes TEXT,
      set_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      CHECK (currency IN ('SYP', 'LBP'))
    )
  `);
  await exec(
    `CREATE INDEX IF NOT EXISTS fx_rates_active_idx ON fx_rates (currency, is_active, created_at)`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS stolen_reports (
      id TEXT PRIMARY KEY NOT NULL,
      reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL,
      description TEXT NOT NULL,
      weight_grams TEXT NOT NULL,
      karat INTEGER NOT NULL,
      photo_path TEXT NOT NULL,
      invoice_path TEXT,
      invoice_reference TEXT,
      incident_date TEXT NOT NULL,
      country TEXT NOT NULL,
      city TEXT NOT NULL,
      location TEXT,
      contact_name TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      recovered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (kind IN ('stolen', 'lost')),
      CHECK (karat IN (14, 18, 21, 22, 24)),
      CHECK (country IN ('SY', 'LB')),
      CHECK (status IN ('active', 'recovered'))
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS stolen_alerts (
      id TEXT PRIMARY KEY NOT NULL,
      report_id TEXT NOT NULL REFERENCES stolen_reports(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scrap_id TEXT REFERENCES scrap_submissions(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      seen_at INTEGER,
      created_at INTEGER NOT NULL,
      CHECK (kind IN ('registry', 'scrap'))
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS stolen_contact_opens (
      id TEXT PRIMARY KEY NOT NULL,
      report_id TEXT NOT NULL REFERENCES stolen_reports(id) ON DELETE CASCADE,
      opened_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    )
  `);
  await exec(
    `CREATE INDEX IF NOT EXISTS stolen_reports_match_idx ON stolen_reports (status, country, karat)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS stolen_alerts_recipient_idx ON stolen_alerts (recipient_id, seen_at)`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS archives (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      country TEXT,
      city TEXT,
      currency TEXT,
      amount_cents INTEGER,
      weight_grams TEXT,
      karat INTEGER,
      status TEXT NOT NULL,
      party_a TEXT,
      party_b TEXT,
      reason TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      archived_at INTEGER NOT NULL,
      archived_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      retention_until INTEGER NOT NULL,
      CHECK (kind IN ('stolen_report', 'scrap_intake', 'invoice', 'settlement')),
      CHECK (reason IN ('recovered', 'matched', 'completed', 'settled', 'manual')),
      UNIQUE (kind, source_id)
    )
  `);
  await exec(
    `CREATE INDEX IF NOT EXISTS archives_search_idx ON archives (kind, archived_at)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS archives_party_idx ON archives (party_a, party_b)`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY NOT NULL,
      recipient_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      title_ar TEXT,
      message_ar TEXT,
      reference_id TEXT,
      reference_kind TEXT,
      audience TEXT NOT NULL DEFAULT 'all',
      actor_id TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      CHECK (type IN ('STOLEN_ALERT', 'NEW_MEMBER', 'PROFILE_UPDATE', 'CREDIT_WARNING', 'ORDER_STATUS')),
      CHECK (audience IN ('all', 'trade', 'admin')),
      CHECK (reference_kind IS NULL OR reference_kind IN ('report', 'user', 'order', 'scrap', 'account'))
    )
  `);
  await exec(`
    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (notification_id, user_id)
    )
  `);
  await exec(
    `CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications (recipient_id, is_read, created_at)`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS support_inquiries (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await exec(
    `CREATE INDEX IF NOT EXISTS support_inquiries_user_idx ON support_inquiries (user_id, created_at)`,
  );

  const scrapDef = await sqlite.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scrap_submissions'",
  );
  const scrapSql = String(scrapDef.rows[0]?.sql ?? "");
  if (scrapSql.includes("orders__old_fx")) {
    await exec("PRAGMA foreign_keys = OFF");
    await exec(`
      CREATE TABLE scrap_submissions__fixed (
        id TEXT PRIMARY KEY NOT NULL,
        retailer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        workshop_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'submitted',
        payment_status TEXT NOT NULL DEFAULT 'unpaid',
        currency TEXT NOT NULL DEFAULT 'USD',
        description TEXT,
        notes TEXT,
        estimated_weight_grams TEXT NOT NULL,
        estimated_karat INTEGER NOT NULL,
        assayed_weight_grams TEXT,
        assayed_karat INTEGER,
        gold_spot_price_cents_per_gram INTEGER,
        spot_locked_at INTEGER,
        spot_rate_id TEXT,
        spot_source TEXT,
        spot_official INTEGER,
        melt_value_cents INTEGER,
        refining_fee_cents INTEGER,
        net_value_cents INTEGER,
        quote_notes TEXT,
        rejection_reason TEXT,
        credit_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
        submitted_at INTEGER NOT NULL,
        quoted_at INTEGER,
        accepted_at INTEGER,
        settled_at INTEGER,
        cancelled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (status IN ('submitted', 'quoted', 'accepted', 'declined', 'rejected', 'settled', 'cancelled')),
        CHECK (payment_status IN ('unpaid', 'paid', 'credited')),
        CHECK (currency IN ('USD', 'SYP', 'LBP')),
        CHECK (estimated_karat IN (14, 18, 21, 22, 24)),
        CHECK (assayed_karat IS NULL OR assayed_karat IN (14, 18, 21, 22, 24)),
        CHECK (retailer_id <> workshop_id)
      )
    `);
    await exec(`
      INSERT INTO scrap_submissions__fixed (
        id, retailer_id, workshop_id, status, payment_status, currency, description, notes,
        estimated_weight_grams, estimated_karat, assayed_weight_grams, assayed_karat,
        gold_spot_price_cents_per_gram, spot_locked_at, spot_rate_id, spot_source, spot_official,
        melt_value_cents, refining_fee_cents, net_value_cents, quote_notes, rejection_reason,
        credit_order_id, submitted_at, quoted_at, accepted_at, settled_at, cancelled_at,
        created_at, updated_at
      )
      SELECT
        id, retailer_id, workshop_id, status, payment_status, currency, description, notes,
        estimated_weight_grams, estimated_karat, assayed_weight_grams, assayed_karat,
        gold_spot_price_cents_per_gram, spot_locked_at, spot_rate_id, spot_source, spot_official,
        melt_value_cents, refining_fee_cents, net_value_cents, quote_notes, rejection_reason,
        credit_order_id, submitted_at, quoted_at, accepted_at, settled_at, cancelled_at,
        created_at, updated_at
      FROM scrap_submissions
    `);
    await exec("DROP TABLE scrap_submissions");
    await exec("ALTER TABLE scrap_submissions__fixed RENAME TO scrap_submissions");
    await exec(
      `CREATE INDEX IF NOT EXISTS scrap_submissions_retailer_id_idx ON scrap_submissions (retailer_id)`,
    );
    await exec(
      `CREATE INDEX IF NOT EXISTS scrap_submissions_workshop_id_idx ON scrap_submissions (workshop_id)`,
    );
    await exec(
      `CREATE INDEX IF NOT EXISTS scrap_submissions_status_idx ON scrap_submissions (status)`,
    );
  }

  await repairStaleForeignKeys();
  await ensureColumn(
    "credit_ledger_entries",
    "idempotency_key",
    "ALTER TABLE credit_ledger_entries ADD COLUMN idempotency_key TEXT",
  );
  await ensureColumn(
    "scrap_submissions",
    "settlement_idempotency_key",
    "ALTER TABLE scrap_submissions ADD COLUMN settlement_idempotency_key TEXT",
  );
  await ensureColumn(
    "users",
    "session_version",
    "ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "stolen_contact_opens",
    "action",
    "ALTER TABLE stolen_contact_opens ADD COLUMN action TEXT NOT NULL DEFAULT 'contact'",
  );
  await exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_idempotency_unique ON credit_ledger_entries (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  );
  await exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS scrap_settlement_idempotency_unique ON scrap_submissions (settlement_idempotency_key) WHERE settlement_idempotency_key IS NOT NULL`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS stolen_contact_opens_actor_idx ON stolen_contact_opens (opened_by, action, created_at)`,
  );

  await exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  await exec(
    `CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at)`,
  );

  await enableForeignKeys();
  const fk = await sqlite.execute("PRAGMA foreign_keys");
  const enabled = Number(fk.rows[0]?.foreign_keys ?? 0);
  if (enabled !== 1) {
    throw new Error("SQLite foreign_keys pragma did not turn on");
  }
  const violations = await sqlite.execute("PRAGMA foreign_key_check");
  if (violations.rows.length > 0) {
    console.error(violations.rows);
    throw new Error("SQLite foreign key check failed after schema repair");
  }

  console.log(`SQLite ready: ${DB_FILE}`);
}
