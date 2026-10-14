import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getUserStats } from '../db/queries.js';

export default {
  data: new SlashCommandBuilder()
    .setName('bounty')
    .setDescription('Pokaż profil Bounty: Gold, zebrane Bounty i zabite Roshany')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Gracz, którego profil chcesz zobaczyć (opcjonalnie)')
        .setRequired(false),
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const stats = await getUserStats(targetUser.id);

    let name = targetUser.username;
    try {
      name = (await interaction.guild.members.fetch(targetUser.id)).displayName;
    } catch {
      // not in guild / fetch failed — username is fine
    }

    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`📊 Profil Bounty: ${name}`)
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: '💰 Gold na koncie', value: `**${stats.gold}**`, inline: true },
        { name: '🏅 Zebrane Bounty', value: `**${stats.bounties_collected}**`, inline: true },
        { name: '🧟 Zabite Roshany', value: `**${stats.roshans_killed}**`, inline: true },
      );

    await interaction.editReply({ embeds: [embed] });
  },
};
