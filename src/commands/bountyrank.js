import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLeaderboard } from '../db/queries.js';
import { buildBountyAttachment } from '../utils/bountyEmbed.js';
import { error as logError } from '../utils/logger.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const COOLDOWN_MS = 60_000;
const cooldowns = new Map();

export default {
  data: new SlashCommandBuilder()
    .setName('bountyrank')
    .setDescription('Top 10 liderów Gold'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const lastUsed = cooldowns.get(userId);

    if (lastUsed && Date.now() - lastUsed < COOLDOWN_MS) {
      await interaction.reply({
        content: '⏳ Poczekaj chwilę zanim znowu sprawdzisz ranking (cooldown: 1 min).',
        ephemeral: true,
      });
      return;
    }
    cooldowns.set(userId, Date.now());

    await interaction.deferReply();

    const leaderboard = await getLeaderboard(10);

    if (leaderboard.length === 0) {
      await interaction.editReply({ content: 'Brak danych w rankingu.' });
      return;
    }

    // Resolve usernames with graceful fallback for users who left / deleted accounts.
    const lines = [];
    for (let i = 0; i < leaderboard.length; i++) {
      const entry = leaderboard[i];
      let displayName;
      try {
        const user = await interaction.client.users.fetch(entry.user_id);
        displayName = user.username;
      } catch {
        displayName = `Nieznany użytkownik (id: ${entry.user_id})`;
        logError(`Could not fetch user ${entry.user_id} for leaderboard`);
      }

      const prefix = i < 3 ? MEDALS[i] : `${i + 1}.`;
      lines.push(`${prefix} ${displayName} — **${entry.gold} Gold**`);
    }

    const attachment = buildBountyAttachment();

    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('Ranking Bounty!')
      .setThumbnail('attachment://bounty.png')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Bounty Rune Bot' })
      .setTimestamp();

    const replyPayload = { embeds: [embed] };
    if (attachment) replyPayload.files = [attachment];
    await interaction.editReply(replyPayload);
  },
};
