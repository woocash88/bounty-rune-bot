import { SlashCommandBuilder } from 'discord.js';
import { tryDeductGold, addGold } from '../db/queries.js';
import { log, error } from '../utils/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('give')
    .setDescription('Oddaj część swojego Golda innemu użytkownikowi')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Odbiorca')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('Ilość Gold do przekazania')
        .setRequired(true)
        .setMinValue(1)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const giver = interaction.user;
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);

    // Validation
    if (target.id === giver.id) {
      await interaction.editReply({ content: 'Nie możesz dać Golda samemu sobie.' });
      return;
    }

    if (target.bot) {
      await interaction.editReply({ content: 'Nie możesz przekazać Golda botowi.' });
      return;
    }

    try {
      const deducted = await tryDeductGold(giver.id, amount);

      if (!deducted) {
        await interaction.editReply({ content: 'Hej nie masz tyle golda.' });
        return;
      }

      const newBalance = await addGold(target.id, amount);

      log(`Give: ${giver.id} -> ${target.id}, amount=${amount}`);

      // Ephemeral confirmation to giver
      await interaction.editReply({
        content: `✅ Przekazałeś **${amount} Golda** użytkownikowi <@${target.id}>.`,
      });

      // Public announcement in the channel
      await interaction.channel.send(
        `<@${giver.id}> przekazał **${amount} Golda** użytkownikowi <@${target.id}>! 🤝`
      );
    } catch (err) {
      error('Error executing /give:', err.message);
      await interaction.editReply({
        content: `❌ Wystąpił błąd podczas przekazywania Golda: ${err.message}`,
      });
    }
  },
};
