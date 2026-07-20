import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { tryDeductGold, addGold, getUserGold } from '../db/queries.js';
import { log, error } from '../utils/logger.js';

// ---------- Module-level duel state (in-memory, resets on restart) ----------

// Map<duelId, { challengerId, targetId, message, timeout, resolved }>
export const duelState = new Map();

// Set<userId> — users currently involved in a pending/in-progress duel
export const usersInActiveDuel = new Set();

// ---------- Helpers ----------

let duelIdCounter = 0;
function nextDuelId() {
  duelIdCounter++;
  return `duel_${Date.now().toString(36)}_${duelIdCounter}`;
}

function releaseDuelLock(challengerId, targetId) {
  usersInActiveDuel.delete(challengerId);
  usersInActiveDuel.delete(targetId);
}

// Pool of Polish attack phrases (picked randomly for variety)
const ATTACK_PHRASES = {
  challenger1: [
    'atakuje z pałki!',
    'wyprowadza szybki cios!',
    'rzuca się do ataku!',
    'zadaje potężny cios szablą!',
    'atakuje z impetem!',
  ],
  targetCounter: [
    'odbija atak i kontratakuje!',
    'robi unik i odpowiada ciosem!',
    'blokuje i wyprowadza kontrę!',
    'uchyla się i zadaje cios z boku!',
  ],
  challenger2: [
    'unika i zadaje cios!',
    'nie daje za wygraną i ponownie atakuje!',
    'odskakuje i ciąnie z półobrotu!',
  ],
  targetStumble: [
    'traci równowagę...',
    'chwieje się, ale próbuje bronić...',
    'jest w defensywie...',
  ],
  challengerFinal: [
    'zadaje decydujący cios!',
    'wykorzystuje szansę i kończy pojedynek!',
    'finalizuje pojedynek miażdżącym uderzeniem!',
  ],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------- Command definition ----------

const duelStake = parseInt(process.env.BOUNTY_DUEL_STAKE, 10) || 50;

export default {
  data: new SlashCommandBuilder()
    .setName('duel')
    .setDescription('Wyzwij innego użytkownika na pojedynek o Gold!')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Przeciwnik')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const challenger = interaction.user;
    const target = interaction.options.getUser('user', true);

    // --- Validation ---
    if (challenger.id === target.id) {
      await interaction.editReply({ content: 'Nie możesz wyzwać samego siebie.' });
      return;
    }

    if (target.bot) {
      await interaction.editReply({ content: 'Nie możesz wyzwać bota na pojedynek.' });
      return;
    }

    // --- Check duel lock ---
    if (usersInActiveDuel.has(challenger.id)) {
      await interaction.editReply({ content: 'Jesteś już w trakcie innego pojedynku.' });
      return;
    }

    if (usersInActiveDuel.has(target.id)) {
      await interaction.editReply({ content: `<@${target.id}> jest już w trakcie innego pojedynku.` });
      return;
    }

    // --- Read-only balance check (preliminary gate) ---
    try {
      const challengerGold = await getUserGold(challenger.id);
      const targetGold = await getUserGold(target.id);

      if (challengerGold < duelStake) {
        await interaction.editReply({ content: 'Nie masz siana na ten pojedynek.' });
        return;
      }

      if (targetGold < duelStake) {
        await interaction.editReply({ content: `<@${target.id}> nie ma siana na pojedynek.` });
        return;
      }
    } catch (err) {
      error('Error checking duel balances:', err.message);
      await interaction.editReply({ content: `❌ Błąd sprawdzania salda: ${err.message}` });
      return;
    }

    // --- Acquire duel lock ---
    const duelId = nextDuelId();
    usersInActiveDuel.add(challenger.id);
    usersInActiveDuel.add(target.id);

    // --- Send public challenge ---
    const acceptId = `duel_accept_${duelId}`;
    const declineId = `duel_decline_${duelId}`;

    const acceptBtn = new ButtonBuilder()
      .setCustomId(acceptId)
      .setLabel('Akceptuj')
      .setStyle(ButtonStyle.Success);

    const declineBtn = new ButtonBuilder()
      .setCustomId(declineId)
      .setLabel('Odrzuć')
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(acceptBtn, declineBtn);

    let message;
    try {
      message = await interaction.channel.send({
        content:
          `⚔️ <@${challenger.id}> wyzywa <@${target.id}> na pojedynek o Gold!\n` +
          `Stawka: **${duelStake} Golda** każdy — zwycięzca zgarnia całą pulę (**${duelStake * 2} Golda**)!`,
        components: [row],
      });
    } catch (err) {
      error('Error sending duel challenge:', err.message);
      releaseDuelLock(challenger.id, target.id);
      await interaction.editReply({ content: `❌ Nie udało się wysłać wyzwania: ${err.message}` });
      return;
    }

    // --- Store duel state ---
    const state = {
      challengerId: challenger.id,
      targetId: target.id,
      message,
      resolved: false,
      timeout: null,
    };
    duelState.set(duelId, state);

    // --- Set 1-minute timeout ---
    state.timeout = setTimeout(async () => {
      if (state.resolved) return;
      state.resolved = true;
      releaseDuelLock(challenger.id, target.id);
      duelState.delete(duelId);

      try {
        await message.edit({
          content: `⌛ <@${target.id}> nie odpowiedział na pojedynek w czasie. Wyzwanie wygasło.`,
          components: [],
        });
      } catch (e) {
        error('Error editing expired duel message:', e.message);
      }
    }, 60_000);

    // --- Ephemeral confirmation to challenger ---
    await interaction.editReply({
      content: `⚔️ Wyzwałeś <@${target.id}> na pojedynek o **${duelStake} Golda**! Czekamy na odpowiedź...`,
    });
  },
};

// ---------- Battle narration (called from interactionCreate on accept) ----------

/**
 * Execute the duel after both stakes are deducted.
 * Returns the winner's user ID and the edited message object.
 */
export async function executeDuelAccept(state, interaction) {
  const { challengerId, targetId, message } = state;
  const pot = duelStake * 2;

  // -- Deduct stakes atomically --
  const challengerDeducted = await tryDeductGold(challengerId, duelStake);
  const targetDeducted = await tryDeductGold(targetId, duelStake);

  // If either failed, refund and cancel
  if (!challengerDeducted || !targetDeducted) {
    // Refund whoever was successfully deducted
    if (challengerDeducted) await addGold(challengerId, duelStake);
    if (targetDeducted) await addGold(targetId, duelStake);

    let cancelMsg;
    if (!challengerDeducted && !targetDeducted) {
      cancelMsg = `❌ Pojedynek odwołany — oboje nie macie już siana.`;
    } else if (!challengerDeducted) {
      cancelMsg = `❌ Pojedynek odwołany — <@${challengerId}> nie ma już siana.`;
    } else {
      cancelMsg = `❌ Pojedynek odwołany — <@${targetId}> nie ma już siana.`;
    }

    try {
      await message.edit({ content: cancelMsg, components: [] });
    } catch (e) {
      error('Error editing cancelled duel message:', e.message);
    }

    return null; // no winner
  }

  // -- Both staked, determine winner --
  const winnerId = Math.random() < 0.5 ? challengerId : targetId;
  const loserId = winnerId === challengerId ? targetId : challengerId;

  // Credit winner
  try {
    await addGold(winnerId, pot);
  } catch (err) {
    // Crediting failed — refund both stakes so gold isn't lost
    error('Duel: crediting winner failed, refunding both stakes:', err.message);
    await addGold(challengerId, duelStake).catch(() => {});
    await addGold(targetId, duelStake).catch(() => {});
    try {
      await message.edit({
        content: `❌ Pojedynek przerwany z powodu błędu technicznego. Stawki zwrócone.`,
        components: [],
      });
    } catch (e) {
      error('Error editing duel error message:', e.message);
    }
    error(
      `Duel CRITICAL: stakes may need manual correction. Challenger=${challengerId}, Target=${targetId}, Stake=${duelStake}`
    );
    return null;
  }

  // -- Battle narration --
  const lines = [
    `⚔️ Pojedynek: <@${challengerId}> vs <@${targetId}>`,
    '',
    `🗡️ <@${challengerId}> ${pick(ATTACK_PHRASES.challenger1)}`,
    `🛡️ <@${targetId}> ${pick(ATTACK_PHRASES.targetCounter)}`,
    `🗡️ <@${challengerId}> ${pick(ATTACK_PHRASES.challenger2)}`,
    `🛡️ <@${targetId}> ${pick(ATTACK_PHRASES.targetStumble)}`,
    `🗡️ <@${challengerId}> ${pick(ATTACK_PHRASES.challengerFinal)}`,
    '',
    `🏆 <@${winnerId}> wygrywa pojedynek i zgarnia **${pot} Golda**!`,
  ].join('\n');

  try {
    // Sequential reveal for live feel (~1.5s between phases)
    const battleLines = lines.split('\n');
    let currentText = battleLines.slice(0, 3).join('\n');

    await message.edit({ content: currentText, components: [] });
    await sleep(1500);

    currentText += '\n' + battleLines[3];
    await message.edit({ content: currentText });
    await sleep(1500);

    currentText += '\n' + battleLines[4];
    await message.edit({ content: currentText });
    await sleep(1500);

    currentText += '\n' + battleLines[5];
    await message.edit({ content: currentText });
    await sleep(1500);

    currentText += '\n' + battleLines[6];
    await message.edit({ content: currentText });
    await sleep(1000);

    // Final result
    await message.edit({ content: lines });
  } catch (e) {
    error('Error during duel narration edits:', e.message);
    // Fallback: post the full result in one shot if sequential edits fail
    try {
      await message.edit({ content: lines, components: [] });
    } catch (e2) {
      error('Could not edit duel final message:', e2.message);
    }
  }

  return winnerId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
