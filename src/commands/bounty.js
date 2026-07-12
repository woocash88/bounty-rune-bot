import { SlashCommandBuilder } from 'discord.js';
import { getUserGold } from '../db/queries.js';

export default {
  data: new SlashCommandBuilder()
    .setName('bounty')
    .setDescription('Sprawdź swoje saldo Gold'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const gold = await getUserGold(userId);

    await interaction.editReply({
      content: `💰 Twoje saldo Gold: **${gold}**`,
    });
  },
};
