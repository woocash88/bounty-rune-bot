import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { tryDeductGold, addGold, getUserGold } from '../db/queries.js';
import { error } from '../utils/logger.js';

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

// Battle narration variants
// Each variant produces exactly 5 lines
const DUEL_VARIANTS = [
  // Variant 0 — Starcie na miecze
  (challenger, target) => [
    `🗡️ ${challenger} od razu wyciąga Diffusal Blade i atakuje frontalnie!`,
    `🛡️ ${target} odparowuje i kontratakuje!`,
    `🗡️ ${challenger} używa Manta Style i atakuje kolejny raz!`,
    `🛡️ ${target} aktywuje Shiva's Guard ale czy to wystarczy?!`,
    `😱 Cóż za starcie!!!`,
  ],
  // Variant 1 — Złoty Cios
  (challenger, target) => [
    `🥊 ${challenger} rusza z ostateczną szarżą ostatkiem sił!`,
    `🛡️ ${target} opuszcza gardę i stawia wszystko na jeden, decydujący kontratak!`,
    `💥 Obaj wyprowadzają potężny sierpowy w tym samym ułamku sekundy!`,
    `😵 Nogi z waty, obaj lecą na dechy w zwolnionym tempie...`,
    `🔔 Sędzia liczy do dziesięciu... Kto podniesie się z maty jako pierwszy?!`,
  ],
  // Variant 2 — Pojedynek magiczny
  (challenger, target) => [
    `✨ ${challenger} rzuca Frostbite i usztywnia przeciwnika!`,
    `🔮 ${target} odpala BKB i kontruje!`,
    `✨ ${challenger} robi szybki unik Force Staffem i szykuje Laguna Blade!`,
    `🔮 ${target} BKB właśnie się skończyło, Finger of Death już załadowany!`,
    `⚡ Kto jest szybszy?! Napięcie sięga zenitu...`,
  ],
  // Variant 3 — Starcie Tytanów (i ich kręgosłupów)
  (challenger, target) => [
    `💀 ${challenger} nakłada 200kg na martwy ciąg i podnosi to... samym wygiętym kręgosłupem!`,
    `🚑 ${target} kontruje, robiąc bicepsy hantlami, przy których buja się jak paralityk!`,
    `🤯 ${challenger} próbuje zrobić najszerszy grzbietu, ale zamiast tego pękają mu szwy w koszulce!`,
    `🤢 ${target} robi tak czerwoną twarz przy wyciskaniu, że mylisz go z gaśnicą!`,
    `💥 Kręgi strzelają, lustra pękają, a fizjoterapeuta już zaciera ręce!!!`,
  ],
  // Variant 4 — Solówka na Midzie (Syndrom Łysego)
  (challenger, target) => [
    `⚔️ ${challenger} wbija na mida z agresywnym harassem i próbuje zgarnąć first blooda!`,
    `🕷️ ${target} nagle odpala full lock-in i blokuje creepy dupką idealnie jak Łysy swoją legendarną Broodką!`,
    `🤯 ${challenger} patrzy na te perfekcyjne last hity i od razu pisze na all-czacie: "Ile dałeś za tego boosta?"`,
    `🤬 ${target} odpisuje w panice: "TO JA GRAM MORDO, ZOBACZYSZ GG W 20 MINUT, MAKRO OPANOWANE!"`,
    `❓ Zmarnował cenne sekundy na pisanie pod ostrzałem wieży... Czy zdoła uciec z resztką HP czy odda głupiego killa?!`,
  ],
  // Variant 5 — Pojedynek na łuki
  (challenger, target) => [
    `🏹 ${challenger} strzela z dystansu, strzała przecina wszystko jak żyletka!`,
    `🔫 ${target} uchyla się padając na ziemie i szykuje do kontry!`,
    `🏹 ${challenger} sięga po nową strzałę, chowając się za drzewem!`,
    `🔫 ${target} Cel widoczny, strzela!! Pif Paf xDDDD `,
    `🎯 Kurz się unosi... nie widać zwycięzcy... o jest...!!..`,
  ],
  // Variant 6 — Starcie o ostatniego harnasia
  (challenger, target) => [
    `🩴 ${challenger} rzuca podkręconym klapkiem Kubota!`,
    `🛡️ ${target} taktyczna zasłona reklamówką z Biedry!`,
    `💨 ${challenger} bierze energetycznego bucha z e-fajki`,
    `🍌 ${target} wyciąga Harnasia z reklamówki i zeruje go w 2sekundy`,
    `🤦 Nie wiem kto to pisał, ale ktoś musi tutaj wygrać, więc...`,
  ],
  // Variant 7 — Błotna Masakra
  (challenger, target) => [
    `💩 ${challenger} ciska potężną bryłą błota prosto w twarz przeciwnika!`,
    `🍌 ${target} próbuje zrobić unik, ale ślizga się i ląduje na dupie!`,
    `💦 ${challenger} wykonuje efektowny skok "na bombę" w sam środek kałuży!`,
    `🐷 ${target} jest już tak oblepiony błotem, że przypomina smutnego prosiaczka🐖!`,
    `💥 Obaj są tak brudni, że sędzia nie wie który jest który i wybiera losowego zwycięzce!!!`,
  ],
  // Variant 8 — PGL Rap Major
  (challenger, target) => [
    `💸 ${challenger} nawija szybciej niż Joxxim podmienia itemy w oknie wymiany!`,
    `🔇 ${target} paruje dissy, wrzucając rywala na ignore listę!`,
    `🙃 ${challenger} pluje rymami ostrymi, aż przeciwnika pośladki pieką `,
    `🎒 ${target} dusi się ze śmiechu, widząc przeciwnika ekwipunek pełen commonów!`,
    `🎧 Mikrofony spalone, a lobby zgłoszone za toksyczność!!!`,
  ],
  // Variant 9 — Starcie na Rynku Społeczności
  (challenger, target) => [
    `🤑 ${challenger} uderza z grubej rury: oferuje 3 commony za Arcanę!`,
    `🛡️ ${target} paruje cios szybkim "lowball = block -rep"!`,
    `🤡 ${challenger} odpala taktykę na Joxxiego i podmienia itemy w ostatniej sekundzie!`,
    `📱 ${target} w panice szuka telefonu ze Steam Guardem, ale upuszcza go pod biurko!`,
    `📉 Ekwipunek wyczyszczony do zera.… ale czyj?!`,
  ],
  // Variant 10 — Wściekły Roshan (Gank na leżu)
  (challenger, target) => [
    `🧀 ${challenger} wpada do groty Roshana, próbując ukraść Aegisa w ostatniej sekundzie!`,
    `💥 ${target} odpala Blink Daggera i rzuca Stuna prosto w rywala!`,
    `🧟 Roshan wścieka się na obydwu i zaczyna walić obszarowo po łbach!`,
    `🎒 ${challenger} i ${target} biją się resztkami sił o leżącego na ziemi Aegisa!`,
    `❓ Dym opada, Roshan spierdolił... Ale kto w końcu podniósł tego Aegisa?!`,
  ],
  // Variant 11 — Awaria na Lan-Party (Gimbaza 2012)
  (challenger, target) => [
    `🍕 ${challenger} ciska w rywala kawałkiem zimnej hawajskiej i potyka się o kabel od kabla LAN!`,
    `🔌 ${target} odpiera atak, przypadkowo wyciągając wtyczkę od monitora przeciwnika!`,
    `🤬 ${challenger} gra na ślepo, waląc pięścią w klawiaturę i drąc się na całe osiedle!`,
    `🥤 ${target} ze stresu wylewa Colę na listwę zasilającą – sypią się iskry!`,
    `⚡ Bezpieczniki wywaliło w całym bloku! Kto w ciemności wymierzył ostatni cios?!`,
  ],
  // Variant 12 — Walka o Ostatniego Kebabka
  (challenger, target) => [
    `🥙 ${challenger} robi zamach na ostatniego kebaba z sosem mieszanym!`,
    `🌶️ ${target} kontruje, waląc mu ostry sos na spód bułki!`,
    `🙈 ${challenger} na ślepo wymachuje widelczykiem, siejąc spustoszenie w lokalu!`,
    `🍟 ${target} poślizgnął się na frytce, a kebab wypada mu z ręki!`,
    `😱 Kebab leci w powietrzu w zwolnionym tempie... W czyich ustach wyląduje?!`,
  ],
  // Variant 13 — Wszechmocny Techies (Saper na Midzie)
  (challenger, target) => [
    `💣 ${challenger} wbiega na rywala z pełną prędkością, szykując Suicide Squad!`,
    `⛏️ ${target} używa Eul'a i podrzuca agresora w powietrze, zyskując cenne sekundy!`,
    `💥 ${challenger} spada z nieba prosto w gniazdo zielonych min pod wieżą!`,
    `😱 ${target} zdaje sobie sprawę, że sam stoi na środku tego pola minowego!`,
    `🧨 ŁOMOT na pół mapy! Czy ${target} jakimś cudem przeżył?!`,
  ],
  // Variant 14 — Błędy w Matrixie (Lag / high ping battle)
  (challenger, target) => [
    `🌐 ${challenger} próbuje wyprowadzić cios, ale dostaje skoku pingu do 999ms!`,
    `🛜 ${target} próbuje go zaatakować, ale skacze się po całej mapie z powodu utraty pakietów!`,
    `📉 ${challenger} zamraża się w absolutnie absurdalnej pozie na środku rzeki!`,
    `🔄 ${target} odpala Earth Splitter, który wchodzi z 5-sekundowym opóźnieniem!`,
    `⌛ Łącze wraca do normy, animacje odpalają się naraz... Kto w ogóle przeżył ten lag?!`,
  ],
];

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
          content: `⌛ <@${challenger.id}> rzucił wyzwanie <@${target.id}>, lecz ten nie podjął rękawicy.`,
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

  // -- Fetch display names (no-ping alternatives for narration lines) --
  let challengerName = challengerId;
  let targetName = targetId;
  try {
    const challengerMember = await interaction.guild.members.fetch(challengerId);
    challengerName = challengerMember.displayName;
  } catch {
    try {
      const challengerUser = await interaction.client.users.fetch(challengerId);
      challengerName = challengerUser.username;
    } catch {
      // absolute fallback — raw ID string, no ping
    }
  }
  try {
    const targetMember = await interaction.guild.members.fetch(targetId);
    targetName = targetMember.displayName;
  } catch {
    try {
      const targetUser = await interaction.client.users.fetch(targetId);
      targetName = targetUser.username;
    } catch {
      // absolute fallback — raw ID string, no ping
    }
  }

  // -- Battle narration --
  const variantIndex = Math.floor(Math.random() * DUEL_VARIANTS.length);
  const variantLines = DUEL_VARIANTS[variantIndex](challengerName, targetName);

  const lines = [
    `⚔️ Pojedynek: <@${challengerId}> vs <@${targetId}>`,
    '',
    ...variantLines,
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