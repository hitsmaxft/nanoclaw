/**
 * Feishu Bot Authentication Setup
 * Interactive script to configure Feishu (Lark) bot credentials
 * and start WebSocket connection
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import * as Lark from '@larksuiteoapi/node-sdk';

const STORE_DIR = path.join(process.cwd(), 'store');
const CREDS_PATH = path.join(STORE_DIR, 'feishu-credentials.json');

interface FeishuCredentials {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function testConnection(creds: FeishuCredentials): Promise<{ success: boolean; botName?: string; error?: string }> {
  try {
    const client = new Lark.Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      appType: Lark.AppType.SelfBuild,
    });

    // Use raw request to get bot info
    const response = await (client as any).request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });

    if (response.code === 0 && response.bot) {
      return {
        success: true,
        botName: response.bot.bot_name,
      };
    } else {
      return {
        success: false,
        error: response.msg || `Error code: ${response.code}`,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function startWebSocketConnection(creds: FeishuCredentials): Promise<never> {
  console.log('Starting WebSocket connection to Feishu...');
  console.log('Press Ctrl+C to exit');
  console.log('');

  const wsClient = new Lark.WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  const eventDispatcher = new Lark.EventDispatcher({
    encryptKey: creds.encryptKey,
    verificationToken: creds.verificationToken,
  });

  // Register event handler for messages
  eventDispatcher.register({
    'im.message.receive_v1': async (data) => {
      console.log('✉️  Received message:', JSON.stringify(data, null, 2));
    },
  });

  // Start WebSocket connection
  wsClient.start({ eventDispatcher });
  console.log('✅ WebSocket client started');

  // Keep the process running - this promise never resolves
  return new Promise(() => {
    // Never resolves - process stays alive until Ctrl+C
  });
}

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           Feishu (Lark) Bot Authentication Setup           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('To use Feishu as a messenger for NanoClaw, you need to create');
  console.log('a custom app in the Feishu Developer Console and obtain the');
  console.log('App ID and App Secret.');
  console.log('');
  console.log('Setup Instructions:');
  console.log('1. Go to https://open.feishu.cn/app');
  console.log('2. Click "Create Custom App"');
  console.log('3. Enable "Bot" capability in the app settings');
  console.log('4. Copy the App ID and App Secret from the app credentials');
  console.log('5. (Optional) Set Encrypt Key and Verification Token for security');
  console.log('6. Subscribe to these events: im.message.receive_v1');
  console.log('7. Set connection mode to WebSocket');
  console.log('');

  // Check for existing credentials
  let existingCreds: FeishuCredentials | null = null;
  if (fs.existsSync(CREDS_PATH)) {
    try {
      existingCreds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
      console.log('⚠️  Existing credentials found.');
      const overwrite = await ask('Do you want to overwrite them? (y/N): ');
      if (overwrite.toLowerCase() !== 'y') {
        console.log('Keeping existing credentials.');
        // Load existing credentials and start WebSocket connection
        console.log('');
        if (!existingCreds) {
          console.error("Failed to load existing credentials.");
          rl.close();
          process.exit(1);
        }
        const testResult = await testConnection(existingCreds);
        if (!testResult.success) {
          console.error('❌ Connection failed:', testResult.error);
          console.log('');
          console.log('Please check your credentials and run the script again.');
          rl.close();
          process.exit(1);
        }
        console.log(`✅ Connection successful! Bot: ${testResult.botName || 'Unknown'}`);
        console.log('');
        rl.close();

        // This should never return
        try {
          await startWebSocketConnection(existingCreds);
        } catch (err) {
          console.error('WebSocket error:', err);
          process.exit(1);
        }

        // Should never reach here
        process.exit(0);
      }
    } catch {
      // Invalid existing file, continue to ask for new credentials
    }
  }

  // Collect credentials
  console.log('');
  console.log('Please enter your Feishu app credentials:');
  console.log('');

  const appId = await ask('App ID: ');
  if (!appId) {
    console.error('❌ App ID is required');
    rl.close();
    process.exit(1);
  }

  const appSecret = await ask('App Secret: ');
  if (!appSecret) {
    console.error('❌ App Secret is required');
    rl.close();
    process.exit(1);
  }

  console.log('');
  console.log('Optional security settings (press Enter to skip):');

  const encryptKey = await ask('Encrypt Key (optional): ');
  const verificationToken = await ask('Verification Token (optional): ');

  const creds: FeishuCredentials = {
    appId,
    appSecret,
    ...(encryptKey && { encryptKey }),
    ...(verificationToken && { verificationToken }),
  };

  // Test connection
  console.log('');
  console.log('🔄 Testing connection to Feishu API...');

  const testResult = await testConnection(creds);

  if (!testResult.success) {
    console.error('❌ Connection failed:', testResult.error);
    console.log('');
    console.log('Please check your App ID and App Secret and try again.');
    rl.close();
    process.exit(1);
  }

  console.log(`✅ Connection successful! Bot: ${testResult.botName}`);

  // Save credentials
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  fs.chmodSync(CREDS_PATH, 0o600); // Restrict permissions

  console.log('');
  console.log(`✅ Credentials saved to: ${CREDS_PATH}`);
  console.log('');
  console.log('Next steps:');
  console.log('1. Set MESSENGER=feishu environment variable');
  console.log('2. Add the bot to your Feishu groups');
  console.log('3. Start NanoClaw with: npm run dev');
  console.log('');
  console.log('To switch back to Telegram:');
  console.log('  unset MESSENGER  # or set MESSENGER=telegram');
  console.log('');

  rl.close();

  // Start WebSocket connection - should never return
  try {
    await startWebSocketConnection(creds);
  } catch (err) {
    console.error('WebSocket error:', err);
    process.exit(1);
  }

  // Should never reach here
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
