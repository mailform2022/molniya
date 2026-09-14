import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/vtx'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(16).default('dev-secret-dev-secret-dev-secret'),
  SERVER_SECRET: z.string().min(16).default('dev-hmac-secret-dev-hmac-secret'),
  ADMIN_2FA_ENC_KEY: z.string().min(16).default('dev-2fa-key-dev-2fa-key-dev-2fa'),
  ADMIN_LOGIN_PATH: z.string().default('/admin-login'),
  CORS_ORIGIN: z.string().default('https://vtxservices.ru,http://localhost:5173'),
  API_DOMAIN: z.string().default('localhost'),
  TELEGRAM_CONTACT: z.string().default('@SVYAT_2023'),
  STRIPE_SECRET_KEY: z.string().optional(),
  YOOKASSA_SECRET_KEY: z.string().optional(),
  YOOKASSA_SHOP_ID: z.string().optional(),
  FIRMWARE_DIR: z.string().default('./data/firmware'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional()
});

export const env = schema.parse(process.env);
export const corsOrigins = env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
