// From backend: node scripts/product-images.cjs audit-applied|restore-dry-run|restore
// Audit and dry-run issue SELECT statements only. Restore never changes prices.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../../image-migration/archive/final-20261017');
const originalSha256 = 'f4e910dbb9ad80904e3d42289f7bed0d661c187d86eaf954021be71a2f4a6548';
const productIds = Array.from({ length: 21 }, (_, index) => index + 1);
const modes = ['audit-applied', 'restore-dry-run', 'restore'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

function assertIds(rows, label) {
  assert.ok(Array.isArray(rows), `${label} must be an array`);
  assert.equal(rows.length, 21, `${label} must contain exactly 21 products`);
  assert.deepEqual(rows.map(row => row.product_id).sort((a, b) => a - b), productIds, `${label} product IDs changed`);
}

function getPlan() {
  const plan = read('final-plan.json');
  assert.equal(plan.version, 3);
  assert.equal(plan.backup_path, 'original-products.json');
  assert.equal(plan.manifest_path, 'manifest.json');
  const backupBytes = fs.readFileSync(path.join(root, plan.backup_path));
  assert.equal(hash(backupBytes), originalSha256, 'Original backup hash changed');
  assert.equal(plan.backup_sha256, originalSha256);
  assert.equal(plan.original_backup_sha256, originalSha256);
  const manifestBytes = fs.readFileSync(path.join(root, plan.manifest_path));
  assert.equal(hash(manifestBytes), plan.manifest_sha256, 'Final manifest hash changed');
  const before = JSON.parse(backupBytes);
  const manifest = JSON.parse(manifestBytes);
  assertIds(before, 'Backup');
  assertIds(manifest, 'Manifest');
  assert.deepEqual(Object.keys(plan.content_changes).sort(), ['13', '3']);
  assert.equal(plan.content_changes['3'].name, 'NEKKO Jelly pate mèo 70g');
  assert.equal(plan.content_changes['13'].name, 'AFP PUPS Candy Chew – Đồ chơi cắn gặm kẹo xoắn cho chó');
  for (const fields of Object.values(plan.content_changes)) {
    assert.deepEqual(Object.keys(fields).sort(), ['description', 'name']);
    assert.ok(typeof fields.description === 'string' && fields.description);
  }
  for (const old of before) {
    const item = manifest.find(row => row.product_id === old.product_id);
    assert.equal(item.old_url, old.image_url);
    assert.equal(item.old_name, old.name);
    assert.equal(item.old_description, old.description);
    assert.equal(item.batch_id, plan.batch_id);
    assert.equal(item.review_revision, plan.review_revision);
    const change = plan.content_changes[String(old.product_id)] || {};
    assert.deepEqual(item.planned_changes, change);
    assert.equal(item.name, change.name ?? old.name);
    assert.equal(item.description, change.description ?? old.description);
    assert.equal(item.content_approved, true);
    assert.equal(item.content_approval_source, 'user');
    assert.match(item.local_path || '', new RegExp(`^/images/products/${old.product_id}-[a-z0-9]+(?:-[a-z0-9]+)*\\.webp$`));
  }
  assert.equal(new Set(manifest.map(row => row.local_path)).size, 21, 'Duplicate image URLs');
  return { plan, before, manifest };
}

// Only columns owned by this image migration are preconditions for restoration.
// Later edits such as ID 3's price and other products' names remain intact.
function assertCurrent(current, state) {
  assertIds(current, 'Current database');
  for (const row of current) {
    const item = state.manifest.find(product => product.product_id === row.product_id);
    assert.equal(row.image_url, item.local_path, `Migrated image_url changed: ID ${row.product_id}`);
    const change = state.plan.content_changes[String(row.product_id)];
    if (change) {
      assert.equal(row.name, change.name, `Migrated name changed: ID ${row.product_id}`);
      assert.equal(row.description, change.description, `Migrated description changed: ID ${row.product_id}`);
    }
  }
}

function projectRestored(current, state) {
  assertCurrent(current, state);
  return current.map(row => {
    const old = state.before.find(product => product.product_id === row.product_id);
    const restored = { ...row, image_url: old.image_url };
    if (Object.hasOwn(state.plan.content_changes, String(row.product_id))) {
      restored.name = old.name;
      restored.description = old.description;
    }
    const changed = Object.keys(row).filter(key => !Object.is(row[key], restored[key])).sort();
    const allowed = Object.hasOwn(state.plan.content_changes, String(row.product_id))
      ? ['description', 'image_url', 'name'] : ['image_url'];
    assert.ok(changed.every(key => allowed.includes(key)), `Unexpected restoration column: ID ${row.product_id}`);
    return restored;
  });
}

async function main() {
  const mode = process.argv[2];
  if (!modes.includes(mode)) throw new Error('Use ' + modes.join('|'));
  const state = getPlan();
  require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
  const pool = require('../config/db');
  let connection;
  let transaction = false;
  try {
    connection = await pool.getConnection();
    const [[db]] = await connection.query('SELECT DATABASE() AS name');
    assert.equal(db.name, 'petcare_db');
    const [[table]] = await connection.query("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products'");
    assert.equal(table?.ENGINE, 'InnoDB', 'Products must support transactions');
    if (mode === 'restore') {
      await connection.beginTransaction();
      transaction = true;
    }
    const [current] = await connection.query('SELECT * FROM products ORDER BY product_id' + (transaction ? ' FOR UPDATE' : ''));
    const expected = projectRestored(current, state);
    if (mode !== 'restore') {
      console.log(mode === 'audit-applied'
        ? 'audit-applied: all 21 migrated image URLs and authorized names/descriptions match; no writes'
        : 'restore-dry-run: validated restoration of 21 URLs and names/descriptions for IDs 3,13; all other current fields preserved; no writes');
      return;
    }
    for (const row of current) {
      const target = expected.find(product => product.product_id === row.product_id);
      const contentChange = Object.hasOwn(state.plan.content_changes, String(row.product_id));
      const sql = contentChange
        ? 'UPDATE products SET image_url = ?, name = ?, description = ? WHERE product_id = ? AND BINARY image_url <=> BINARY ? AND BINARY name <=> BINARY ? AND BINARY description <=> BINARY ?'
        : 'UPDATE products SET image_url = ? WHERE product_id = ? AND BINARY image_url <=> BINARY ?';
      const values = contentChange
        ? [target.image_url, target.name, target.description, row.product_id, row.image_url, row.name, row.description]
        : [target.image_url, row.product_id, row.image_url];
      const [result] = await connection.execute(sql, values);
      assert.equal(result.affectedRows, 1, `Unexpected affected rows: ID ${row.product_id}`);
    }
    const [actual] = await connection.query('SELECT * FROM products ORDER BY product_id');
    assert.deepEqual(actual, expected, 'Unexpected database field changed; rollback');
    await connection.commit();
    transaction = false;
    console.log('restore: committed 21 original image URLs and original names/descriptions for IDs 3,13; preserved all other live fields including prices');
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    connection?.release();
    await pool.end();
  }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { getPlan, assertCurrent, projectRestored };
