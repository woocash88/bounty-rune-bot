import { SlashCommandBuilder } from 'discord.js';
import { tryDeductGold, addGold, tryClaimGive, releaseGiveClaim } from '../db/queries.js';
import { log, error } from '../utils/logger.js';
import { getSetting } from '../utils/settings.js';

export default {
  data: new SlashCommandBuilder()
    .setName('give')
    .setDescription('Oddaj część swojego Golda innemu użytkownikowi')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Odbiorca')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('Ilość Gold do przekazania')
        .setRequired(true)
        .setMinValue(1)
    ),

  async execute(interaction) {
    const giver = interaction.user;
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);

    // Validation (private)
    if (target.id === giver.id) {
      await interaction.reply({ content: 'Nie możesz dać Golda samemu sobie.', ephemeral: true });
      return;
    }

    if (target.bot) {
      await interaction.reply({ content: 'Nie możesz przekazać Golda botowi.', ephemeral: true });
      return;
    }

    // Public reply: everyone sees the transfer
    await interaction.deferReply();

    // Errors are private: drop the public placeholder and tell only the giver
    const fail = async (content) => {
      await interaction.deleteReply().catch(() => {});
      await interaction.followUp({ content, ephemeral: true });
    };

    // Weekly limit: claim the giver's slot atomically *before* moving any gold
    const cooldownDays = getSetting('give_cooldown_days');
    let claimed = false;
    let deducted = false;

    try {
      if (cooldownDays > 0) {
        const nextAllowed = await tryClaimGive(giver.id, cooldownDays * 86400);
        if (nextAllowed) {
          await fail(
            `Możesz przekazać Gold tylko raz na ${cooldownDays} dni. ` +
              `Następne przekazanie: <t:${Math.floor(nextAllowed.getTime() / 1000)}:F> (<t:${Math.floor(nextAllowed.getTime() / 1000)}:R>).`
          );
          return;
        }
        claimed = true;
      }

      deducted = await tryDeductGold(giver.id, amount);

      if (!deducted) {
        if (claimed) await releaseGiveClaim(giver.id).catch(() => {});
        await fail('Hej nie masz tyle golda.');
        return;
      }

      const newBalance = await addGold(target.id, amount);

      log(`Give: ${giver.id} -> ${target.id}, amount=${amount}`);

      await interaction.editReply({
        content: `<@${giver.id}> przekazał **${amount} Golda** użytkownikowi <@${target.id}>! 🤝`,
      });
    } catch (err) {
      error('Error executing /give:', err.message);
      // Nothing was transferred, so don't burn the user's weekly slot
      if (claimed && !deducted) await releaseGiveClaim(giver.id).catch(() => {});
      await fail(`❌ Wystąpił błąd podczas przekazywania Golda: ${err.message}`);
    }
  },
};
