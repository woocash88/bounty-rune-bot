import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { addGold } from '../db/queries.js';

const maxAdjustment = parseInt(process.env.MAX_GOLD_ADJUSTMENT, 10) || 100000;

export default {
  data: new SlashCommandBuilder()
    .setName('add')
    .setDescription('[Admin] Dodaj Gold użytkownikowi')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Użytkownik')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('gold')
        .setDescription('Ilość Gold do dodania')
        .setRequired(true)
        .setMinValue(1)
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

    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('gold', true);

    await interaction.deferReply({ ephemeral: true });

    // Input validation: reject out-of-range amounts
    if (amount > maxAdjustment) {
      await interaction.editReply({
        content: `❌ Maksymalna dozwolona wartość to **${maxAdjustment} Gold**.`,
      });
      return;
    }

    try {
      const newBalance = await addGold(target.id, amount);
      await interaction.editReply({
        content: `✅ Dodano **${amount} Gold** użytkownikowi <@${target.id}>. Nowe saldo: **${newBalance} Gold**.`,
      });
    } catch (err) {
      await interaction.editReply({
        content: `❌ Błąd dodawania Gold: ${err.message}`,
      });
    }
  },
};
