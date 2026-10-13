import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { openLoginProfile, getPage, loadAndCapture, saveSessionSeed } from './browser.js';
import { config, SITE, profileUrl } from './config.js';

// `--save-only` skips opening Chrome and just re-saves the login already in browser-profile/.
const saveOnly = process.argv.includes('--save-only');

// Google refuses sign-in from automation-controlled browsers, so the login uses plain Chrome
// (no Playwright attached) on its own profile folder.
const CHROME_PATHS = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
];

if (!saveOnly) {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) {
    console.log('Google Chrome was not found. Install Chrome, then run the login again.');
    process.exit(1);
  }

  console.log('A normal Chrome window is opening. Log in to fomo there (Google login works).');
  console.log('When you can see fomo logged in, CLOSE that Chrome window to continue.\n');

  const chrome = spawn(
    chromePath,
    [`--user-data-dir=${config.profileDir}`, '--no-first-run', '--no-default-browser-check', '--new-window', SITE],
    { stdio: 'ignore' },
  );
  await new Promise((resolve) => chrome.on('exit', resolve));
  console.log('Chrome closed. Checking the login...');
}

const context = await openLoginProfile({ headless: true });
try {
  const page = await getPage(context);
  const { auth } = await loadAndCapture(page, profileUrl());
  if (auth) {
    saveSessionSeed(await context.storageState());
    console.log('Logged in. Login saved to fomo-session.json; the tracker picks it up on its next start.');
  } else {
    console.log('No fomo login found. Run the login again and make sure you are logged in before closing Chrome.');
    process.exitCode = 1;
  }
} finally {
  await context.close();
}
