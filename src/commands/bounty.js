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
      .setTitle(name)
      .setThumbnail(targetUser.displayAvatarURL())
      .setDescription(
        [
          `💰 Gold: **${stats.gold}**`,
          `🏅 Zebrane runy: **${stats.bounties_collected}**`,
          `👹 Zabite Roshany: **${stats.roshans_killed}**`,
        ].join('\n')
      );

    await interaction.editReply({ embeds: [embed] });
  },
};
