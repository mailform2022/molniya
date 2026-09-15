import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from './index.js';
import * as schema from './schema.js';
import { env } from '../lib/env.js';

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../firmware');

interface BundledItem {
  file: string;
  kind: 'fc' | 'transmitter' | 'configurator';
  target: string;
  version: string;
  sha256: string;
  section?: string;
  models?: string[];
  changelog?: string;
  provenance?: Record<string, string>;
}

/**
 * Registers real builds shipped with the API (apps/api/firmware/catalog.json) into the catalog.
 * Idempotent by sha256; a file whose hash does not match the manifest is skipped and logged instead of
 * being registered. Entries always start as experimental + unpublished: publication still goes through the
 * flight-evidence gate in the admin route.
 */
export async function seedBundledFirmware(db: Db, log: (msg: string) => void = () => undefined): Promise<void> {
  let items: BundledItem[];
  try {
    items = (JSON.parse(await readFile(path.join(CATALOG_DIR, 'catalog.json'), 'utf8')) as { items: BundledItem[] }).items;
  } catch (e) {
    log(`bundled firmware: catalog.json не прочитан (${(e as Error).message})`);
    return;
  }
  for (const it of items) {
    const [dup] = await db
      .select({ id: schema.firmwareVersions.id, filePath: schema.firmwareVersions.filePath })
      .from(schema.firmwareVersions)
      .where(eq(schema.firmwareVersions.sha256, it.sha256));
    const fileMissing = dup ? await access(dup.filePath).then(() => false, () => true) : false;
    if (dup && !fileMissing) continue;
    let buf: Buffer;
    try {
      buf = await readFile(path.join(CATALOG_DIR, it.file));
    } catch {
      log(`bundled firmware: нет файла ${it.file} — пропуск`);
      continue;
    }
    const sha = createHash('sha256').update(buf).digest('hex');
    if (sha !== it.sha256) {
      log(`bundled firmware: sha256 ${it.file} не совпадает с manifest — пропуск`);
      continue;
    }
    if (dup) {
      // storage on the host is ephemeral (Railway): restore the file for an existing catalog row
      await mkdir(path.dirname(dup.filePath), { recursive: true });
      await writeFile(dup.filePath, buf);
      log(`bundled firmware: восстановлен файл ${it.file}`);
      continue;
    }
    const dir = path.join(env.FIRMWARE_DIR, it.kind, it.target);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${it.version}-${it.file}`);
    await writeFile(filePath, buf);
    const modelIds = it.models?.length
      ? (await db.select({ id: schema.boardModels.id }).from(schema.boardModels).where(inArray(schema.boardModels.code, it.models))).map((m) => m.id)
      : [];
    await db.insert(schema.firmwareVersions).values({
      kind: it.kind,
      target: it.target,
      version: it.version,
      fileName: it.file,
      filePath,
      sha256: sha,
      sizeBytes: buf.length,
      changelog: it.changelog,
      isPublished: false,
      verification: 'experimental',
      section: it.section,
      provenance: { ...(it.provenance ?? {}), bundled: 'apps/api/firmware/catalog.json' },
      modelIds
    });
    log(`bundled firmware: зарегистрирована ${it.kind} ${it.target} ${it.version}`);
  }
}
