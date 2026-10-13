import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

export const SITE = 'https://fomo.family';
export const API_BASE = 'https://prod-api.fomo.family';

export const config = {
  handle: (process.env.FOMO_HANDLE || 'MixedBumpyShrew').replace(/^@/, ''),
  intervalSeconds: Math.max(15, Number(process.env.INTERVAL_SECONDS) || 60),
  headless: process.env.HEADLESS !== 'false',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  profileDir: path.join(ROOT, 'browser-profile'),
  dataDir: path.join(ROOT, 'data'),
};

// The fomo login, saved by `npm run login`. It's committed so a fresh download can run without logging in.
export const sessionSeedFile = path.join(ROOT, 'fomo-session.json');
// The working copy the tracker keeps up to date as fomo refreshes the login.
export const sessionFile = path.join(config.dataDir, 'session.json');

export const profileUrl = (handle = config.handle) => `${SITE}/profile/${handle}`;
