import { SlashCommandBuilder } from 'discord.js';
import { getNextSpawnAt } from '../db/queries.js';
import { error } from '../utils/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('next')
    .setDescription('Sprawdź kiedy pojawi się następna Bounty Runa'),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const nextDate = await getNextSpawnAt();

      if (!nextDate) {
        await interaction.editReply({
          content: '⏳ Harmonogram nie został jeszcze wyliczony. Spróbuj ponownie za chwilę.',
        });
        return;
      }

      const unix = Math.floor(nextDate.getTime() / 1000);

      await interaction.editReply({
        content: `⏳ Następna Bounty Runa pojawi się: <t:${unix}:F> (<t:${unix}:R>)`,
      });
    } catch (err) {
      error('Error in /next command:', err.message);
      await interaction.editReply({
        content: `❌ Błąd odczytu harmonogramu: ${err.message}`,
      });
    }
  },
};
