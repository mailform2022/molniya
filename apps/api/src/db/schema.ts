import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------- users / access ----------
export const users = pgTable(
  'users',
  {
    id: id(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    emailVerifyToken: varchar('email_verify_token', { length: 64 }),
    role: varchar('role', { length: 16 }).notNull().default('user'), // user | admin
    fingerprint: varchar('fingerprint', { length: 128 }),
    registeredIp: varchar('registered_ip', { length: 64 }),
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    backupCodesHash: jsonb('backup_codes_hash').$type<string[]>().default([]),
    isBlocked: boolean('is_blocked').notNull().default(false),
    profile: jsonb('profile').$type<Record<string, unknown>>().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email), index('users_fp_idx').on(t.fingerprint)]
);

export const userSessions = pgTable('user_sessions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  refreshTokenHash: varchar('refresh_token_hash', { length: 128 }).notNull(),
  fingerprint: varchar('fingerprint', { length: 128 }),
  ip: varchar('ip', { length: 64 }),
  userAgent: text('user_agent'),
  role: varchar('role', { length: 16 }).notNull().default('operator'), // operator | technician | viewer
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt()
});

export const activeSessions = pgTable('active_sessions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: varchar('session_id', { length: 64 }).notNull(),
  role: varchar('role', { length: 16 }).notNull().default('operator'),
  deviceLabel: varchar('device_label', { length: 128 }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow()
});

export const plans = pgTable('plans', {
  id: id(),
  code: varchar('code', { length: 32 }).notNull().unique(), // BASE
  name: varchar('name', { length: 64 }).notNull(),
  durationDays: integer('duration_days').notNull().default(30),
  deviceLimit: integer('device_limit').notNull().default(1),
  priceRub: integer('price_rub').notNull().default(0),
  features: jsonb('features').$type<Record<string, boolean | number | string>>().notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const planAddons = pgTable('plan_addons', {
  id: id(),
  code: varchar('code', { length: 32 }).notNull().unique(), // extra_device | extra_time
  name: varchar('name', { length: 64 }).notNull(),
  kind: varchar('kind', { length: 16 }).notNull(), // extra_device | extra_time
  amount: integer('amount').notNull().default(1), // +devices or +days
  priceRub: integer('price_rub').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true)
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id').notNull().references(() => plans.id),
    status: varchar('status', { length: 16 }).notNull().default('active'), // active | expired | cancelled
    source: varchar('source', { length: 16 }).notNull(), // code | payment | manual | trial
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deviceLimit: integer('device_limit').notNull().default(1),
    createdAt: createdAt()
  },
  (t) => [index('subs_user_idx').on(t.userId)]
);

export const addonPurchases = pgTable('addon_purchases', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
  addonId: uuid('addon_id').notNull().references(() => planAddons.id),
  paymentId: uuid('payment_id'),
  createdAt: createdAt()
});

export const payments = pgTable('payments', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 16 }).notNull(), // yookassa | stripe | manual
  providerPaymentId: varchar('provider_payment_id', { length: 128 }),
  amountRub: integer('amount_rub').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  purpose: jsonb('purpose').$type<{ kind: 'plan' | 'addon'; id: string }>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const activationCodes = pgTable(
  'activation_codes',
  {
    id: id(),
    code: varchar('code', { length: 64 }).notNull(),
    type: varchar('type', { length: 3 }).notNull(), // ACT | EXT | TST | SES
    planCode: varchar('plan_code', { length: 32 }).notNull(),
    durationDays: integer('duration_days').notNull(),
    deviceLimit: integer('device_limit').notNull(),
    maxRedemptions: integer('max_redemptions').notNull().default(1),
    redemptions: integer('redemptions').notNull().default(0),
    isRevoked: boolean('is_revoked').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id),
    note: text('note'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('codes_code_uq').on(t.code)]
);

export const codeRedemptions = pgTable('code_redemptions', {
  id: id(),
  codeId: uuid('code_id').notNull().references(() => activationCodes.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  ip: varchar('ip', { length: 64 }),
  fingerprint: varchar('fingerprint', { length: 128 }),
  createdAt: createdAt()
});

export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull(), // transmitter | board
    uid: varchar('uid', { length: 64 }).notNull(),
    modelId: uuid('model_id'),
    name: varchar('name', { length: 64 }),
    firmwareVersion: varchar('firmware_version', { length: 32 }),
    authTokenHash: varchar('auth_token_hash', { length: 128 }),
    authExpiresAt: timestamp('auth_expires_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    backup: jsonb('backup').$type<Record<string, unknown>>(),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('devices_uid_uq').on(t.uid), index('devices_user_idx').on(t.userId)]
);

// ---------- hardware catalog ----------
export const boardModels = pgTable('board_models', {
  id: id(),
  code: varchar('code', { length: 64 }).notNull().unique(), // molniya-2
  name: varchar('name', { length: 128 }).notNull(),
  fcTarget: varchar('fc_target', { length: 64 }).notNull(), // CADDXF405_WING
  totalPins: integer('total_pins').notNull().default(12),
  description: text('description'),
  defaultDiffTemplateId: uuid('default_diff_template_id'),
  isActive: boolean('is_active').notNull().default(true),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: createdAt()
});

export const transmitterModels = pgTable('transmitter_models', {
  id: id(),
  code: varchar('code', { length: 64 }).notNull().unique(), // tx16s
  name: varchar('name', { length: 128 }).notNull(), // RadioMaster TX16S
  platform: varchar('platform', { length: 32 }).notNull(), // edgetx | stm32-custom
  firmwareTarget: varchar('firmware_target', { length: 64 }), // tx16s
  display: varchar('display', { length: 64 }),
  channels: integer('channels').notNull().default(16),
  isActive: boolean('is_active').notNull().default(true),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: createdAt()
});

export const firmwareVersions = pgTable(
  'firmware_versions',
  {
    id: id(),
    kind: varchar('kind', { length: 16 }).notNull(), // fc | transmitter | configurator
    target: varchar('target', { length: 64 }).notNull(),
    version: varchar('version', { length: 32 }).notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    filePath: text('file_path').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    changelog: text('changelog'),
    isPublished: boolean('is_published').notNull().default(false),
    /**
     * How far this build has been validated. Publication (isPublished) is only allowed from `flight_tested`.
     * experimental → diagnostic → flight_tested → withdrawn
     */
    verification: varchar('verification', { length: 16 }).notNull().default('experimental'),
    /** Catalog section shown to users, e.g. «Молния», «Утка». */
    section: varchar('section', { length: 64 }),
    /** Crash report whose analysis this build fixes (iteration chain). */
    fixesCrashReportId: uuid('fixes_crash_report_id'),
    withdrawnReason: text('withdrawn_reason'),
    modelIds: jsonb('model_ids').$type<string[]>().default([]),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt()
  },
  (t) => [index('fw_target_idx').on(t.kind, t.target)]
);

/** FC targets + INAV version that are known to fly with our firmware. Anything else is «unverified». */
export const verifiedTargets = pgTable(
  'verified_targets',
  {
    id: id(),
    fcTarget: varchar('fc_target', { length: 64 }).notNull(),
    /** exact version or prefix like `7.1` */
    inavVersion: varchar('inav_version', { length: 32 }).notNull(),
    boardModelId: uuid('board_model_id').references(() => boardModels.id),
    /** verified: flown OK; experimental: flown, problems (e.g. «Утка»); banned: do not flash */
    status: varchar('status', { length: 16 }).notNull().default('verified'),
    evidence: text('evidence'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('verified_targets_uq').on(t.fcTarget, t.inavVersion)]
);

/**
 * Immutable pre-change snapshot of a connected FC: identity, `diff all`, storage capability,
 * optional firmware image. Taken before any write; referenced by diagnostic builds and crash reports.
 */
export const boardSnapshots = pgTable(
  'board_snapshots',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    uid: varchar('uid', { length: 64 }).notNull(),
    fcVariant: varchar('fc_variant', { length: 8 }).notNull(),
    fcVersion: varchar('fc_version', { length: 32 }).notNull(),
    fcTarget: varchar('fc_target', { length: 64 }).notNull(),
    boardId: varchar('board_id', { length: 8 }),
    /** verified | experimental | unverified | banned — computed at snapshot time from verified_targets */
    trust: varchar('trust', { length: 16 }).notNull(),
    transport: jsonb('transport').$type<{ vid?: number; pid?: number; label: string }>(),
    diffAll: text('diff_all'),
    diffSha256: varchar('diff_sha256', { length: 64 }),
    statusText: text('status_text'),
    vtxConfig: jsonb('vtx_config').$type<Record<string, number>>(),
    vtxMap: jsonb('vtx_map').$type<Array<Record<string, number>>>(),
    capability: jsonb('capability').$type<Record<string, unknown>>(),
    /** firmware image dumped externally (DFU/ST-Link) and uploaded; null when not taken */
    imagePath: text('image_path'),
    imageSha256: varchar('image_sha256', { length: 64 }),
    imageSizeBytes: integer('image_size_bytes'),
    imageSource: varchar('image_source', { length: 32 }), // dfu-util | stm32cubeprog | st-link | other
    note: text('note'),
    createdAt: createdAt()
  },
  (t) => [index('snapshots_user_idx').on(t.userId), index('snapshots_uid_idx').on(t.uid)]
);

/**
 * Diagnostic build request for an unverified board: base firmware + `diff` that enables logging.
 * Output is a CLI script (deterministic from inputs) + a link to the firmware file to flash.
 */
export const diagnosticBuilds = pgTable('diagnostic_builds', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  snapshotId: uuid('snapshot_id').notNull().references(() => boardSnapshots.id, { onDelete: 'cascade' }),
  baseFirmwareId: uuid('base_firmware_id').references(() => firmwareVersions.id),
  logPath: varchar('log_path', { length: 16 }).notNull(), // flash | sdcard | serial_host
  options: jsonb('options').$type<Record<string, unknown>>().notNull(),
  /** CLI lines to apply after flashing the base firmware (user diff + logging + debug) */
  cliScript: text('cli_script').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('ready'), // ready | applied | flown | crashed
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

/** Post-crash upload + analysis, compared against the pre-change snapshot. */
export const crashReports = pgTable(
  'crash_reports',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    snapshotId: uuid('snapshot_id').references(() => boardSnapshots.id, { onDelete: 'set null' }),
    diagnosticBuildId: uuid('diagnostic_build_id').references(() => diagnosticBuilds.id, { onDelete: 'set null' }),
    uid: varchar('uid', { length: 64 }),
    fcTarget: varchar('fc_target', { length: 64 }),
    description: text('description'),
    /** `diff all` read from the board after the crash */
    diffAfter: text('diff_after'),
    /** uploaded files: blackbox logs, MSP host logs, photos */
    files: jsonb('files').$type<Array<{ kind: string; name: string; path: string; sha256: string; sizeBytes: number }>>().notNull().default([]),
    /** machine analysis: diff comparison, blackbox summary, findings */
    analysis: jsonb('analysis').$type<Record<string, unknown>>(),
    status: varchar('status', { length: 16 }).notNull().default('new'), // new | analyzed | fix_proposed | fixed | closed
    adminNote: text('admin_note'),
    fixFirmwareId: uuid('fix_firmware_id').references(() => firmwareVersions.id),
    fixDiffContent: text('fix_diff_content'),
    /** user feedback after flying the fix */
    userVerdict: varchar('user_verdict', { length: 16 }), // ok | still_crashes | not_flown
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index('crash_user_idx').on(t.userId), index('crash_status_idx').on(t.status)]
);

export const boardPinLayouts = pgTable('board_pin_layouts', {
  id: id(),
  boardModelId: uuid('board_model_id').references(() => boardModels.id, { onDelete: 'cascade' }),
  fcTarget: varchar('fc_target', { length: 64 }).notNull(),
  imagePath: text('image_path'),
  totalPins: integer('total_pins').notNull(),
  pins: jsonb('pins')
    .$type<Array<{ pin: string; x: number; y: number; role: string; rcChannel?: number; range?: [number, number]; signal?: 'pwm' | 'digital' | 'servo' }>>()
    .notNull()
    .default([]),
  status: varchar('status', { length: 16 }).notNull().default('draft'), // draft | published
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const boardSubmissions = pgTable('board_submissions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id),
  name: varchar('name', { length: 128 }).notNull(),
  fcTarget: varchar('fc_target', { length: 64 }),
  detected: jsonb('detected').$type<Record<string, unknown>>(),
  photoPath: text('photo_path'),
  layoutId: uuid('layout_id').references(() => boardPinLayouts.id),
  status: varchar('status', { length: 24 }).notNull().default('pending_review'),
  moderatorNote: text('moderator_note'),
  createdAt: createdAt()
});

// ---------- VTX ----------
export const frequencyRanges = pgTable('frequency_ranges', {
  id: id(),
  code: varchar('code', { length: 16 }).notNull().unique(), // 3g3
  name: varchar('name', { length: 64 }).notNull(),
  minMhz: integer('min_mhz').notNull(),
  maxMhz: integer('max_mhz').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('in_dev'), // active | in_dev | coming_soon
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0)
});

export const vtxModels = pgTable('vtx_models', {
  id: id(),
  name: varchar('name', { length: 128 }).notNull(),
  manufacturer: varchar('manufacturer', { length: 128 }),
  rangeId: uuid('range_id').references(() => frequencyRanges.id),
  protocol: varchar('protocol', { length: 32 }).notNull().default('smartaudio'),
  bands: integer('bands').notNull(),
  channels: integer('channels').notNull(),
  freqTable: jsonb('freq_table').$type<number[][]>().notNull(), // [band][channel] MHz
  powerLevels: jsonb('power_levels').$type<number[]>().default([]),
  rawStatusSample: text('raw_status_sample'),
  isDisabled: boolean('is_disabled').notNull().default(false),
  flagged: boolean('flagged').notNull().default(false),
  sourceSubmissionId: uuid('source_submission_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const vtxProfiles = pgTable('vtx_profiles', {
  id: id(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  vtxModelId: uuid('vtx_model_id').references(() => vtxModels.id),
  name: varchar('name', { length: 128 }).notNull(),
  pairs: jsonb('pairs').$type<Array<{ band: number; channel: number; freqMhz: number; rcChannel: number; rcLevel: number }>>().notNull().default([]),
  isPublic: boolean('is_public').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const vtxSubmissions = pgTable('vtx_submissions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id),
  name: varchar('name', { length: 128 }).notNull(),
  manufacturer: varchar('manufacturer', { length: 128 }),
  rangeId: uuid('range_id').references(() => frequencyRanges.id),
  protocol: varchar('protocol', { length: 32 }),
  freqTable: jsonb('freq_table').$type<number[][]>().notNull(),
  cliStatusHex: text('cli_status_hex'),
  parsedStatus: jsonb('parsed_status').$type<Record<string, unknown>>(),
  autoDetection: jsonb('auto_detection').$type<Record<string, unknown>>(),
  /** Raw request/response exchange with the VTX captured during the wizard (hex, direction, note). */
  rawLog: jsonb('raw_log').$type<Array<{ t: number; dir: 'tx' | 'rx' | 'info'; hex?: string; text: string }>>().notNull().default([]),
  /** Where the frequency grid came from: catalog | vtx_info | manual | file */
  freqSource: varchar('freq_source', { length: 16 }).notNull().default('manual'),
  freqFile: jsonb('freq_file').$type<{ name: string; path: string; sha256: string }>(),
  fcTarget: varchar('fc_target', { length: 64 }),
  fcVersion: varchar('fc_version', { length: 32 }),
  status: varchar('status', { length: 24 }).notNull().default('pending_review'), // pending_review | approved | rejected | info_requested | merged
  moderatorNote: text('moderator_note'),
  resultVtxModelId: uuid('result_vtx_model_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

/** Photos of a VTX uploaded by contributors (identification); admins edit captions/annotations and hide. */
export const vtxPhotos = pgTable(
  'vtx_photos',
  {
    id: id(),
    submissionId: uuid('submission_id').references(() => vtxSubmissions.id, { onDelete: 'cascade' }),
    vtxModelId: uuid('vtx_model_id').references(() => vtxModels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id),
    imagePath: text('image_path').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    caption: varchar('caption', { length: 255 }),
    annotations: jsonb('annotations').$type<Array<{ x: number; y: number; label: string }>>().notNull().default([]),
    isHidden: boolean('is_hidden').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt()
  },
  (t) => [index('vtx_photos_model_idx').on(t.vtxModelId), index('vtx_photos_sub_idx').on(t.submissionId)]
);

export const vtxAutoDetections = pgTable('vtx_auto_detections', {
  id: id(),
  userId: uuid('user_id').references(() => users.id),
  fcTarget: varchar('fc_target', { length: 64 }),
  fcVersion: varchar('fc_version', { length: 32 }),
  vtxConfig: jsonb('vtx_config').$type<Record<string, unknown>>(),
  vtxInfo: jsonb('vtx_info').$type<Record<string, unknown>>(),
  matchedVtxModelId: uuid('matched_vtx_model_id'),
  log: jsonb('log').$type<string[]>().default([]),
  createdAt: createdAt()
});

export const vtxSyncLog = pgTable('vtx_sync_log', {
  id: id(),
  userId: uuid('user_id').references(() => users.id),
  deviceId: uuid('device_id').references(() => devices.id),
  direction: varchar('direction', { length: 16 }).notNull(), // to_fc | to_tx | from_fc
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  ok: boolean('ok').notNull().default(true),
  createdAt: createdAt()
});

export const vtxReports = pgTable('vtx_reports', {
  id: id(),
  userId: uuid('user_id').references(() => users.id),
  vtxModelId: uuid('vtx_model_id').references(() => vtxModels.id),
  category: varchar('category', { length: 24 }).notNull(), // channels | frequency | autodetect | firmware | config | other
  message: text('message').notNull(),
  context: jsonb('context').$type<Record<string, unknown>>(),
  status: varchar('status', { length: 16 }).notNull().default('open'),
  adminReply: text('admin_reply'),
  createdAt: createdAt()
});

export const vtxConnectionPhotos = pgTable('vtx_connection_photos', {
  id: id(),
  vtxModelId: uuid('vtx_model_id').notNull().references(() => vtxModels.id, { onDelete: 'cascade' }),
  fcTarget: varchar('fc_target', { length: 64 }).notNull(),
  imagePath: text('image_path').notNull(),
  annotations: jsonb('annotations').$type<Array<{ x: number; y: number; label: string }>>().default([]),
  createdAt: createdAt()
});

// ---------- diff ----------
export const diffTemplates = pgTable('diff_templates', {
  id: id(),
  name: varchar('name', { length: 128 }).notNull(),
  boardModelId: uuid('board_model_id').references(() => boardModels.id),
  isDefault: boolean('is_default').notNull().default(false),
  isPublic: boolean('is_public').notNull().default(true),
  currentVersionId: uuid('current_version_id'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const diffTemplateVersions = pgTable('diff_template_versions', {
  id: id(),
  templateId: uuid('template_id').notNull().references(() => diffTemplates.id, { onDelete: 'cascade' }),
  version: varchar('version', { length: 32 }).notNull(), // semver
  content: text('content').notNull(),
  changelog: text('changelog'),
  parsed: jsonb('parsed').$type<{ unknown: string[]; conflicts: string[]; commands: number }>(),
  createdAt: createdAt()
});

export const userDiffs = pgTable('user_diffs', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 128 }).notNull(),
  boardModelId: uuid('board_model_id').references(() => boardModels.id),
  parentTemplateId: uuid('parent_template_id').references(() => diffTemplates.id),
  isActive: boolean('is_active').notNull().default(false),
  draft: text('draft'),
  currentVersionId: uuid('current_version_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const userDiffVersions = pgTable('user_diff_versions', {
  id: id(),
  diffId: uuid('diff_id').notNull().references(() => userDiffs.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  content: text('content').notNull(),
  createdAt: createdAt()
});

export const diffShareLinks = pgTable('diff_share_links', {
  id: id(),
  diffId: uuid('diff_id').notNull().references(() => userDiffs.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: createdAt()
});

export const diffUsageLog = pgTable('diff_usage_log', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id),
  diffId: uuid('diff_id'),
  templateId: uuid('template_id'),
  action: varchar('action', { length: 24 }).notNull(), // applied | exported | imported | shared
  createdAt: createdAt()
});

// ---------- autoflash ----------
export const flashPresets = pgTable('flash_presets', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 128 }).notNull(),
  allowedTargets: jsonb('allowed_targets').$type<string[]>().notNull().default([]),
  inavVersion: varchar('inav_version', { length: 32 }).notNull().default('latest'), // 7 | 9 | latest | pinned:x.y.z
  firmwareId: uuid('firmware_id').references(() => firmwareVersions.id),
  diffId: uuid('diff_id'),
  osdProfile: jsonb('osd_profile').$type<Record<string, unknown>>(),
  vtxProfileId: uuid('vtx_profile_id').references(() => vtxProfiles.id),
  armingConfig: jsonb('arming_config').$type<Record<string, unknown>>(),
  options: jsonb('options')
    .$type<{ skipIfSame: boolean; applyDiff: boolean; applyOsd: boolean; applyVtx: boolean; autoEepromWrite: boolean; syncTransmitter: boolean }>()
    .notNull()
    .default({ skipIfSame: true, applyDiff: true, applyOsd: true, applyVtx: true, autoEepromWrite: true, syncTransmitter: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const autoflashRuns = pgTable('autoflash_runs', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  presetId: uuid('preset_id').references(() => flashPresets.id),
  boardUid: varchar('board_uid', { length: 64 }),
  fcTarget: varchar('fc_target', { length: 64 }),
  fromVersion: varchar('from_version', { length: 32 }),
  toVersion: varchar('to_version', { length: 32 }),
  status: varchar('status', { length: 16 }).notNull().default('running'), // running | ok | failed | skipped
  startedAt: createdAt(),
  finishedAt: timestamp('finished_at', { withTimezone: true })
});

export const autoflashLogEntries = pgTable('autoflash_log_entries', {
  id: serial('id').primaryKey(),
  runId: uuid('run_id').notNull().references(() => autoflashRuns.id, { onDelete: 'cascade' }),
  level: varchar('level', { length: 8 }).notNull().default('info'),
  step: varchar('step', { length: 32 }),
  message: text('message').notNull(),
  createdAt: createdAt()
});

// ---------- misc ----------
export const usageLogs = pgTable('usage_logs', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id),
  event: varchar('event', { length: 48 }).notNull(),
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: createdAt()
});

export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  actorId: uuid('actor_id').references(() => users.id),
  action: varchar('action', { length: 64 }).notNull(),
  target: varchar('target', { length: 128 }),
  ip: varchar('ip', { length: 64 }),
  fingerprint: varchar('fingerprint', { length: 128 }),
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: createdAt()
});

export const newsPosts = pgTable('news_posts', {
  id: id(),
  slug: varchar('slug', { length: 128 }).notNull().unique(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body').notNull(),
  tags: jsonb('tags').$type<string[]>().default([]),
  firmwareVersion: varchar('firmware_version', { length: 32 }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const feedbackMessages = pgTable('feedback_messages', {
  id: id(),
  userId: uuid('user_id').references(() => users.id),
  email: varchar('email', { length: 255 }),
  subject: varchar('subject', { length: 255 }),
  message: text('message').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('new'), // new | in_progress | answered | closed
  adminReply: text('admin_reply'),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const featureFlags = pgTable('feature_flags', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  description: text('description'),
  updatedAt: updatedAt()
});

export const cmsContent = pgTable('cms_content', {
  key: varchar('key', { length: 64 }).primaryKey(),
  locale: varchar('locale', { length: 8 }).notNull().default('ru'),
  content: jsonb('content').$type<unknown>().notNull(),
  updatedAt: updatedAt()
});
