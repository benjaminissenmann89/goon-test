// The repo is public, so the bot token and fomo login are committed only encrypted (secrets.enc).
//   node src/secrets.js lock <key>    encrypts .env and fomo-session.json into secrets.enc
//   node src/secrets.js unlock <key>  writes them back out from secrets.enc
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_FILES = ['.env', 'fomo-session.json'];
const ENC_FILE = path.join(ROOT, 'secrets.enc');

const [action, key] = process.argv.slice(2);
if (!['lock', 'unlock'].includes(action) || !key) {
  console.log('Usage: node src/secrets.js lock|unlock <key>');
  process.exit(1);
}

if (action === 'lock') {
  const files = Object.fromEntries(SECRET_FILES.map((f) => [f, readFileSync(path.join(ROOT, f), 'utf8')]));
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(key, salt, 32), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(files), 'utf8'), cipher.final()]);
  const out = { salt, iv, tag: cipher.getAuthTag(), data };
  writeFileSync(ENC_FILE, JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.toString('base64')]))));
  console.log(`Locked ${SECRET_FILES.join(', ')} into secrets.enc`);
} else {
  if (!existsSync(ENC_FILE)) {
    console.log('secrets.enc is missing.');
    process.exit(1);
  }
  const enc = Object.fromEntries(Object.entries(JSON.parse(readFileSync(ENC_FILE, 'utf8'))).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  let files;
  try {
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(key, enc.salt, 32), enc.iv);
    decipher.setAuthTag(enc.tag);
    files = JSON.parse(Buffer.concat([decipher.update(enc.data), decipher.final()]).toString('utf8'));
  } catch {
    console.log('Wrong unlock key.');
    process.exit(1);
  }
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(ROOT, name), content);
  console.log('Unlocked the bot settings and fomo login.');
}
