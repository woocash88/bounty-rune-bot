import { DiscordAPIError } from 'discord.js';
import { log, error } from '../utils/logger.js';
import {
  clearSchedule,
  getNextSpawnAt,
  persistNextSpawnAt,
} from '../db/queries.js';

const channels = (process.env.BOUNTY_CHANNEL_IDS ?? '')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

const avgPerWeek = parseFloat(process.env.BOUNTY_AVG_PER_WEEK) || 1;

// Mean interval in ms to achieve avgPerWeek spawns per week
const MEAN_INTERVAL_MS =
  (7 * 24 * 60 * 60 * 1000) / avgPerWeek;

// Admin alert channel (optional)
const adminLogChannelId = process.env.ADMIN_LOG_CHANNEL_ID ?? null;

let timeoutHandle = null;
let isRunning = false;

/**
 * Compute a random delay from an exponential distribution
 * (Poisson process: events occur independently at a given average rate).
 * @returns {number} delay in ms
 */
function nextDelayMs() {
  return -Math.log(1 - Math.random()) * MEAN_INTERVAL_MS;
}

/**
 * Pick a random channel ID from the configured list.
 * @returns {string}
 */
function randomChannelId() {
  return channels[Math.floor(Math.random() * channels.length)];
}

/**
 * Send an alert message to the admin log channel (if configured).
 * Best-effort — errors are logged to console and swallowed.
 * @param {import('discord.js').Client} client
 * @param {string} message
 */
async function sendAdminAlert(client, message) {
  if (!adminLogChannelId || !client) return;
  try {
    const adminChannel = await client.channels.fetch(adminLogChannelId);
    if (adminChannel) {
      await adminChannel.send({ content: message });
    }
  } catch (alertErr) {
    log('Failed to send admin alert:', alertErr.message);
  }
}

/**
 * Compute the next spawn time, persist it to Supabase, and log it.
 * @returns {Date}
 */
async function computeAndPersistNextSpawn() {
  const delay = nextDelayMs();
  const nextDate = new Date(Date.now() + delay);
  await persistNextSpawnAt(nextDate);
  log(
    `Next Bounty Rune scheduled at ${nextDate.toLocaleString()} ` +
    `(${(delay / 3_600_000).toFixed(1)} hours from now)`
  );
  return nextDate;
}

/**
 * Schedule the local setTimeout for a given spawn date.
 * @param {import('discord.js').Client} client
 * @param {Date} spawnDate
 */
function scheduleTimeoutFor(client, spawnDate) {
  if (!isRunning) return;

  const delay = spawnDate.getTime() - Date.now();
  if (delay <= 0) {
    // Already due — spawn immediately
    spawnRune(client);
    return;
  }

  log(
    `Local timeout set for ${spawnDate.toLocaleString()} ` +
    `(${(delay / 3_600_000).toFixed(1)} hours from now)`
  );

  timeoutHandle = setTimeout(() => spawnRune(client), delay);
}

/**
 * Schedule and post a single Bounty Rune, then compute and persist
 * the next spawn. This is the core spawn function — after it completes
 * (success or failure) the next spawn is always scheduled.
 * @param {import('discord.js').Client} client
 */
async function spawnRune(client) {
  if (!isRunning) return;

  try {
    const goldReward = parseInt(process.env.BOUNTY_GOLD_REWARD, 10) || 50;

    if (channels.length === 0) {
      log('No bounty channels configured, skipping spawn.');
      await sendAdminAlert(
        client,
        '⚠️ Brak skonfigurowanych kanałów dla Bounty Rune — `BOUNTY_CHANNEL_IDS` jest puste. Sprawdź .env.'
      );
      // Still persist next to keep the schedule alive
      await computeAndPersistNextSpawn();
      scheduleAfterSpawn(client);
      return;
    }

    const channelId = randomChannelId();
    let channel;

    try {
      channel = await client.channels.fetch(channelId);
    } catch (fetchErr) {
      // Distinguish channel-fetch errors (nonexistent / no access) from other errors
      const isChannelProblem =
        fetchErr instanceof DiscordAPIError &&
        (fetchErr.code === 10003 || fetchErr.code === 50001 || fetchErr.code === 50013);

      if (isChannelProblem) {
        log(`Channel ${channelId} not found or inaccessible, skipping spawn.`);
        await sendAdminAlert(
          client,
          `⚠️ Nie udało się zespawnować Bounty Runy na kanale <#${channelId}> (ID: \`${channelId}\`) — kanał nie istnieje, bot nie ma dostępu, lub brakuje uprawnień. Sprawdź \`BOUNTY_CHANNEL_IDS\` w .env.`
        );
      } else {
        error('Unexpected error fetching channel:', fetchErr.message);
      }

      await computeAndPersistNextSpawn();
      scheduleAfterSpawn(client);
      return;
    }

    if (!channel) {
      log(`Channel ${channelId} not found (null), skipping spawn.`);
      await sendAdminAlert(
        client,
        `⚠️ Nie udało się zespawnować Bounty Runy na kanale <#${channelId}> (ID: \`${channelId}\`) — kanał nie istnieje. Sprawdź \`BOUNTY_CHANNEL_IDS\` w .env.`
      );
      await computeAndPersistNextSpawn();
      scheduleAfterSpawn(client);
      return;
    }

    // Attempt to send; catch Discord permission/rate-limit errors specifically
    try {
      const result = (await import('../utils/bountyEmbed.js')).buildBountyMessage(goldReward);
      const sendPayload = { embeds: [result.embed], components: [result.row] };
      if (result.attachment) sendPayload.files = [result.attachment];
      await channel.send(sendPayload);
    } catch (sendErr) {
      const isPermissionProblem =
        sendErr instanceof DiscordAPIError &&
        (sendErr.code === 50001 || sendErr.code === 50013);

      if (isPermissionProblem) {
        log(`Missing permissions to send in channel ${channelId}, skipping spawn.`);
        await sendAdminAlert(
          client,
          `⚠️ Nie udało się zespawnować Bounty Runy na kanale <#${channelId}> (ID: \`${channelId}\`) — bot nie ma uprawnień do wysyłania wiadomości na tym kanale.`
        );
      } else {
        // Re-throw non-permission send errors so the outer catch handles them
        throw sendErr;
      }

      await computeAndPersistNextSpawn();
      scheduleAfterSpawn(client);
      return;
    }

    log(`Bounty Rune spawned in channel ${channelId}`);

    // Persist next spawn time
    await computeAndPersistNextSpawn();
  } catch (err) {
    error('Bounty scheduler error:', err.message);

    // Send admin alert if a log channel is configured
    if (adminLogChannelId && client) {
      try {
        const adminChannel = await client.channels.fetch(adminLogChannelId);
        if (adminChannel) {
          await adminChannel.send({
            content: `⚠️ Błąd Bounty schedulera: ${err.message}`,
          });
        }
      } catch {
        // Admin channel notification is best-effort
      }
    }

    // Even on error, persist next spawn so the schedule doesn't die
    try {
      await computeAndPersistNextSpawn();
    } catch (persistErr) {
      error('Failed to persist next spawn time:', persistErr.message);
    }
  }

  // Schedule the next spawn regardless of success/failure
  scheduleAfterSpawn(client);
}

/**
 * After a spawn completes, schedule the local timeout for the
 * already-persisted next spawn time.
 * @param {import('discord.js').Client} client
 */
async function scheduleAfterSpawn(client) {
  if (!isRunning) return;

  try {
    const nextDate = await getNextSpawnAt();
    if (nextDate) {
      scheduleTimeoutFor(client, nextDate);
    } else {
      // Shouldn't happen after computeAndPersistNextSpawn, but be defensive
      log('No persisted spawn time found, computing fresh one.');
      const freshDate = await computeAndPersistNextSpawn();
      scheduleTimeoutFor(client, freshDate);
    }
  } catch (err) {
    error('Failed to read next spawn time after spawn:', err.message);
    // Fall back to in-memory random delay as last resort
    if (isRunning) {
      const fallbackDelay = nextDelayMs();
      const fallbackDate = new Date(Date.now() + fallbackDelay);
      log(`Fallback: next spawn at ${fallbackDate.toLocaleString()}`);
      timeoutHandle = setTimeout(() => spawnRune(client), fallbackDelay);
    }
  }
}

/**
 * Start the scheduler. On startup, reads the persisted next_spawn_at
 * from Supabase and either spawns immediately (if overdue) or schedules
 * a timeout for the remaining delay.
 * @param {import('discord.js').Client} client
 */
export async function startScheduler(client) {
  if (isRunning) return;
  isRunning = true;

  log('Bounty scheduler started.');
  log(`Average spawns per week: ${avgPerWeek}, mean interval: ${(MEAN_INTERVAL_MS / 3_600_000).toFixed(1)}h`);

  try {
    const nextSpawnAt = await getNextSpawnAt();

    if (nextSpawnAt) {
      const now = Date.now();
      const remaining = nextSpawnAt.getTime() - now;

      if (remaining <= 0) {
        log('Persisted spawn time is in the past — spawning immediately.');
        spawnRune(client);
      } else {
        scheduleTimeoutFor(client, nextSpawnAt);
      }
    } else {
      // No persisted schedule yet — compute one and schedule
      log('No persisted schedule found, computing first spawn.');
      const firstDate = await computeAndPersistNextSpawn();
      scheduleTimeoutFor(client, firstDate);
    }
  } catch (err) {
    error('Failed to read persisted schedule on startup:', err.message);
    // Fall back to immediate spawn + fresh schedule
    log('Falling back to immediate spawn.');
    spawnRune(client);
  }
}

/**
 * Stop the scheduler and cancel any pending spawn.
 */
export function stopScheduler() {
  isRunning = false;
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  log('Bounty scheduler stopped.');
}

/**
 * Manually trigger a single test Bounty Rune spawn.
 * Unlike the automatic scheduler spawn, this does NOT persist a new
 * next_spawn_at or schedule any future spawn — the scheduler's existing
 * timing is completely unaffected.
 *
 * @param {import('discord.js').Client} client
 * @param {string} [channelId] - Optional target channel ID. If omitted,
 *   picks a random channel from BOUNTY_CHANNEL_IDS (same as the real scheduler).
 * @returns {Promise<string>} The ID of the channel where the rune was spawned.
 */
export async function triggerManualSpawn(client, channelId) {
  const goldReward = parseInt(process.env.BOUNTY_GOLD_REWARD, 10) || 50;

  const targetChannelId = channelId ?? randomChannelId();

  if (!targetChannelId) {
    throw new Error('No channel ID available — BOUNTY_CHANNEL_IDS may be empty and no channel was specified.');
  }

  let channel;
  try {
    channel = await client.channels.fetch(targetChannelId);
  } catch (fetchErr) {
    const isChannelProblem =
      fetchErr instanceof DiscordAPIError &&
      (fetchErr.code === 10003 || fetchErr.code === 50001 || fetchErr.code === 50013);

    await sendAdminAlert(
      client,
      `⚠️ Nie udało się zespawnować Bounty Runy na kanale <#${targetChannelId}> (ID: \`${targetChannelId}\`) — kanał nie istnieje, bot nie ma dostępu, lub brakuje uprawnień. Sprawdź \`BOUNTY_CHANNEL_IDS\` w .env.`
    );

    if (isChannelProblem) {
      log(`Channel ${targetChannelId} not found or inaccessible (manual spawn).`);
      throw new Error(
        `Kanał <#${targetChannelId}> nie istnieje lub bot nie ma do niego dostępu.`
      );
    }
    throw fetchErr;
  }

  if (!channel) {
    await sendAdminAlert(
      client,
      `⚠️ Nie udało się zespawnować Bounty Runy na kanale <#${targetChannelId}> (ID: \`${targetChannelId}\`) — kanał nie istnieje. Sprawdź \`BOUNTY_CHANNEL_IDS\` w .env.`
    );
    log(`Channel ${targetChannelId} not found (null, manual spawn).`);
    throw new Error(
      `Nie znaleziono kanału <#${targetChannelId}>. Sprawdź BOUNTY_CHANNEL_IDS w .env.`
    );
  }

  try {
    const result = (await import('../utils/bountyEmbed.js')).buildBountyMessage(goldReward);
    const sendPayload = { embeds: [result.embed], components: [result.row] };
    if (result.attachment) sendPayload.files = [result.attachment];
    await channel.send(sendPayload);
  } catch (sendErr) {
    const isPermissionProblem =
      sendErr instanceof DiscordAPIError &&
      (sendErr.code === 50001 || sendErr.code === 50013);

    if (isPermissionProblem) {
      await sendAdminAlert(
        client,
        `⚠️ Nie udało się zespawnować Bounty Runy na kanale <#${targetChannelId}> (ID: \`${targetChannelId}\`) — bot nie ma uprawnień do wysyłania wiadomości na tym kanale.`
      );
      log(`Missing permissions to send in channel ${targetChannelId} (manual spawn).`);
      throw new Error(
        `Bot nie ma uprawnień do wysyłania wiadomości na kanale <#${targetChannelId}>.`
      );
    }
    throw sendErr;
  }

  log(`[Manual] Bounty Rune spawned in channel ${targetChannelId}`);
  return targetChannelId;
}

/**
 * Recompute the schedule from scratch: clear the persisted row, cancel any
 * pending timeout, compute a fresh spawn time using the current
 * BOUNTY_AVG_PER_WEEK value, persist it, and schedule the local timer.
 *
 * Designed to be called from an admin command or any other runtime trigger
 * without restarting the bot process.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<{nextDate: Date, avgPerWeek: number}>}
 */
export async function recomputeSchedule(client) {
  // 1. Cancel any pending spawn timer
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
    log('[Recompute] Cancelled existing spawn timer.');
  }

  // 2. Clear the persisted schedule row
  await clearSchedule();
  log('[Recompute] Cleared persisted schedule.');

  // 3. Compute a fresh spawn time using the *current* env value
  const currentAvg = parseFloat(process.env.BOUNTY_AVG_PER_WEEK) || 1;
  const meanInterval = (7 * 24 * 60 * 60 * 1000) / currentAvg;
  const delay = -Math.log(1 - Math.random()) * meanInterval;
  const nextDate = new Date(Date.now() + delay);

  log(
    `[Recompute] New spawn at ${nextDate.toLocaleString()} ` +
    `(${(delay / 3_600_000).toFixed(1)}h from now, ${currentAvg} avg/wk)`
  );

  // 4. Persist the new date
  await persistNextSpawnAt(nextDate);

  // 5. Schedule the local timeout (only if the scheduler is still running)
  if (isRunning) {
    scheduleTimeoutFor(client, nextDate);
  }

  return { nextDate, avgPerWeek: currentAvg };
}
