import { SlashCommandBuilder } from 'discord.js';
import { getUserGold } from '../db/queries.js';

export default {
  data: new SlashCommandBuilder()
    .setName('bounty')
    .setDescription('Sprawdź swoje saldo Gold')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Sprawdź Gold innego użytkownika (opcjonalnie)')
        .setRequired(false),
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const gold = await getUserGold(targetUser.id);

    const content =
      targetUser.id === interaction.user.id
        ? `💰 Twoje saldo Gold: **${gold}**`
        : `💰 <@${targetUser.id}> ma Gold: **${gold}**`;

    await interaction.editReply({ content });
  },
};
