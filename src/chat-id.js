import { telegram } from './telegram.js';

const updates = await telegram('getUpdates');
const chats = new Map();
for (const u of updates) {
  const chat = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
  if (chat) chats.set(chat.id, chat.title ?? chat.username ?? chat.first_name ?? '');
}

if (chats.size === 0) {
  console.log('No messages found. Send your bot any message in Telegram, then run this again.');
  process.exit(1);
}

for (const [id, name] of chats) {
  console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);
  await telegram('sendMessage', { chat_id: id, text: 'fomo-tracker is connected. Alerts will arrive here.' });
}
console.log('\nPut that line in your .env. A test message was sent to the chat.');
