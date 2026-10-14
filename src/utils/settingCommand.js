import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { SETTINGS, getSettingDisplay, setSetting } from './settings.js';
import { error } from './logger.js';

/**
 * Build an admin slash command that shows/changes one runtime setting.
 * Without an argument it just shows the current value.
 *
 * @param {string} name - slash command name
 * @param {string} key - key in SETTINGS
 * @param {(interaction, newValue) => Promise<string|void>} [afterSet] - optional hook,
 *   may return an extra line to append to the reply
 */
export function makeSettingCommand(name, key, afterSet) {
  const s = SETTINGS[key];

  return {
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(`[Admin] ${s.label}`.slice(0, 100))
      .addNumberOption((option) => {
        option
          .setName('value')
          .setDescription(`Nowa wartość (${s.min}–${s.max} ${s.unit})`)
          .setRequired(false)
          .setMinValue(s.min)
          .setMaxValue(s.max);
        return option;
      })
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

      const value = interaction.options.getNumber('value');
      if (value === null) {
        await interaction.editReply({
          content: `⚙️ ${s.label}: **${getSettingDisplay(key)} ${s.unit}**`,
        });
        return;
      }

      if (s.int && !Number.isInteger(value)) {
        await interaction.editReply({ content: '❌ Ta wartość musi być liczbą całkowitą.' });
        return;
      }

      try {
        const old = getSettingDisplay(key);
        await setSetting(key, value);
        let extra = '';
        if (afterSet) extra = (await afterSet(interaction, value)) ?? '';
        await interaction.editReply({
          content: `✅ ${s.label}: **${old}** → **${value} ${s.unit}**${extra ? `\n${extra}` : ''}`,
        });
      } catch (err) {
        error(`Failed to set ${key}:`, err.message);
        await interaction.editReply({ content: `❌ Nie udało się zapisać ustawienia: ${err.message}` });
      }
    },
  };
}
