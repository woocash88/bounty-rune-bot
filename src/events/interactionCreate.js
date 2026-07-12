import { Events, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { log, error } from '../utils/logger.js';
import { addGold } from '../db/queries.js';

const claimTimeout = parseInt(process.env.BOUNTY_CLAIM_TIMEOUT_MS, 10) || 30000;
const goldReward = parseInt(process.env.BOUNTY_GOLD_REWARD, 10) || 50;

// In-memory set of bounty message IDs currently being claimed.
// Prevents the same bounty message from paying out twice when
// two button interactions arrive near-simultaneously.
const processingMessageIds = new Set();

export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    // --- Slash commands ---
    if (interaction.isChatInputCommand()) {
      const { default: command } = await import(`../commands/${interaction.commandName}.js`);
      if (command) {
        try {
          await command.execute(interaction);
        } catch (err) {
          error(`Error executing /${interaction.commandName}:`, err.message);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: 'Wystąpił błąd podczas wykonywania komendy.',
              ephemeral: true,
            });
          }
        }
      }
      return;
    }

    // --- Button interactions ---
    if (!interaction.isButton()) return;

    if (interaction.customId !== 'bounty_claim') return;

    // ---------- Bounty claim flow ----------
    // 1) Defer immediately to prevent 3-second timeout
    await interaction.deferReply({ ephemeral: true });

    const messageId = interaction.message.id;

    // 2) Check for in-flight claim on this exact message
    if (processingMessageIds.has(messageId)) {
      await interaction.editReply({
        content: 'Ktoś już zdobył tę runę! ⏳',
      });
      return;
    }

    // 3) Mark as processing — this message can only pay out once
    processingMessageIds.add(messageId);

    try {
      // 4) Disable the button on the original message so no further clicks
      //    work even if the interaction arrives later (e.g. gateway delay).
      try {
        const message = interaction.message;
        if (message.components?.length > 0) {
          const originalButton = ButtonBuilder.from(message.components[0].components[0]);
          const disabledRow = new ActionRowBuilder().addComponents(
            originalButton.setDisabled(true)
          );
          await message.edit({ components: [disabledRow] });
        }
      } catch (btnErr) {
        // Message may already have been deleted by Discord or another
        // instance — that's fine, proceed to check gold award anyway.
        log('Could not disable button (message may be gone):', btnErr.message);
      }

      // 5) Award gold atomically via Supabase RPC
      const userId = interaction.user.id;
      const newBalance = await addGold(userId, goldReward);

      // 6) Replace the original message with a public claim announcement
      try {
        await interaction.message.edit({
          content: `<@${userId}> zgarnął **${goldReward} Golda**! 😎`,
          embeds: [],
          components: [],
          attachments: [],
        });
      } catch (editErr) {
        log('Could not edit message to public claim (permissions?):', editErr.message);
      }

      // 7) Confirm to the clicking user
      await interaction.editReply({
        content: `Zdobyłeś **${goldReward} Gold**! 💰 Twoje nowe saldo: **${newBalance} Gold**.`,
      });

      // 8) Auto-dismiss the ephemeral reply after claimTimeout ms
      setTimeout(async () => {
        try {
          await interaction.deleteReply();
        } catch {
          // User may have already dismissed it manually
        }
      }, claimTimeout);
    } catch (err) {
      error('Error handling bounty_claim:', err.message);

      try {
        await interaction.editReply({
          content: 'Wystąpił błąd podczas zbierania Bounty Rune. Spróbuj ponownie.',
        });
      } catch {
        // Ephemeral reply may have failed — nothing more we can do
      }
    }
  },
};
