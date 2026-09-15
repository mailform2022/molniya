import { eq } from 'drizzle-orm';
import type { Db } from './index.js';
import * as schema from './schema.js';
import { hashPassword } from '../lib/crypto.js';
import { env } from '../lib/env.js';
import { analyzeDiff } from '../lib/diff.js';

/** Idempotent seed: reference data required for the product to function. */
export async function seed(db: Db): Promise<void> {
  await db
    .insert(schema.plans)
    .values({ code: 'BASE', name: 'Base', durationDays: 30, deviceLimit: 1, priceRub: 0, features: { boards_unlimited: true, configurator: true, autoflash: true, diff: true, emulators: true } })
    .onConflictDoUpdate({ target: schema.plans.code, set: { durationDays: 30, deviceLimit: 1 } });

  await db
    .insert(schema.planAddons)
    .values([
      { code: 'extra_device', name: '+1 пульт (докупается отдельно)', kind: 'extra_device', amount: 1, priceRub: 0 },
      { code: 'extra_time', name: '+30 дней', kind: 'extra_time', amount: 30, priceRub: 0 }
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.frequencyRanges)
    .values([
      { code: '3g3', name: '3.3–3.7 ГГц', minMhz: 3300, maxMhz: 3700, status: 'active', isDefault: true, sortOrder: 1 },
      { code: '5g8', name: '4.9–5.8 ГГц', minMhz: 4900, maxMhz: 5800, status: 'in_dev', sortOrder: 2 },
      { code: '1g3', name: '1.3–1.5 ГГц', minMhz: 1300, maxMhz: 1500, status: 'in_dev', sortOrder: 3 },
      { code: '7g1', name: '7.1 ГГц', minMhz: 7000, maxMhz: 7200, status: 'coming_soon', sortOrder: 4 }
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.boardModels)
    .values([
      { code: 'molniya-2', name: 'Молния 2 / 2ДТ', fcTarget: 'CADDXF405_WING', totalPins: 12, description: 'Универсальная прошивка' },
      { code: 'molniya-m13', name: 'Молния M13', fcTarget: 'CADDXF405_WING', totalPins: 12, description: 'Отдельная прошивка: другие PID, mixer, limits' },
      { code: 'utka', name: '«Утка»', fcTarget: 'SPEEDYBEEF405WING', totalPins: 12, description: 'Раскладка пинов требует уточнения', isActive: true },
      { code: 'molniya-pvo', name: 'Молния ПВО', fcTarget: 'UNKNOWN', totalPins: 12, description: 'FC уточняется', isActive: false }
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.transmitterModels)
    .values([
      { code: 'tx16s', name: 'RadioMaster TX16S', platform: 'edgetx', firmwareTarget: 'tx16s', display: '480x272 color touch', channels: 16 },
      { code: 'tx15', name: 'RadioMaster TX15', platform: 'edgetx', firmwareTarget: 'tx15', display: '320x480 color touch', channels: 16 },
      { code: 'tx12mk2', name: 'RadioMaster TX12 MK2', platform: 'edgetx', firmwareTarget: 'tx12mk2', display: '128x64 mono', channels: 16 },
      { code: 'tx12', name: 'RadioMaster TX12', platform: 'edgetx', firmwareTarget: 'tx12', display: '128x64 mono', channels: 16 },
      { code: 'pocket', name: 'RadioMaster Pocket', platform: 'edgetx', firmwareTarget: 'pocket', display: '128x64 mono', channels: 16 },
      { code: 'boxer', name: 'RadioMaster Boxer', platform: 'edgetx', firmwareTarget: 'boxer', display: '128x64 mono', channels: 16 }
    ])
    .onConflictDoNothing();

  // Default pin layout for CADDXF405_WING (S1..S12), per spec §4.
  const [m2] = await db.select().from(schema.boardModels).where(eq(schema.boardModels.code, 'molniya-2'));
  if (m2) {
    const exists = await db.$count(schema.boardPinLayouts, eq(schema.boardPinLayouts.boardModelId, m2.id));
    if (!exists) {
      type Pin = { pin: string; role: string; rcChannel?: number; range?: [number, number]; signal?: 'pwm' | 'digital' | 'servo' };
      const roles: Pin[] = [
        { pin: 'S1', role: 'Левый элерон', rcChannel: 1, signal: 'servo' },
        { pin: 'S2', role: 'Правый элерон', rcChannel: 1, signal: 'servo' },
        { pin: 'S3', role: 'Руль высоты', rcChannel: 2, signal: 'servo' },
        { pin: 'S4', role: 'Левый мотор', rcChannel: 3, signal: 'pwm' },
        { pin: 'S5', role: 'Правый мотор', rcChannel: 3, signal: 'pwm' },
        { pin: 'S6', role: 'PWM реле взвода', rcChannel: 7, range: [1700, 2100], signal: 'pwm' },
        { pin: 'S7', role: 'PWM реле (опционально)', signal: 'pwm' },
        { pin: 'S8', role: 'Резерв' },
        { pin: 'S9', role: 'Реле взвода, высокий уровень', rcChannel: 7, range: [1700, 2100], signal: 'digital' },
        { pin: 'S10', role: 'Резерв' },
        { pin: 'S11', role: 'Резерв' },
        { pin: 'S12', role: 'Резерв' }
      ];
      await db.insert(schema.boardPinLayouts).values({
        boardModelId: m2.id,
        fcTarget: 'CADDXF405_WING',
        totalPins: 12,
        status: 'published',
        pins: roles.map((p, i) => ({ ...p, x: 0.12 + (i % 6) * 0.15, y: i < 6 ? 0.25 : 0.75 }))
      });
    }
  }

  // Default 3.3 GHz grid (SX33 / FF3741 family — 30 MHz stride, 5 bands × 8 channels).
  const [r3g3] = await db.select().from(schema.frequencyRanges).where(eq(schema.frequencyRanges.code, '3g3'));
  const vtxCount = await db.$count(schema.vtxModels);
  if (r3g3 && !vtxCount) {
    const grid: number[][] = [];
    for (let b = 0; b < 5; b++) grid.push(Array.from({ length: 8 }, (_, c) => 3300 + (b * 8 + c) * 10));
    await db.insert(schema.vtxModels).values({ name: 'SX33 / FF3741 (3.3 ГГц)', manufacturer: 'Generic', rangeId: r3g3.id, protocol: 'smartaudio', bands: 5, channels: 8, freqTable: grid, powerLevels: [25, 200, 500, 1000] });
  }

  const flags: Array<[string, unknown, string]> = [
    ['registration.one_account_per_fingerprint', true, 'Один аккаунт на fingerprint'],
    ['registration.trial_days', 3, 'Пробный период BASE (дней)'],
    ['ui.animated_background', true, 'Анимированный фон noise-gradient'],
    ['ui.tooltips', true, 'Подсказки react-floater'],
    ['ui.block_devtools', false, 'Блокировка DevTools (F12/Ctrl+U/ПКМ)'],
    ['feature.autoflash', true, 'AutoFlashPreset'],
    ['feature.emulators', true, 'Эмуляторы пульта/борта'],
    ['feature.crowdsource', true, 'CrowdSourceWizard'],
    ['feature.pwa_install_prompt', true, 'Кнопка «Установить приложение»']
  ];
  for (const [key, value, description] of flags) await db.insert(schema.featureFlags).values({ key, value, description }).onConflictDoNothing();

  // Flight-verification status per FC target: Molniya boards flown on 7.1.x; «Утка» crashed → experimental until fixed.
  await db
    .insert(schema.verifiedTargets)
    .values([
      { fcTarget: 'CADDXF405_WING', inavVersion: '7.1', status: 'verified', evidence: 'Молния 2 / M13: рабочие борта на INAV 7.1.x (inav PR #2)' },
      { fcTarget: 'SPEEDYBEEF405WING', inavVersion: '7.1', status: 'experimental', evidence: '«Утка»: падение в полёте, blackbox не работал, dataflash отсутствует — требуется диагностическая итерация' }
    ])
    .onConflictDoNothing();

  const cms: Array<[string, unknown]> = [
    ['home.hero', { title: 'VTX Services', subtitle: 'Прошивка и настройка полётных контроллеров и пультов: VTX AUTO, diff, автопрошивка', cta: 'Подключить борт' }],
    ['help.web_serial', { text: 'Нужен Chrome/Edge 89+ (на Android — Chrome 148+ и USB OTG). Firefox и Safari не поддерживают Web Serial.' }],
    ['footer.text', { text: 'VTX Services — сервис не связан с производителями пультов и FC.' }]
  ];
  for (const [key, content] of cms) await db.insert(schema.cmsContent).values({ key, content }).onConflictDoNothing();

  // Default diff template for Молния 2 (arming relay on S6/S9 via CH7 1700–2100).
  const diffCount = await db.$count(schema.diffTemplates);
  if (!diffCount && m2) {
    const content = [
      '# VTX Services — Молния 2 / CADDXF405_WING базовый diff',
      'feature -AIRMODE',
      'feature PWM_OUTPUT_ENABLE',
      'set platform_type = AIRPLANE',
      'set applied_defaults = 2',
      'set vtx_band = 1',
      'set vtx_channel = 1',
      'set vtx_power = 1',
      'set vtx_3g3_chan_freqfix = ON',
      'logic 0 1 -1 1 1 6 0 1700 0',
      'logic 1 1 -1 26 4 0 0 1 0',
      'save'
    ].join('\n');
    const [t] = await db.insert(schema.diffTemplates).values({ name: 'Молния 2 — базовый', boardModelId: m2.id, isDefault: true, isPublic: true }).returning();
    const [v] = await db.insert(schema.diffTemplateVersions).values({ templateId: t!.id, version: '1.0.0', content, changelog: 'initial', parsed: analyzeDiff(content) }).returning();
    await db.update(schema.diffTemplates).set({ currentVersionId: v!.id }).where(eq(schema.diffTemplates.id, t!.id));
    await db.update(schema.boardModels).set({ defaultDiffTemplateId: t!.id }).where(eq(schema.boardModels.id, m2.id));
  }

  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    await db.insert(schema.users).values({ email: env.ADMIN_EMAIL.toLowerCase(), passwordHash: hashPassword(env.ADMIN_PASSWORD), role: 'admin', emailVerified: true }).onConflictDoNothing();
  }
}
