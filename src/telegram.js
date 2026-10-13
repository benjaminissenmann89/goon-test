import { config } from './config.js';

const TELEGRAM_MAX_LENGTH = 4096;
const POLL_TIMEOUT_SECONDS = 50;
const IGNORE_COMMANDS_OLDER_THAN_MS = 5 * 60_000;

export async function telegram(method, body, { timeoutMs = 20_000 } = {}) {
  if (!config.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN is missing from .env');
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
  return json.result;
}

/** Sends a Telegram message to `chatId`; returns true if it was delivered. */
export async function sendTo(chatId, text) {
  console.log(`[telegram] ${text.replace(/\n/g, ' | ')}`);
  if (!chatId) {
    console.warn('[telegram] TELEGRAM_CHAT_ID is missing from .env, message not sent');
    return false;
  }
  try {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, TELEGRAM_MAX_LENGTH),
      disable_web_page_preview: true,
    });
    return true;
  } catch (err) {
    console.error(`[telegram] ${err.message}`);
    return false;
  }
}

/** Sends a message to the chat in .env; returns true if it was delivered. */
export const notify = (text) => sendTo(config.telegramChatId, text);

/**
 * Long-polls Telegram for commands and calls `onCommand({ command, args, chatId })`.
 * Only messages from TELEGRAM_CHAT_ID are handled, so strangers who find the bot can't control it.
 */
export async function listenForCommands(onCommand) {
  await telegram('setMyCommands', {
    commands: [
      { command: 'start', description: 'What this bot is and who it is tracking' },
      { command: 'track', description: 'Track a different fomo profile: /track username' },
      { command: 'status', description: 'Latest check of the tracked profile' },
      { command: 'help', description: 'Show the commands' },
    ],
  }).catch((err) => console.warn(`[telegram] could not set command menu: ${err.message}`));

  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await telegram(
        'getUpdates',
        { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message'] },
        { timeoutMs: (POLL_TIMEOUT_SECONDS + 15) * 1000 },
      );
    } catch (err) {
      console.warn(`[telegram] polling failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      const text = msg?.text?.trim();
      if (!text?.startsWith('/')) continue;
      if (String(msg.chat.id) !== String(config.telegramChatId)) continue;
      if (Date.now() - msg.date * 1000 > IGNORE_COMMANDS_OLDER_THAN_MS) continue;

      const [first, ...rest] = text.split(/\s+/);
      const command = first.slice(1).split('@')[0].toLowerCase();
      try {
        await onCommand({ command, args: rest.join(' '), chatId: msg.chat.id });
      } catch (err) {
        console.error(`[telegram] /${command} failed: ${err.message}`);
      }
    }
  }
}
