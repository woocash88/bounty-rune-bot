import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error(
    'Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID in .env'
  );
  process.exit(1);
}

const commands = [];
const commandsPath = join(__dirname, 'commands');

for (const file of readdirSync(commandsPath)) {
  if (!file.endsWith('.js')) continue;

  const { default: command } = await import(`./commands/${file}`);
  if (command?.data) {
    commands.push(command.data.toJSON());
  }
}

const rest = new REST({ version: '10' }).setToken(token);

try {
  console.log(`Registering ${commands.length} slash commands to guild ${guildId}...`);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  });
  console.log('Successfully registered all commands!');
} catch (err) {
  console.error('Failed to register commands:', err);
  process.exit(1);
}
