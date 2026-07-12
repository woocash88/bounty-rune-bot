import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { resetUser } from '../db/queries.js';

export default {
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('[Admin] Resetuj Gold wybranego użytkownika do 0')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Użytkownik')
        .setRequired(true)
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

    await interaction.deferReply({ ephemeral: true });

    try {
      await resetUser(target.id);
      await interaction.editReply({
        content: `✅ Gold użytkownika <@${target.id}> został zresetowany do **0**.`,
      });
    } catch (err) {
      await interaction.editReply({
        content: `❌ Błąd resetowania: ${err.message}`,
      });
    }
  },
};
