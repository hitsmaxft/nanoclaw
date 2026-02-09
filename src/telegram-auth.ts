/**
 * Telegram Bot Authentication Script
 *
 * Creates a Telegram bot and saves the token.
 *
 * Usage: npx tsx src/telegram-auth.ts
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const TOKEN_FILE = './store/telegram-token.txt';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
  return new Promise(resolve => rl.question(query, resolve));
}

async function authenticate(): Promise<void> {
  const storeDir = './store';
  fs.mkdirSync(storeDir, { recursive: true });

  // Check if already authenticated
  if (fs.existsSync(TOKEN_FILE)) {
    const existingToken = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    console.log('✓ Telegram bot token already configured');
    console.log(`  Token: ${existingToken.substring(0, 10)}...${existingToken.substring(existingToken.length - 4)}`);
    console.log('  To re-authenticate, delete store/telegram-token.txt and run again.');
    rl.close();
    process.exit(0);
  }

  console.log('Setting up Telegram bot for NanoClaw...\n');
  console.log('To create a Telegram bot:');
  console.log('  1. Open Telegram and search for @BotFather');
  console.log('  2. Send /newbot');
  console.log('  3. Follow the prompts to name your bot');
  console.log('  4. Copy the API token BotFather gives you\n');

  const token = await question('Enter your Telegram bot token: ');

  if (!token || token.length < 30) {
    console.log('\n✗ Invalid token. Token should be a long string from BotFather.');
    rl.close();
    process.exit(1);
  }

  // Test the token
  console.log('\nTesting bot token...');
  const bot = new TelegramBot(token, { polling: false });

  try {
    const me = await bot.getMe();
    console.log(`✓ Bot connected: @${me.username} (${me.first_name})`);
  } catch (err) {
    console.log('\n✗ Failed to connect to Telegram. Check your token.');
    console.log('  Error:', (err as Error).message);
    rl.close();
    process.exit(1);
  }

  // Save the token
  fs.writeFileSync(TOKEN_FILE, token.trim());
  console.log('\n✓ Successfully authenticated with Telegram!');
  console.log('  Token saved to store/telegram-token.txt');
  console.log('  You can now start the NanoClaw service.\n');
  console.log('IMPORTANT: Send a message to your bot in Telegram to get started.');
  console.log('  Find your bot by searching: @' + (await bot.getMe()).username);

  rl.close();
  process.exit(0);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  rl.close();
  process.exit(1);
});
