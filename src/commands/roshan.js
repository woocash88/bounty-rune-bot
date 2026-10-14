import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
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
    `🧟 ${names} wchodzą do groty Roshana, a ten otwiera jedno oko...`,
    `💥 Roshan uderza Slamem, ziemia drży!`,
    `🗡️ Drużyna kontruje wszystkimi czarami i itemami, jakie mają!`,
    `🩸 Roshan ryczy i wchodzi w fazę wściekłości...`,
    `🥁 Ostatnia wymiana ciosów... kto padnie?!`,
  ],
  (names) => [
    `🔔 ${names} budzą Roshana kopniakiem w tyłek!`,
    `😡 Roshan nie lubi pobudki i zaczyna młócić łapami na oślep!`,
    `🛡️ Tank łapie aggro, reszta sypie DPS-em z tyłu!`,
    `💀 Ktoś zapomniał o BKB i właśnie leci w powietrze...`,
    `🎲 Hp Roshana spada do resztek... a drużyna też ledwo stoi!`,
  ],
  (names) => [
    `🧀 ${names} podkradają się pod leże, licząc na Aegisa i ser!`,
    `🐻 Roshan zrywa się z legowiska i rzuca w nich głazem!`,
    `⚡ Drużyna odpala wszystkie ulty naraz!`,
    `🤦 Połowa ultów trafia w ścianę, druga połowa w sojuszników...`,
    `🌫️ Dym opada, a w grocie słychać tylko ciężki oddech...`,
  ],
];

// ---------- Helpers ----------

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

  const chanceLine = [3, 4, 5]
    .map((k) => `${k} graczy: **${Math.round(chanceFor(k) * 100)}%**`)
    .join(' • ');

  const embed = new EmbedBuilder()
    .setColor(0xb71c1c)
    .setTitle('🧟 Roshan się pojawił!')
    .setDescription(
      `Zbierz drużynę (min. ${MIN_PLAYERS}, max ${MAX_PLAYERS}) i pokonaj Roshana!\n` +
        `Nagroda: **${getSetting('roshan_gold')} Golda** (dzielone po równo). ` +
        `Porażka kosztuje drużynę **${getSetting('roshan_gold')} Golda** (też po równo).`
    )
    .addFields(
      { name: `Drużyna ${n}/${MAX_PLAYERS}`, value: `${filled}\n${list}` },
      { name: 'Szanse na wygraną', value: chanceLine }
    );

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
        .setStyle(ButtonStyle.Primary)
    );
  }

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] };
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

    const id = `${Date.now().toString(36)}_${++lobbyCounter}`;
    const lobby = {
      id,
      channelId: interaction.channelId,
      players: [],
      ready: new Set(),
      message: null,
      fighting: false,
      timeout: null,
    };
    channelsWithLobby.add(lobby.channelId);
    roshanLobbies.set(id, lobby);

    try {
      await interaction.reply(buildLobbyView(lobby));
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
          content: '⌛ Roshan zasnął z powrotem — nikt nie zebrał drużyny.',
          embeds: [],
          components: [],
        });
      } catch (e) {
        error('Error editing expired Roshan message:', e.message);
      }
    }, getSetting('roshan_lobby_timeout') * 60_000);
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
    lobby.fighting = true;
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

  const header = `🧟 Wyprawa na Roshana: ${players.map((id) => `<@${id}>`).join(' ')}\n`;
  const resultLines = win
    ? [
        `🏆 **Roshan pokonany!** Szansa była ${Math.round(chanceFor(n) * 100)}%, a jednak się udało!`,
        ...settlement.map((s) => `💰 <@${s.id}> +**${s.amount}** Golda`),
        `🛡️ Aegis zabezpieczony, ${getSetting('roshan_gold')} Golda do podziału!`,
      ]
    : [
        `💀 **Roshan wygrywa!** Szansa na wygraną wynosiła ${Math.round(chanceFor(n) * 100)}%.`,
        ...settlement.map((s) => `💸 <@${s.id}> -**${s.amount}** Golda`),
      ];

  let text = header;
  await message.edit({ content: text, embeds: [], components: [] });

  for (const line of story) {
    await sleep(1500);
    text += '\n' + line;
    await message.edit({ content: text });
  }

  await sleep(1500);
  text += '\n\n' + resultLines.join('\n');
  await message.edit({ content: text });
}
