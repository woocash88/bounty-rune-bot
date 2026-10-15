import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { addGold } from '../db/queries.js';

const maxAdjustment = parseInt(process.env.MAX_GOLD_ADJUSTMENT, 10) || 100000;

export default {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('[Admin] Odejmij Gold użytkownikowi (nie zejdzie poniżej 0)')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Użytkownik')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('gold')
        .setDescription('Ilość Gold do odjęcia')
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

    // Input validation: reject out-of-range amounts (private, before the public reply)
    if (amount > maxAdjustment) {
      await interaction.reply({
        content: `❌ Maksymalna dozwolona wartość to **${maxAdjustment} Gold**.`,
        ephemeral: true,
      });
      return;
    }

    // Public reply: everyone sees the result
    await interaction.deferReply();

    try {
      // Pass negative amount; increment_gold clamps at 0 via GREATEST
      const newBalance = await addGold(target.id, -amount);
      await interaction.editReply({
        content: `✅ Odjęto **${amount} Gold** użytkownikowi <@${target.id}>. Nowe saldo: **${newBalance} Gold**.`,
      });
    } catch (err) {
      // Keep errors private: drop the public placeholder, then tell only the admin
      await interaction.deleteReply().catch(() => {});
      await interaction.followUp({
        content: `❌ Błąd odejmowania Gold: ${err.message}`,
        ephemeral: true,
      });
    }
  },
};
