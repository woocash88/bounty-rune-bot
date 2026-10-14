import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import { join } from 'path';
import { readFileSync } from 'fs';
import { addGold, getUserGold, tryDeductGold, incrementStat } from '../db/queries.js';
import { error } from '../utils/logger.js';
import { getSetting } from '../utils/settings.js';

// ---------- Config ----------

const MAX_PLAYERS = 5;
const MIN_PLAYERS = 3;
const REJOIN_COOLDOWN_MS = 60_000;

// Runtime-configurable (see /roshan_gold, /roshan_*_winchance, /roshan_lobby_timeout)
const WIN_CHANCE_KEY = { 3: 'roshan_chance_3', 4: 'roshan_chance_4', 5: 'roshan_chance_5' };

// ---------- Module-level state (in-memory, resets on restart) ----------

// Map<lobbyId, lobby>
export const roshanLobbies = new Map();

// Map<userId, lobbyId> — players currently in a lobby / fight
const userLobby = new Map();

// Map<userId, timestamp> — when the user may join again after leaving
const rejoinAt = new Map();

// Set<channelId> — one lobby per channel
const channelsWithLobby = new Set();

let lobbyCounter = 0;

// ---------- Narration ----------

const ROSHAN_VARIANTS = [
  (names) => [
    `🧟 ${names} wchodzą do groty Roshana, a ten otwiera jedno oko i uderza Slamem!`,
    `🗡️ Drużyna kontruje wszystkimi czarami i itemami, jakie mają, a Roshan ryczy w fazie wściekłości...`,
    `🥁 Ostatnia wymiana ciosów... kto padnie?!`,
  ],
  (names) => [
    `🔔 ${names} budzą Roshana kopniakiem w tyłek, a ten młóci łapami na oślep!`,
    `💀 Tank łapie aggro, ale ktoś zapomniał o BKB i właśnie leci w powietrze...`,
    `🎲 Hp Roshana spada do resztek... a drużyna też ledwo stoi!`,
  ],
  (names) => [
    `🧀 ${names} podkradają się pod leże, licząc na Aegisa i ser!`,
    `⚡ Roshan rzuca w nich głazem, drużyna odpala wszystkie ulty naraz, a połowa trafia w ścianę...`,
    `🌫️ Dym opada, a w grocie słychać tylko ciężki oddech...`,
  ],
  (names) => [
    `🪓 ${names} wpadają do jaskini z krzykiem "ZA AEGISA!" i od razu dostają Slamem w twarz!`,
    `🍞 Support rzuca w Roshana bułką z Biedry, dla którego to najwyraźniej śmiertelna obraza...`,
    `😱 Roshan ryczy tak, że na mapie gasną światła... kto się podniesie?!`,
  ],
  (names) => [
    `📢 ${names} wbijają na Roshana, bo "tylko 10 minut do końca gry, zdążymy!".`,
    `🤦 Carry jest na farmie, support na wardach, a Roshan już bije po łbach tych, którzy dotarli...`,
    `⏳ W oddali słychać jeszcze krzyk "ZARAZ BĘDĘ!"... ale czy zdążą?!`,
  ],
  (names) => [
    `🧙 ${names} odpalają Black King Bar i ruszają na Roshana jak na rodzinny obiad!`,
    `🥩 Roshan kontruje Roar'em i zamienia kilku z nich w kotlety schabowe!`,
    `🔥 Pozostali walczą dalej na kolanach... komu zostanie ostatni cios?!`,
  ],
  (names) => [
    `📱 ${names} ustawiają drużynę na Discordzie, ale pół składu gada o czymś zupełnie innym...`,
    `😴 Roshan ziewa, drapie się po brzuchu i dopiero potem zaczyna walić ogonem!`,
    `🎯 Ktoś krzyczy "FOKUS NA ROSHANA!", a nikt nie wie, kto jest tank... kto przeżyje?!`,
  ],
  (names) => [
    `🚪 ${names} wchodzą do jaskini cichutko jak ninja... po czym ktoś potyka się o własny Blink Dagger!`,
    `🪨 Roshan budzi się wściekły, rzuca w nich skałą i traci przy tym dwa zęby!`,
    `🦷 Jeden ząb leci w górę w zwolnionym tempie... kto go złapie, ten pewnie wygra!`,
  ],
];

// ---------- Helpers ----------

/** roshan.png from the assets folder, or null if missing (embed works without it). */
function buildRoshanAttachment() {
  try {
    const buffer = readFileSync(join(process.cwd(), 'assets', 'roshan.png'));
    return new AttachmentBuilder(buffer, { name: 'roshan.png' });
  } catch {
    return null;
  }
}


/** Minimum balance to fight: an equal share of the penalty for a party of this size. */
function requiredGold(partySize) {
  return Math.ceil(getSetting('roshan_gold') / Math.max(partySize, MIN_PLAYERS));
}

function chanceFor(n) {
  const key = WIN_CHANCE_KEY[n];
  return key ? getSetting(key) / 100 : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split `total` into n integer parts that sum exactly to total. */
function splitEvenly(total, n) {
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

function releaseLobby(lobbyId) {
  const lobby = roshanLobbies.get(lobbyId);
  if (!lobby) return;
  clearTimeout(lobby.timeout);
  for (const id of lobby.players) userLobby.delete(id);
  channelsWithLobby.delete(lobby.channelId);
  roshanLobbies.delete(lobbyId);
}

function buildLobbyView(lobby) {
  const n = lobby.players.length;
  const filled = '🟩'.repeat(n) + '⬛'.repeat(MAX_PLAYERS - n);
  const list = n
    ? lobby.players.map((id, i) => `${i + 1}. <@${id}>${lobby.ready.has(id) ? ' ✅' : ''}`).join('\n')
    : '*Nikt jeszcze nie dołączył...*';

  const gold = getSetting('roshan_gold');
  const expiresUnix = Math.floor(lobby.expiresAt / 1000);

  const embed = new EmbedBuilder()
    .setColor(0xb71c1c)
    .setTitle('👹 Roshan się pojawił!')
    .setDescription(
      `Zbierz drużynę min. ${MIN_PLAYERS} osób aby stawić czoło Roshanowi!\n` +
        `Nagroda dla drużyny: **${gold}g** (przegrana zabiera **${gold}g** drużynie).\n` +
        `Roshan ucieknie <t:${expiresUnix}:R>`
    )
    .setThumbnail('attachment://roshan.png')
    .addFields({ name: `Drużyna ${n}/${MAX_PLAYERS}`, value: `${filled}\n${list}` });

  if (n >= MIN_PLAYERS && n < MAX_PLAYERS) {
    embed.addFields({
      name: 'Gotowość',
      value: `Gotowi: **${lobby.ready.size}/${n}** — walka rusza, gdy wszyscy klikną Start.`,
    });
  }

  const joinBtn = new ButtonBuilder()
    .setCustomId(`roshan_join_${lobby.id}`)
    .setLabel('Dołącz do drużyny')
    .setStyle(ButtonStyle.Success)
    .setDisabled(n >= MAX_PLAYERS);
  const leaveBtn = new ButtonBuilder()
    .setCustomId(`roshan_leave_${lobby.id}`)
    .setLabel('Opuść drużynę')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(n === 0);
  const buttons = [joinBtn, leaveBtn];

  if (n >= MIN_PLAYERS && n < MAX_PLAYERS) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`roshan_start_${lobby.id}`)
        .setLabel(`Start (${lobby.ready.size}/${n})`)
        .setStyle(ButtonStyle.Danger)
    );
  }

  return { content: '', embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] };
}

// ---------- Command ----------

export default {
  data: new SlashCommandBuilder()
    .setName('roshan')
    .setDescription('Przywołaj Roshana i zbierz drużynę, żeby go pokonać!'),

  async execute(interaction) {
    if (channelsWithLobby.has(interaction.channelId)) {
      await interaction.reply({
        content: 'Na tym kanale Roshan już czeka na śmiałków!',
        ephemeral: true,
      });
      return;
    }

    const timeoutMs = getSetting('roshan_lobby_timeout') * 60_000;
    const id = `${Date.now().toString(36)}_${++lobbyCounter}`;
    const lobby = {
      id,
      channelId: interaction.channelId,
      players: [],
      ready: new Set(),
      message: null,
      fighting: false,
      timeout: null,
      timeoutMs,
      expiresAt: Date.now() + timeoutMs,
    };
    channelsWithLobby.add(lobby.channelId);
    roshanLobbies.set(id, lobby);

    try {
      const view = buildLobbyView(lobby);
      const attachment = buildRoshanAttachment();
      if (attachment) view.files = [attachment];
      await interaction.reply(view);
      lobby.message = await interaction.fetchReply();
    } catch (err) {
      error('Error sending Roshan lobby:', err.message);
      releaseLobby(id);
      return;
    }

    lobby.timeout = setTimeout(async () => {
      if (lobby.fighting) return;
      releaseLobby(id);
      try {
        await lobby.message.edit({
          content: '⌛ Roshan uciekł — nikt nie zebrał drużyny.',
          embeds: [],
          attachments: [],
          components: [],
        });
      } catch (e) {
        error('Error editing expired Roshan message:', e.message);
      }
    }, timeoutMs);
  },
};

// ---------- Button handler (called from interactionCreate) ----------

export async function handleRoshanButton(interaction) {
  const [, action, ...rest] = interaction.customId.split('_');
  const lobbyId = rest.join('_');
  const lobby = roshanLobbies.get(lobbyId);
  const userId = interaction.user.id;

  if (!lobby || lobby.fighting) {
    await interaction.reply({
      content: 'Ta wyprawa na Roshana już się zakończyła lub trwa.',
      ephemeral: true,
    });
    return;
  }

  const isMember = lobby.players.includes(userId);

  if (action === 'join') {
    if (isMember) {
      await interaction.reply({ content: 'Już jesteś w drużynie.', ephemeral: true });
      return;
    }
    if (userLobby.has(userId)) {
      await interaction.reply({ content: 'Jesteś już w innej drużynie na Roshana.', ephemeral: true });
      return;
    }
    if (lobby.players.length >= MAX_PLAYERS) {
      await interaction.reply({ content: 'Drużyna jest pełna.', ephemeral: true });
      return;
    }
    // Must be able to cover an equal share of the penalty, otherwise the
    // fight would be risk-free for them.
    // Party size isn't final yet, so use the size it would have with this player
    // (at least 3). The binding check happens right before the fight.
    const required = requiredGold(lobby.players.length + 1);
    const balance = await getUserGold(userId);
    if (balance < required) {
      await interaction.reply({
        content: `Do walki z Roshanem potrzebujesz minimum **${required} Golda** (masz ${balance}). Im większa drużyna, tym niższy próg wejścia.`,
        ephemeral: true,
      });
      return;
    }

    const wait = (rejoinAt.get(userId) ?? 0) - Date.now();
    if (wait > 0) {
      await interaction.reply({
        content: `Niedawno opuściłeś drużynę. Możesz dołączyć ponownie za ${Math.ceil(wait / 1000)}s.`,
        ephemeral: true,
      });
      return;
    }

    lobby.players.push(userId);
    userLobby.set(userId, lobby.id);
    lobby.ready.clear(); // party changed — everyone must confirm again
  } else if (action === 'leave') {
    if (!isMember) {
      await interaction.reply({ content: 'Nie jesteś w tej drużynie.', ephemeral: true });
      return;
    }
    lobby.players = lobby.players.filter((p) => p !== userId);
    userLobby.delete(userId);
    lobby.ready.clear();
    rejoinAt.set(userId, Date.now() + REJOIN_COOLDOWN_MS);
  } else if (action === 'start') {
    if (!isMember) {
      await interaction.reply({ content: 'Tylko członkowie drużyny mogą zatwierdzić start.', ephemeral: true });
      return;
    }
    if (lobby.players.length < MIN_PLAYERS) {
      await interaction.reply({ content: `Potrzeba minimum ${MIN_PLAYERS} graczy.`, ephemeral: true });
      return;
    }
    lobby.ready.add(userId);
  } else {
    return;
  }

  const n = lobby.players.length;
  const everyoneReady = n >= MIN_PLAYERS && lobby.players.every((p) => lobby.ready.has(p));
  const shouldStart = n === MAX_PLAYERS || everyoneReady;

  if (shouldStart) {
    // Lock first (sync) so a second near-simultaneous click can't start it twice.
    lobby.fighting = true;

    // Balances may have dropped since joining (duel, /give, ...). Re-check right
    // before the fight so nobody risks less than their share.
    const required = requiredGold(lobby.players.length);
    const broke = [];
    for (const id of lobby.players) {
      if ((await getUserGold(id)) < required) broke.push(id);
    }
    if (broke.length > 0) {
      lobby.players = lobby.players.filter((p) => !broke.includes(p));
      for (const id of broke) userLobby.delete(id);
      lobby.ready.clear();
      lobby.fighting = false;
      await interaction.update({
        ...buildLobbyView(lobby),
        content:
          `⚠️ Z drużyny wypadli (mniej niż **${required} Golda**): ${broke.map((id) => `<@${id}>`).join(' ')}. ` +
          `Walka nie wystartowała.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    clearTimeout(lobby.timeout);
    await interaction.update({ components: [] });
    try {
      await runFight(lobby);
    } catch (err) {
      error('Error during Roshan fight:', err.message);
      try {
        await lobby.message.edit({
          content: '❌ Walka z Roshanem przerwana z powodu błędu technicznego.',
          embeds: [],
          components: [],
        });
      } catch {
        // Best-effort
      }
    } finally {
      releaseLobby(lobby.id);
    }
    return;
  }

  await interaction.update(buildLobbyView(lobby));
}

// ---------- Fight ----------

async function displayName(client, guild, userId) {
  try {
    return (await guild.members.fetch(userId)).displayName;
  } catch {
    try {
      return (await client.users.fetch(userId)).username;
    } catch {
      return userId;
    }
  }
}

async function runFight(lobby) {
  const { message, players } = lobby;
  const n = players.length;
  const win = Math.random() < chanceFor(n);
  const shares = splitEvenly(getSetting('roshan_gold'), n);

  // -- Settle gold first, so the narration never promises what didn't happen --
  const settlement = [];
  if (win) {
    for (let i = 0; i < n; i++) {
      await addGold(players[i], shares[i]);
      await incrementStat(players[i], 'roshans_killed').catch((e) =>
        error('Could not increment roshans_killed:', e.message)
      );
      settlement.push({ id: players[i], amount: shares[i] });
    }
  } else {
    for (let i = 0; i < n; i++) {
      // Take the share, or whatever the player has if they can't cover it.
      let take = Math.min(shares[i], await getUserGold(players[i]));
      if (take > 0 && !(await tryDeductGold(players[i], take))) {
        take = Math.min(shares[i], await getUserGold(players[i]));
        if (take > 0 && !(await tryDeductGold(players[i], take))) take = 0;
      }
      settlement.push({ id: players[i], amount: take });
    }
  }

  // Narration uses plain display names (no pings); resolve them now.
  const guild = message.guild;
  const client = message.client;
  const resolved = await Promise.all(players.map((id) => displayName(client, guild, id)));
  const namesText = resolved.join(', ');

  const variant = ROSHAN_VARIANTS[Math.floor(Math.random() * ROSHAN_VARIANTS.length)];
  const story = variant(namesText);

  const header = `O bogowie walka! ⚔️\n${players.map((id) => `<@${id}>`).join(' ')}\n`;
  const resultLines = win
    ? [
        `🏆 **Roshan pokonany!**`,
        ...settlement.map((s) => `💰 <@${s.id}> +**${s.amount}** Golda`),
        `🛡️ Aegis zabezpieczony, ${getSetting('roshan_gold')} Golda do podziału!`,
      ]
    : [
        `💀 **Roshan wygrywa!**`,
        ...settlement.map((s) => `💸 <@${s.id}> -**${s.amount}** Golda`),
      ];

  let text = header;
  await message.edit({ content: text, embeds: [], components: [], attachments: [] });

  for (const line of story) {
    await sleep(1500);
    text += '\n' + line;
    await message.edit({ content: text });
  }

  await sleep(1500);
  text += '\n\n' + resultLines.join('\n');
  await message.edit({ content: text });
}
