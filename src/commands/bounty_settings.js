import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { getSettingDisplay, SETTINGS } from '../utils/settings.js';

// [setting key, slash command that changes it]
const BOUNTY_ROWS = [
  ['gold_reward', 'bounty_gold_reward'],
  ['avg_per_week', 'bounty_avg_per_week'],
  ['claim_timeout', 'bounty_claim_timeout'],
  ['duel_stake', 'bounty_duel_stake'],
];

const ROSHAN_ROWS = [
  ['roshan_entry', 'roshan_entry'],
  ['roshan_gold', 'roshan_gold'],
  ['roshan_chance_5', 'roshan_5_winchance'],
  ['roshan_chance_4', 'roshan_4_winchance'],
  ['roshan_chance_3', 'roshan_3_winchance'],
  ['roshan_death_chance', 'roshan_death_chance'],
  ['roshan_lobby_timeout', 'roshan_lobby_timeout'],
];

function format(rows) {
  return rows
    .map(([key, command]) => {
      const s = SETTINGS[key];
      return `**${s.label}**\n${getSettingDisplay(key)} ${s.unit} — \`/${command}\``;
    })
    .join('\n\n');
}

export default {
  data: new SlashCommandBuilder()
    .setName('bounty_settings')
    .setDescription('[Admin] Podsumowanie wszystkich ustawień bota')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: '❌ Nie masz uprawnień do użycia tej komendy.',
        ephemeral: true,
      });
      return;
    }

    const avg = getSettingDisplay('avg_per_week');
    const meanDays = (7 / avg).toFixed(1);

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('⚙️ Ustawienia Bounty Bota')
      .addFields(
        {
          name: '🏅 Bounty Runa i pojedynki',
          value: format(BOUNTY_ROWS) + `\n\n*Średnio jedna runa co ~${meanDays} dni.*`,
        },
        { name: '👹 Roshan', value: format(ROSHAN_ROWS) }
      )
      .setFooter({ text: 'Użyj komendy obok wartości, aby ją zmienić (bez argumentu pokazuje wartość).' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
