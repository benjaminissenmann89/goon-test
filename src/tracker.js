import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { config, profileUrl } from './config.js';
import { launchBrowser, getPage, loadAndCapture, apiGet, persistSession } from './browser.js';
import { notify, sendTo, listenForCommands } from './telegram.js';

const STATE_FILE = path.join(config.dataDir, 'state.json');
const MAX_SEEN = 5000;
const ERROR_ALERT_AFTER = 5;
const SOLANA_NETWORK_ID = 1399811149;

// Tokens a trade is priced in: spending these is a BUY, receiving them is a SELL.
const QUOTE_TOKENS = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  So11111111111111111111111111111111111111112: 'SOL',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
};
const STABLECOINS = new Set(['USDC', 'USDT']);

mkdirSync(config.dataDir, { recursive: true });

// ---------- single instance ----------
// Two copies would both answer Telegram commands and fight over the saved fomo login.

const LOCK_FILE = path.join(config.dataDir, 'tracker.pid');
const ALREADY_RUNNING_EXIT_CODE = 3; // START.bat stops instead of restarting on this

function isTrackerProcess(pid) {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }
  // PIDs get reused after a reboot, so also check that it's a node process.
  const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return /^"node\.exe"/im.test(out);
}

const otherPid = existsSync(LOCK_FILE) ? Number(readFileSync(LOCK_FILE, 'utf8')) : 0;
if (otherPid && otherPid !== process.pid && isTrackerProcess(otherPid)) {
  console.log(`The tracker is already running (pid ${otherPid}); not starting a second copy.`);
  process.exit(ALREADY_RUNNING_EXIT_CODE);
}
writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => {
  try {
    if (Number(readFileSync(LOCK_FILE, 'utf8')) === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
});

// ---------- state ----------
// The tracked handle lives in state.json once it exists, so a /track switch survives restarts.
// FOMO_HANDLE in .env is only the starting default.

function freshState(handle) {
  return {
    handle,
    user: null,
    swaps: { initialized: false, seen: [] },
    transfers: { initialized: false, seen: [] },
    tokenSymbols: {},
    startedNotified: false,
  };
}

function loadState() {
  if (!existsSync(STATE_FILE)) return freshState(config.handle);
  const { counters, fomoBalances, onchain, ...rest } = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  return { ...freshState(rest.handle ?? config.handle), ...rest };
}

let state = loadState();
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const saveRaw = (name, json) => writeFileSync(path.join(config.dataDir, `raw-${name}.json`), JSON.stringify(json, null, 2));

let lastCheck = null; // { at: Date, summary: string }

// ---------- formatting ----------

const fmtUsd = (n) =>
  n == null || !Number.isFinite(n) ? '?' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 })}`;
const fmtAmount = (n) => (n == null ? '?' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 }));
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US') : '?');
const quoteSymbol = (address) => QUOTE_TOKENS[address] ?? QUOTE_TOKENS[address?.toLowerCase()];
const symbolOf = (address) => quoteSymbol(address) ?? state.tokenSymbols[address] ?? `${address.slice(0, 4)}…${address.slice(-4)}`;
const chartLink = (address, networkId) =>
  networkId === SOLANA_NETWORK_ID ? `https://dexscreener.com/solana/${address}` : `https://dexscreener.com/search?q=${address}`;

function parseHoldings(balancesBody) {
  return (balancesBody?.responseObject?.balances ?? []).map((item) => {
    const token = item.tokenFilterResult?.token ?? {};
    const address = item.balance?.tokenAddress ?? token.address;
    const amount = Number(item.balance?.shiftedBalance ?? item.userToken?.humanAmountRemaining ?? 0);
    const price = Number(item.tokenFilterResult?.priceUSD);
    return { address, symbol: token.symbol ?? symbolOf(address), amount, usd: Number.isFinite(price) ? amount * price : null };
  });
}

function rememberSymbols(holdings, transfers) {
  for (const h of holdings) if (h.address && h.symbol) state.tokenSymbols[h.address] = h.symbol;
  for (const t of transfers) if (t.tokenAddress && t.tokenMetadata?.symbol) state.tokenSymbols[t.tokenAddress] = t.tokenMetadata.symbol;
}

function cashLine(holdings) {
  const cash = holdings.filter((h) => STABLECOINS.has(h.symbol));
  const total = cash.reduce((sum, h) => sum + (h.usd ?? h.amount), 0);
  return `Cash balance now: ${fmtUsd(total)}`;
}

function describeSwap(s) {
  const inSym = symbolOf(s.inTokenAddress);
  const outSym = symbolOf(s.outTokenAddress);
  const usd = s.humanUsdAmountIn ?? s.humanUsdAmountOut;

  if (quoteSymbol(s.inTokenAddress)) {
    return [
      `BUY ${outSym}: @${state.handle}`,
      '',
      `Bought: ${fmtAmount(s.outHumanAmount)} ${outSym}`,
      `Spent: ${fmtAmount(s.inHumanAmount)} ${inSym} (${fmtUsd(usd)})`,
      `Price: ${fmtUsd(usd / s.outHumanAmount)} per ${outSym}`,
      `Token: ${s.outTokenAddress}`,
      `Time: ${fmtTime(s.createdAt)}`,
      '',
      chartLink(s.outTokenAddress, s.outNetworkId ?? s.networkId),
    ].join('\n');
  }
  if (quoteSymbol(s.outTokenAddress)) {
    return [
      `SELL ${inSym}: @${state.handle}`,
      '',
      `Sold: ${fmtAmount(s.inHumanAmount)} ${inSym}`,
      `Got: ${fmtAmount(s.outHumanAmount)} ${outSym} (${fmtUsd(s.humanUsdAmountOut ?? usd)})`,
      `Price: ${fmtUsd((s.humanUsdAmountOut ?? usd) / s.inHumanAmount)} per ${inSym}`,
      `Token: ${s.inTokenAddress}`,
      `Time: ${fmtTime(s.createdAt)}`,
      '',
      chartLink(s.inTokenAddress, s.inNetworkId ?? s.networkId),
    ].join('\n');
  }
  return [
    `SWAP ${inSym} -> ${outSym}: @${state.handle}`,
    '',
    `Gave: ${fmtAmount(s.inHumanAmount)} ${inSym}`,
    `Got: ${fmtAmount(s.outHumanAmount)} ${outSym}`,
    `Value: ${fmtUsd(usd)}`,
    `Time: ${fmtTime(s.createdAt)}`,
  ].join('\n');
}

function describeTransfer(t, holdings) {
  const symbol = t.tokenMetadata?.symbol ?? symbolOf(t.tokenAddress);
  const type = (t.type ?? '').toUpperCase();
  const incoming = /WITHDRAW|SEND/.test(type) ? false : /DEPOSIT|RECEIVE/.test(type) || t.toAddress === state.user?.wallet;
  const isCash = STABLECOINS.has(symbol);
  const title = incoming
    ? isCash ? 'Money added' : `Token received (${symbol})`
    : isCash ? 'Money withdrawn' : `Token sent out (${symbol})`;
  return [
    `${title}: @${state.handle}`,
    '',
    `${incoming ? '+' : '-'}${fmtUsd(t.usdAmount)} (${fmtAmount(t.humanAmount)} ${symbol})`,
    cashLine(holdings),
    `Time: ${fmtTime(t.createdAt)}`,
  ].join('\n');
}

/** Alerts once for each item whose id hasn't been seen before. The first run only records what exists. */
async function alertNew(feed, items, describe) {
  const seen = new Set(feed.seen);
  const fresh = items.filter((it) => it.id && !seen.has(it.id));
  if (feed.initialized) {
    for (const item of [...fresh].reverse()) await notify(`${describe(item)}\n\n${profileUrl(state.handle)}`);
  }
  feed.seen = [...new Set([...items.map((it) => it.id).filter(Boolean), ...feed.seen])].slice(0, MAX_SEEN);
  const newCount = feed.initialized ? fresh.length : 0;
  feed.initialized = true;
  return newCount;
}

// ---------- fomo data (read from what the profile page loads) ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const userPathRe = (handle) => new RegExp(`^/v2/users/userHandle/${escapeRe(handle)}$`, 'i');
const swapsPathRe = (id) => new RegExp(`^/v2/users/${id}/swaps(\\?|$)`);
const balancesPathRe = (id) => new RegExp(`^/v2/users/${id}/balances(\\?|$)`);
const transfersPathRe = (id) => new RegExp(`^/v2/users/${id}/transfers(\\?|$)`);

function findResponse(responses, re) {
  for (const [p, json] of responses) if (re.test(p)) return json;
  return undefined;
}

async function getOrFetch(page, auth, responses, re, pathname) {
  const found = findResponse(responses, re);
  if (found) return found;
  const res = await apiGet(page, pathname, auth);
  if (res.status !== 200 || !res.json) throw new Error(`GET ${pathname} returned HTTP ${res.status}`);
  return res.json;
}

// ---------- checking ----------

let context = null;
let page = null;
let loggedOutAlerted = false;

async function ensureBrowser() {
  if (context && page && !page.isClosed()) return;
  await context?.close().catch(() => {});
  context = await launchBrowser({ headless: config.headless });
  page = await getPage(context);
}

class LoggedOutError extends Error {}
class ProfileNotFoundError extends Error {}

/** Checks the tracked profile once, sends alerts for anything new, and returns a one-line summary. */
async function cycle() {
  await ensureBrowser();
  const handle = state.handle;

  const { auth, responses } = await loadAndCapture(page, profileUrl(handle), {
    isDone: (r) => {
      const id = state.user?.id ?? findResponse(r, userPathRe(handle))?.responseObject?.id;
      return Boolean(id && findResponse(r, userPathRe(handle)) && findResponse(r, swapsPathRe(id)) && findResponse(r, balancesPathRe(id)));
    },
  });

  if (!auth) {
    // Reopen next time so a login saved meanwhile (LOGIN.bat) gets picked up.
    await context.close().catch(() => {});
    context = page = null;
    if (!loggedOutAlerted) {
      loggedOutAlerted = await notify(
        'fomo-tracker: logged out of fomo. On the computer running the tracker, double-click LOGIN.bat and log in; tracking resumes by itself.',
      );
    }
    throw new LoggedOutError('Not logged in to fomo (the profile page never made an authenticated request).');
  }
  await persistSession(context);
  if (loggedOutAlerted) {
    await notify('fomo-tracker: logged back in, tracking resumed.');
    loggedOutAlerted = false;
  }

  let userBody;
  try {
    userBody = await getOrFetch(page, auth, responses, userPathRe(handle), `/v2/users/userHandle/${encodeURIComponent(handle)}`);
  } catch (err) {
    if (/HTTP 404/.test(err.message)) throw new ProfileNotFoundError(`fomo has no profile called @${handle}`);
    throw err;
  }
  saveRaw('user', userBody);
  const user = userBody?.responseObject;
  if (!user?.id) throw new ProfileNotFoundError(`fomo has no profile called @${handle}`);
  if (user.userHandle) state.handle = user.userHandle;

  const [swapsBody, balancesBody, transfersBody] = [
    await getOrFetch(page, auth, responses, swapsPathRe(user.id), `/v2/users/${user.id}/swaps`),
    await getOrFetch(page, auth, responses, balancesPathRe(user.id), `/v2/users/${user.id}/balances`),
    await getOrFetch(page, auth, responses, transfersPathRe(user.id), `/v2/users/${user.id}/transfers`),
  ];
  saveRaw('swaps', swapsBody);
  saveRaw('balances', balancesBody);
  saveRaw('transfers', transfersBody);

  const swaps = swapsBody?.responseObject?.swaps ?? [];
  const transfers = transfersBody?.responseObject?.transfers ?? [];
  const holdings = parseHoldings(balancesBody);
  state.user = { id: user.id, wallet: swaps[0]?.address ?? transfers[0]?.toAddress ?? state.user?.wallet ?? null };
  rememberSymbols(holdings, transfers);

  const newTransfers = await alertNew(state.transfers, transfers, (t) => describeTransfer(t, holdings));
  const newSwaps = await alertNew(state.swaps, swaps, describeSwap);
  saveState();

  const held = holdings.filter((h) => h.amount > 0).map((h) => `${fmtAmount(h.amount)} ${h.symbol} (${fmtUsd(h.usd)})`);
  const summary =
    `${swaps.length} trade(s)${newSwaps ? ` (+${newSwaps} new)` : ''}, ` +
    `${transfers.length} deposit/withdrawal(s)${newTransfers ? ` (+${newTransfers} new)` : ''}, ` +
    `holding: ${held.length ? held.join(', ') : 'nothing'}`;
  lastCheck = { at: new Date(), summary };
  console.log(`[${lastCheck.at.toLocaleTimeString()}] @${state.handle}: ${summary}`);
  return summary;
}

// ---------- Telegram commands ----------

let pendingSwitch = null; // { handle, chatId }
let wakeMainLoop = () => {};

function parseHandle(input) {
  const text = input.trim();
  const fromUrl = text.match(/fomo\.family\/profile\/([^/?#\s]+)/i);
  const handle = (fromUrl ? fromUrl[1] : text).replace(/^@/, '');
  return /^[A-Za-z0-9_.-]{1,40}$/.test(handle) ? handle : null;
}

function statusText() {
  const last = lastCheck
    ? `Last check: ${lastCheck.at.toLocaleTimeString('en-US')}\n${lastCheck.summary}`
    : 'Last check: none yet, the first one is running.';
  return `Currently tracking: @${state.handle}\n${profileUrl(state.handle)}\n\n${last}\n\nChecking every ${config.intervalSeconds} seconds.`;
}

const COMMANDS_TEXT = [
  'Commands:',
  '/track <username or profile link> - track a different fomo profile',
  '/status - who I am tracking and the latest check',
  '/help - show this message',
].join('\n');

function introText() {
  return [
    'fomo tracker bot',
    '',
    'I watch one fomo.family profile and message you here whenever they:',
    '- buy or sell a token (amount, price, and a chart link)',
    '- add or withdraw money (amount and their new cash balance)',
    'Each trade or deposit is reported once.',
    '',
    statusText(),
    '',
    COMMANDS_TEXT,
  ].join('\n');
}

async function onCommand({ command, args, chatId }) {
  switch (command) {
    case 'start':
    case 'help':
      return sendTo(chatId, introText());
    case 'status':
      return sendTo(chatId, statusText());
    case 'track': {
      if (!args.trim()) {
        return sendTo(chatId, `Currently tracking @${state.handle}.\n\nTo switch, send:\n/track username\nor\n/track https://fomo.family/profile/username`);
      }
      const handle = parseHandle(args);
      if (!handle) return sendTo(chatId, "That doesn't look like a fomo username or profile link. Try: /track username");
      if (handle.toLowerCase() === state.handle.toLowerCase()) return sendTo(chatId, `Already tracking @${state.handle}.`);
      pendingSwitch = { handle, chatId };
      await sendTo(chatId, `Switching to @${handle}, checking their profile...`);
      wakeMainLoop();
      return;
    }
    default:
      return sendTo(chatId, `I don't know /${command}.\n\n${COMMANDS_TEXT}`);
  }
}

async function applySwitch({ handle, chatId }) {
  const previous = state;
  state = { ...freshState(handle), startedNotified: true };
  try {
    const summary = await cycle();
    saveState();
    await sendTo(
      chatId,
      `Now tracking @${state.handle}\n${profileUrl(state.handle)}\n\nCurrently: ${summary}\n\n` +
        `Their existing trades and deposits won't be re-sent; you'll get a message for each new one.`,
    );
  } catch (err) {
    state = previous;
    saveState();
    const reason = err instanceof ProfileNotFoundError ? err.message : `the check failed (${err.message})`;
    await sendTo(chatId, `Couldn't switch: ${reason}.\nStill tracking @${state.handle}.`);
  }
}

// ---------- main loop ----------

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeMainLoop = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/** Stops Windows from going to sleep while the tracker runs (the screen can still turn off). */
function keepAwake() {
  if (process.platform !== 'win32') return;
  const script = [
    `Add-Type -Name Power -Namespace Win32 -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
    '[Win32.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null', // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep 30 }`,
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  spawn(powershell, ['-NoProfile', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true, detached: true })
    .on('error', (err) => console.error(`Could not keep the PC awake: ${err.message}`))
    .unref();
}

async function main() {
  console.log(`Watching ${profileUrl(state.handle)} every ${config.intervalSeconds}s. Press Ctrl+C to stop.`);
  keepAwake();
  if (config.telegramChatId) listenForCommands(onCommand);

  let consecutiveErrors = 0;
  let errorAlerted = false;
  for (;;) {
    if (pendingSwitch) {
      const request = pendingSwitch;
      pendingSwitch = null;
      await applySwitch(request);
      consecutiveErrors = 0;
    } else {
      try {
        const summary = await cycle();
        if (!state.startedNotified) {
          state.startedNotified = await notify(
            `fomo-tracker started for @${state.handle}\n\nCurrently: ${summary}\n\n` +
              `You'll get one message per new trade and per deposit or withdrawal.\nSend /help for commands.\n${profileUrl(state.handle)}`,
          );
          saveState();
        }
        if (errorAlerted) await notify('fomo-tracker: recovered, checks are working again.');
        consecutiveErrors = 0;
        errorAlerted = false;
      } catch (err) {
        consecutiveErrors++;
        console.error(`Check failed (${consecutiveErrors} in a row): ${err.message}`);
        if (!page || page.isClosed()) page = null;
        if (consecutiveErrors >= ERROR_ALERT_AFTER && !errorAlerted && !(err instanceof LoggedOutError)) {
          errorAlerted = await notify(`fomo-tracker: ${consecutiveErrors} checks in a row have failed. Last error: ${err.message}`);
        }
      }
    }
    if (!pendingSwitch) await sleep(config.intervalSeconds * 1000 + (Math.random() - 0.5) * 10_000);
  }
}

async function shutdown() {
  console.log('\nStopping...');
  try {
    await context?.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
