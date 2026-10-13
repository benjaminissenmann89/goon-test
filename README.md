# goon-test (fomo-tracker)

Checks a fomo.family profile every minute and posts new trades and deposits to the Telegram group.

The bot token and fomo login are only in `secrets.enc`, encrypted. Running it needs the unlock key.

## Run it on a Windows PC

1. Click **Code > Download ZIP**, then unzip it (right-click > Extract All).
2. Double-click **START.bat** and enter the unlock key when asked (only the first time).
   - The first run also installs Node.js and the browser it needs (a few minutes).
3. Leave the window open (minimizing is fine). Closing it stops tracking.

Only run it on one computer at a time.

## If Telegram says "logged out of fomo"

Double-click **LOGIN.bat**, log in to fomo in the Chrome window that opens, then close that window. Tracking resumes by itself.

## Telegram commands

- `/start` - what the bot is and who it's tracking
- `/track <username or profile link>` - track a different profile
- `/status` - latest check
