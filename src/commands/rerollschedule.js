import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { recomputeSchedule } from '../scheduler/bountyScheduler.js';
import { log, error } from '../utils/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('rerollschedule')
    .setDescription(
      '[Admin] Przelicz termin następnego spawnu Bounty Runy (na podstawie BOUNTY_AVG_PER_WEEK)'
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: '❌ Nie masz uprawnień do użycia tej komendy.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const { nextDate, avgPerWeek } = await recomputeSchedule(interaction.client);

      const day = String(nextDate.getDate()).padStart(2, '0');
      const month = String(nextDate.getMonth() + 1).padStart(2, '0');
      const year = nextDate.getFullYear();
      const hours = String(nextDate.getHours()).padStart(2, '0');
      const minutes = String(nextDate.getMinutes()).padStart(2, '0');
      const seconds = String(nextDate.getSeconds()).padStart(2, '0');

      await interaction.editReply({
        content: `✅ Nowy termin Bounty Runy: **${day}.${month}.${year}, ${hours}:${minutes}:${seconds}** (na podstawie **${avgPerWeek}** spawnów/tydzień).`,
      });
    } catch (err) {
      error('Failed to reroll schedule:', err.message);
      await interaction.editReply({
        content: `❌ Błąd przeliczania harmonogramu: ${err.message}`,
      });
    }
  },
};
