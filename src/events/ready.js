import { Events } from 'discord.js';
import { log, error } from '../utils/logger.js';
import { startScheduler } from '../scheduler/bountyScheduler.js';
import { acquireInstanceLock } from '../db/queries.js';
import { startHeartbeat } from '../utils/heartbeat.js';

// Guard: only start the scheduler once per process lifetime, even if
// the ready event fires again after a reconnect (discord.js v14 does
// NOT re-fire ready due to once:true, but we guard anyway).
let schedulerStarted = false;

// Unique identifier for this bot instance — used for the DB lock.
const instanceId =
  process.pid.toString() + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    log(`Logged in as ${client.user.tag}!`);
    log(`Serving guild(s): ${client.guilds.cache.map((g) => g.name).join(', ')}`);
    log(`Instance ID: ${instanceId}`);

    // Attempt to acquire the singleton instance lock.
    // If another instance is alive, refuse to start the scheduler.
    try {
      const gotLock = await acquireInstanceLock(instanceId, 60);
      if (!gotLock) {
        error(
          'Another bot instance appears to be running (lock held by a live process). ' +
          'Scheduler will NOT be started to avoid duplicate spawns. ' +
          'If this is unexpected, wait 60 seconds or reset the bot_instance_lock table.'
        );
        return;
      }
      log('Instance lock acquired — no duplicate scheduler detected.');
      startHeartbeat(instanceId);
    } catch (lockErr) {
      error('Failed to check instance lock:', lockErr.message);
      log('Proceeding without lock check — duplicate spawn risk exists.');
    }

    // Start the randomized bounty rune scheduler
    if (!schedulerStarted) {
      schedulerStarted = true;
      startScheduler(client);
    }
  },
};

export { instanceId };
