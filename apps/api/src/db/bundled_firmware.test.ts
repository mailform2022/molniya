import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { db, schema, sql as pg } from './index.js';
import { sql } from 'drizzle-orm';
import { seedBundledFirmware } from './bundled_firmware.js';

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../firmware/catalog.json');

const dbUp = await db
  .execute(sql`select 1`)
  .then(() => true)
  .catch(() => false);

test('bundled firmware: registers once, restores a lost file, never publishes', { skip: !dbUp && 'no database' }, async (t) => {
  const { items } = JSON.parse(await readFile(CATALOG, 'utf8')) as { items: Array<{ sha256: string }> };
  assert.ok(items.length >= 5);
  t.after(async () => {
    for (const it of items) await db.delete(schema.firmwareVersions).where(eq(schema.firmwareVersions.sha256, it.sha256));
    await pg.end();
  });
  for (const it of items) await db.delete(schema.firmwareVersions).where(eq(schema.firmwareVersions.sha256, it.sha256));

  const log: string[] = [];
  await seedBundledFirmware(db, (m) => log.push(m));
  const rows = await db.select().from(schema.firmwareVersions);
  const ours = rows.filter((r) => items.some((it) => it.sha256 === r.sha256));
  assert.equal(ours.length, items.length);
  for (const r of ours) {
    assert.equal(r.isPublished, false);
    assert.equal(r.verification, 'experimental');
    assert.equal(r.provenance?.bundled, 'apps/api/firmware/catalog.json');
    await access(r.filePath);
  }
  assert.equal(log.filter((l) => /зарегистрирована/.test(l)).length, items.length);

  // idempotent
  await seedBundledFirmware(db, (m) => log.push(m));
  const again = (await db.select().from(schema.firmwareVersions)).filter((r) => items.some((it) => it.sha256 === r.sha256));
  assert.equal(again.length, items.length);

  // ephemeral storage lost the file → restored, no new row
  const first = ours[0]!;
  await unlink(first.filePath);
  await seedBundledFirmware(db, (m) => log.push(m));
  await access(first.filePath);
  assert.ok(log.some((l) => /восстановлен/.test(l)));
  const afterRestore = (await db.select().from(schema.firmwareVersions)).filter((r) => items.some((it) => it.sha256 === r.sha256));
  assert.equal(afterRestore.length, items.length);
});
