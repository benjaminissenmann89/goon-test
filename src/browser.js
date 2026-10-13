import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { config, API_BASE, sessionFile, sessionSeedFile } from './config.js';

const VIEWPORT = { width: 1280, height: 900 };

async function launchChrome(launch, options) {
  try {
    return await launch({ ...options, channel: 'chrome' });
  } catch {
    // No Google Chrome installed: use Playwright's bundled Chromium.
    return await launch(options);
  }
}

/** The Chrome profile that `npm run login` signs in with. Only used to log in and save the session. */
export function openLoginProfile({ headless }) {
  return launchChrome((o) => chromium.launchPersistentContext(config.profileDir, o), { headless, viewport: VIEWPORT });
}

// ---------- saved fomo session ----------

const sessionDomain = (host) => /(^|\.)(fomo\.family|privy\.io)$/i.test(host.replace(/^\./, ''));

/** Keeps only the fomo/Privy login cookies and storage, dropping big caches. */
export function slimSession(state) {
  return {
    cookies: state.cookies.filter((c) => sessionDomain(c.domain)),
    origins: state.origins
      .filter((o) => sessionDomain(new URL(o.origin).hostname))
      .map((o) => ({ ...o, localStorage: o.localStorage.filter((e) => !/^(statsig\.cached|tradingview|ph_)/.test(e.name)) })),
  };
}

function writeJsonAtomic(file, data) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function saveSessionSeed(state) {
  writeJsonAtomic(sessionSeedFile, slimSession(state));
}

const hash = (text) => createHash('sha256').update(text).digest('hex');

/** The latest session: the tracker's own copy, unless a newer login was saved since. */
function loadSession() {
  if (!existsSync(sessionSeedFile)) throw new Error('No fomo login saved. Run LOGIN.bat (or `npm run login`) first.');
  const seed = readFileSync(sessionSeedFile, 'utf8');
  const seedHashFile = `${sessionFile}.seed`;
  const current = existsSync(seedHashFile) && readFileSync(seedHashFile, 'utf8') === hash(seed);
  if (current && existsSync(sessionFile)) return JSON.parse(readFileSync(sessionFile, 'utf8'));
  writeFileSync(sessionFile, seed);
  writeFileSync(seedHashFile, hash(seed));
  return JSON.parse(seed);
}

/** Saves fomo's refreshed login tokens so the session keeps working across restarts. */
export async function persistSession(context) {
  writeJsonAtomic(sessionFile, slimSession(await context.storageState()));
}

export async function launchBrowser({ headless }) {
  const storageState = loadSession();
  const browser = await launchChrome((o) => chromium.launch(o), { headless });
  const context = await browser.newContext({ storageState, viewport: VIEWPORT });
  context.on('close', () => browser.close().catch(() => {}));
  return context;
}

export async function getPage(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  // fomo's API rejects requests whose user agent says "HeadlessChrome".
  const ua = await page.evaluate(() => navigator.userAgent);
  if (ua.includes('HeadlessChrome')) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.setUserAgentOverride', { userAgent: ua.replace('HeadlessChrome', 'Chrome') });
  }
  return page;
}

/**
 * Loads `url` and records every fomo API response the page makes, keyed by path.
 * Stops once the page has authenticated and `isDone(responses)` is true, or after `timeoutMs`.
 * `auth` (headers for apiGet) is null if the page never made an authenticated request (logged out).
 */
export async function loadAndCapture(page, url, { isDone = () => true, timeoutMs = 25_000 } = {}) {
  const headers = { 'content-type': 'application/json' };
  let loggedIn = false;
  const responses = new Map();

  const onRequest = async (req) => {
    if (!req.url().startsWith(API_BASE)) return;
    try {
      const h = await req.allHeaders();
      // fomo used to send a Bearer token; it now authenticates with Privy cookies instead.
      if (h.authorization?.startsWith('Bearer ')) headers.authorization = h.authorization;
      if (h['x-supported-chains']) headers['x-supported-chains'] = h['x-supported-chains'];
      if (h['app-language']) headers['app-language'] = h['app-language'];
    } catch {
      // request may already be gone during navigation
    }
  };
  const onResponse = async (res) => {
    if (!res.url().startsWith(API_BASE) || res.status() !== 200) return;
    const pathname = res.url().slice(API_BASE.length);
    if (pathname.startsWith('/v2/users')) loggedIn = true;
    try {
      responses.set(pathname, await res.json());
    } catch {
      // non-JSON or body already discarded
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const deadline = Date.now() + timeoutMs;
    while (!(loggedIn && isDone(responses)) && Date.now() < deadline) await page.waitForTimeout(500);
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
  return { auth: loggedIn ? headers : null, responses };
}

/** Calls the fomo API from inside the page so it uses the site's own origin and cookies. */
export async function apiGet(page, pathname, headers) {
  const { status, body } = await page.evaluate(
    async ({ url, headers }) => {
      const res = await fetch(url, { headers, credentials: 'include' });
      return { status: res.status, body: await res.text() };
    },
    { url: API_BASE + pathname, headers },
  );

  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // non-JSON error page
  }
  return { status, json, raw: body };
}
