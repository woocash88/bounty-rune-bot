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
    `🧟 ${names} wchodzą do jaskini Roshana, a ten otwiera jedno oko i łamie wszystkich na starcie`,
    `🗡️ Drużyna kontruje wszystkimi czarami i itemami, jakie mają...  Roshan zaryczał...`,
    `🥁 Ostatnia wymiana ciosów... kto poniesie klęskę?!`,
  ],
  (names) => [
    `🧀 ${names} podkradają się pod leże, aby zgarnąć łup.`,
    `⚡ Roshan rzuca głazem i bashuje, drużyna odpala wszystkie ulti, ale połowa chybiona...`,
    `🌫️ Kurz opada, a w grocie słychać tylko ciężki oddech...`,
  ],
  (names) => [
    `🪓 ${names} wpadają do jaskini z krzykiem "DAWAĆ GOLDA!" ale od razu dostają z łapy i upadają!`,
    `🍞 Support atakuje go z autoataku, nie jestem jednak pewien czy to coś daje...`,
    `😱 Jednakże Roshan ryczy tak, że na mapie gasną światła... kto tym razem odniesie zwycięstwo?!`,
  ],
  (names) => [
    `📢 ${names} mają wielką nadzieję że za golda będzie można coś kupić, dlatego idą napierdalać Rosha.`,
    `🤦 Zawdonicy są wyfarmieni, zaopatrzeni w cały sprzęt, a Roshan już bije po łbach tych, mimo dobrego przygotowania`,
    `⏳ W oddali słychać jeszcze krzyk "ZARAZ BĘDĘ!"... ale czy zdążą?!`,
  ],
  (names) => [
    `🧙 ${names} odpalają BKB i ruszają na Roshana jak po ostatniego karpia do Kauflandu!`,
    `🥩 Roshan kontruje okrzykiem i napierdala w nich jak w kotlety schabowe!`,
    `🔥 Pozostali walczą dalej na kolanach... komu zostanie ostatni cios?!`,
  ],
  (names) => [
    `📱 ${names} ustawiają drużynę na Discordzie, ale pół składu gada o czymś zupełnie innym...`,
    `😴 Roshan ziewa, drapie się po brzuchu i dopiero potem zaczyna walić ogonem!`,
    `🎯 Ktoś krzyczy "FOKUS NA ROSHANA!", a nikt nie wie, kto jest tank... kto przeżyje?!`,
  ],
  (names) => [
    `🚪 ${names} wchodzą do jaskini po cichaczu... po czym ktoś potyka się o własne przyrodzenie!`,
    `🪨 Roshan budzi się wściekły, rzuca w nich skałą i traci przy tym dwa zęby!`,
    `🦷 Dobra wyjebane co tu sie dzieje, napisz w końcu kto wygrał?!`,
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


/** Minimum balance to join/fight: the entry fee (same for every party size). */
function requiredGold() {
  return getSetting('roshan_entry');
}

function chanceFor(n) {
  const key = WIN_CHANCE_KEY[n];
  return key ? getSetting(key) / 100 : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const entry = getSetting('roshan_entry');
  const expiresUnix = Math.floor(lobby.expiresAt / 1000);

  const embed = new EmbedBuilder()
    .setColor(0xb71c1c)
    .setTitle('👹 Roshan się pojawił!')
    .setDescription(
      `⚔️ Zbierz drużynę między ${MIN_PLAYERS}-${MAX_PLAYERS} osób, aby stawić czoło Roshanowi!\n` +
        `📜 Wpisowe: ${entry}g\n` +
        `💰 Nagroda: ${gold}g na drużynę.\n\n` +
        `⚠️ Uwaga! Gracz może zginąć w walce, a jego część nagrody trafia do pozostałych!\n` +
        `Roshan ucieknie <t:${expiresUnix}:R>`
    )
    .setThumbnail('attachment://roshan.png')
    .addFields(
      { name: `Drużyna ${n}/${MAX_PLAYERS}`, value: `${filled}\n${list}` },
      {
        name: 'Nagroda na osobę',
        value: [3, 4, 5].map((k) => `${k} os.: ${Math.ceil(gold / k)}g`).join(' · '),
      }
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
    // Must be able to pay the entry fee (charged only when the fight starts).
    const required = requiredGold();
    const balance = await getUserGold(userId);
    if (balance < required) {
      await interaction.reply({
        content: `Do walki z Roshanem potrzebujesz minimum **${required} Golda** (masz ${balance}).`,
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
    // before the fight so nobody gets in without being able to pay the entry fee.
    const required = requiredGold();
    const broke = [];
    try {
      for (const id of lobby.players) {
        if ((await getUserGold(id)) < required) broke.push(id);
      }
    } catch (err) {
      error('Roshan: balance check before fight failed:', err.message);
      lobby.fighting = false;
      lobby.ready.clear();
      await interaction.reply({ content: 'Błąd techniczny, spróbuj ponownie.', ephemeral: true });
      return;
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

/** Give the entry fee back to everyone already charged (fight cancelled). */
async function refundEntry(ids, entry) {
  for (const id of ids) {
    try {
      await addGold(id, entry);
    } catch (err) {
      error(`Roshan CRITICAL: refund of ${entry} to ${id} failed:`, err.message);
    }
  }
}

async function runFight(lobby) {
  const { message, players } = lobby;
  const n = players.length;
  const entry = getSetting('roshan_entry');

  // -- Entry fee: charged only now, never at join. Non-refundable once the fight happens. --
  const charged = [];
  try {
    for (const id of players) {
      if (!(await tryDeductGold(id, entry))) {
        await refundEntry(charged, entry);
        await message.edit({
          content: `❌ Walka odwołana — <@${id}> nie ma już ${entry} Golda.`,
          embeds: [],
          components: [],
          attachments: [],
        });
        return;
      }
      charged.push(id);
    }
  } catch (err) {
    await refundEntry(charged, entry);
    throw err;
  }

  const win = Math.random() < chanceFor(n);

  // After a win there's a chance that one random player dies (only on wins).
  let victim = null;
  if (win && Math.random() < getSetting('roshan_death_chance') / 100) {
    victim = players[Math.floor(Math.random() * n)];
  }
  const survivors = players.filter((id) => id !== victim);

  // Gross payout, identical for every survivor (rounded up, so a pool that doesn't
  // divide evenly can pay out slightly more than the pool). The entry fee isn't returned.
  const share = Math.ceil(getSetting('roshan_gold') / survivors.length);

  // -- Settle gold first, so the narration never promises what didn't happen --
  const settlement = [];
  if (win) {
    for (const id of survivors) {
      try {
        await addGold(id, share);
        settlement.push({ id, amount: share });
      } catch (err) {
        error(`Roshan CRITICAL: payout of ${share} to ${id} failed:`, err.message);
        settlement.push({ id, amount: share, failed: true });
        continue;
      }
      await incrementStat(id, 'roshans_killed').catch((e) =>
        error('Could not increment roshans_killed:', e.message)
      );
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
  const net = share - entry;
  const resultLines = win
    ? [
        `🏆 **Roshan pokonany!**`,
        ...settlement.map((s) =>
          s.failed
            ? `⚠️ <@${s.id}> — błąd wypłaty ${s.amount} Golda, zgłoś to adminowi`
            : `💰 <@${s.id}> +**${s.amount}** Golda (netto **${net >= 0 ? '+' : ''}${net}**)`
        ),
        ...(victim
          ? [`☠️ <@${victim}> poległ w walce i nie dostaje nagrody (-**${entry}** Golda)`]
          : []),
        victim
          ? `🛡️ Aegis zabezpieczony, ${getSetting('roshan_gold')} Golda podzielone między ${survivors.length} ocalałych!`
          : `🛡️ Aegis zabezpieczony, ${getSetting('roshan_gold')} Golda do podziału!`,
      ]
    : [
        `💀 **Roshan wygrywa!**`,
        ...players.map((id) => `💸 <@${id}> -**${entry}** Golda (wpisowe)`),
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
