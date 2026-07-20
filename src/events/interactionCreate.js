import { Events, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { log, error } from '../utils/logger.js';
import { addGold } from '../db/queries.js';
import { duelState, usersInActiveDuel, executeDuelAccept } from '../commands/duel.js';

const claimTimeout = parseInt(process.env.BOUNTY_CLAIM_TIMEOUT_MS, 10) || 30000;
const goldReward = parseInt(process.env.BOUNTY_GOLD_REWARD, 10) || 50;

// In-memory set of bounty message IDs currently being claimed.
// Prevents the same bounty message from paying out twice when
// two button interactions arrive near-simultaneously.
const processingMessageIds = new Set();

// ---------- Duel button handler ----------

async function handleDuelButton(interaction) {
  const customId = interaction.customId;
  const isAccept = customId.startsWith('duel_accept_');
  const duelId = customId.replace(/^duel_(accept|decline)_/, '');

  const state = duelState.get(duelId);

  if (!state || state.resolved) {
    await interaction.reply({
      content: 'Ten pojedynek już się zakończył lub wygasł.',
      ephemeral: true,
    });
    return;
  }

  // Only the challenged user can act on these buttons
  if (interaction.user.id !== state.targetId) {
    await interaction.reply({
      content: 'To nie twój pojedynek!',
      ephemeral: true,
    });
    return;
  }

  state.resolved = true;
  clearTimeout(state.timeout);
  duelState.delete(duelId);

  if (!isAccept) {
    // --- Decline ---
    releaseDuelLock(state);
    try {
      await state.message.edit({
        content: `<@${state.targetId}> odrzucił pojedynek z <@${state.challengerId}>.`,
        components: [],
      });
    } catch (e) {
      error('Error editing declined duel message:', e.message);
    }
    await interaction.reply({
      content: 'Odrzuciłeś pojedynek.',
      ephemeral: true,
    });
    return;
  }

  // --- Accept ---
  await interaction.deferReply({ ephemeral: true });

  try {
    const winnerId = await executeDuelAccept(state, interaction);

    if (winnerId) {
      await interaction.editReply({
        content: `✅ Przyjąłeś pojedynek i **${winnerId === state.targetId ? 'wygrałeś' : 'przegrałeś'}**!`,
      });
    } else {
      await interaction.editReply({
        content: 'Pojedynek został odwołany — zabrakło komuś siana.',
      });
    }
  } catch (err) {
    error('Error executing duel accept:', err.message);
    try {
      await interaction.editReply({
        content: `❌ Wystąpił błąd podczas pojedynku: ${err.message}`,
      });
    } catch {
      // Best-effort
    }
  } finally {
    releaseDuelLock(state);
  }
}

function releaseDuelLock(state) {
  usersInActiveDuel.delete(state.challengerId);
  usersInActiveDuel.delete(state.targetId);
}

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

    // --- Duel buttons ---
    if (interaction.customId.startsWith('duel_accept_') || interaction.customId.startsWith('duel_decline_')) {
      await handleDuelButton(interaction);
      return;
    }

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
