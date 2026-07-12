import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { triggerManualSpawn } from '../scheduler/bountyScheduler.js';
import { error } from '../utils/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('testbounty')
    .setDescription('[Admin/Dev] Natychmiast zespawnuj testową Bounty Rune')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Kanał docelowy (domyślnie losowy z BOUNTY_CHANNEL_IDS)')
        .setRequired(false)
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

    const channelOption = interaction.options.getChannel('channel');
    const targetChannelId = channelOption?.id;

    await interaction.deferReply({ ephemeral: true });

    try {
      const spawnedChannelId = await triggerManualSpawn(interaction.client, targetChannelId);
      await interaction.editReply({
        content: `✅ Testowa Bounty Rune zespawnowana na <#${spawnedChannelId}>.`,
      });
    } catch (err) {
      error('Error executing /testbounty:', err.message);
      await interaction.editReply({
        content: `❌ Nie udało się zespawnować Bounty Rune: ${err.message}`,
      });
    }
  },
};
