import 'dotenv/config';
import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log, error } from './utils/logger.js';
import { stopScheduler } from './scheduler/bountyScheduler.js';
import { releaseLock } from './db/queries.js';
import { stopHeartbeat } from './utils/heartbeat.js';
import { instanceId } from './events/ready.js';

// --- Environment validation ---
const requiredVars = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'BOUNTY_CHANNEL_IDS',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    error(`Missing required environment variable: ${varName}`);
    process.exit(1);
  }
}

// Warn if BOUNTY_AVG_PER_WEEK is missing (defaults to 1)
if (!process.env.BOUNTY_AVG_PER_WEEK) {
  log('BOUNTY_AVG_PER_WEEK not set, defaulting to 1 spawn per week.');
}

// --- Client setup ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

// Load commands into a collection for easy access
client.commands = new Collection();

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsPath = join(__dirname, 'commands');

for (const file of readdirSync(commandsPath)) {
  if (!file.endsWith('.js')) continue;

  try {
    const { default: command } = await import(`./commands/${file}`);
    if (command?.data) {
      client.commands.set(command.data.name, command);
    }
  } catch (err) {
    error(`Failed to load command file ${file}:`, err.message);
  }
}

log(`Loaded ${client.commands.size} commands.`);

// --- Event handlers ---
import readyEvent from './events/ready.js';
import interactionCreateEvent from './events/interactionCreate.js';

client.on(readyEvent.name, (...args) => readyEvent.execute(...args));
client.on(interactionCreateEvent.name, (...args) =>
  interactionCreateEvent.execute(...args)
);

// --- Graceful shutdown ---

async function shutdown(signal) {
  log(`Received ${signal}, shutting down gracefully...`);

  stopHeartbeat();
  stopScheduler();

  // Release the instance lock so a new process can start immediately
  try {
    await releaseLock(instanceId);
    log('Instance lock released.');
  } catch (err) {
    error('Failed to release instance lock:', err.message);
  }

  // Destroy Discord client connection
  try {
    client.destroy();
  } catch {
    // Already destroyed
  }

  log('Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Login ---
client.login(process.env.DISCORD_TOKEN);
