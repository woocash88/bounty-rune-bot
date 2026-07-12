import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { resetAllUsers } from '../db/queries.js';

export default {
  data: new SlashCommandBuilder()
    .setName('resetglobal')
    .setDescription('[Admin] Resetuj Gold wszystkich użytkowników do 0')
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
      await resetAllUsers();
      await interaction.editReply({
        content: '✅ Gold wszystkich użytkowników został zresetowany do **0**.',
      });
    } catch (err) {
      await interaction.editReply({
        content: `❌ Błąd resetowania: ${err.message}`,
      });
    }
  },
};
