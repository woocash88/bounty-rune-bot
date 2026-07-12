import { log, error } from './logger.js';
import { heartbeatLock } from '../db/queries.js';

let heartbeatInterval = null;

/**
 * Start the instance lock heartbeat. Refreshes the lock row every 30 seconds.
 * @param {string} instanceId
 */
export function startHeartbeat(instanceId) {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(async () => {
    try {
      await heartbeatLock(instanceId);
    } catch (err) {
      error('Heartbeat failed:', err.message);
    }
  }, 30_000);

  // Allow the process to exit even if the interval is still running
  heartbeatInterval.unref();

  log('Heartbeat started (30s interval).');
}

/**
 * Stop the heartbeat interval.
 */
export function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    log('Heartbeat stopped.');
  }
}
