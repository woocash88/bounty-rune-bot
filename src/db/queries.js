import { supabase } from './supabaseClient.js';

// ============================================================
// Gold balance queries
// ============================================================

/**
 * Get a user's current gold balance.
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function getUserGold(userId) {
  const { data, error } = await supabase
    .from('bounty_users')
    .select('gold')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data?.gold ?? 0;
}

/**
 * Atomically add (or subtract) gold for a user. If the user doesn't exist,
 * they are created with the given amount (clamped to 0 minimum).
 * Uses the Postgres increment_gold function for race-safety.
 * @param {string} userId
 * @param {number} amount
 * @returns {Promise<number>} new gold balance
 */
export async function addGold(userId, amount) {
  const { data, error } = await supabase.rpc('increment_gold', {
    p_user_id: userId,
    p_amount: amount,
  });

  if (error) throw error;
  return data;
}

/**
 * Atomically deduct gold from a user if they have sufficient balance.
 * Uses the Postgres try_deduct_gold function with row-level locking.
 * Returns true if deducted, false if insufficient funds or user doesn't exist.
 * @param {string} userId
 * @param {number} amount
 * @returns {Promise<boolean>}
 */
export async function tryDeductGold(userId, amount) {
  const { data, error } = await supabase.rpc('try_deduct_gold', {
    p_user_id: userId,
    p_amount: amount,
  });

  if (error) throw error;
  return data;
}

/**
 * Reset a single user's gold to 0.
 * @param {string} userId
 */
export async function resetUser(userId) {
  const { error } = await supabase
    .from('bounty_users')
    .update({ gold: 0, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  if (error) throw error;
}

/**
 * Reset all users' gold to 0.
 */
export async function resetAllUsers() {
  const { error } = await supabase
    .from('bounty_users')
    .update({ gold: 0, updated_at: new Date().toISOString() })
    .neq('user_id', ''); // match all rows

  if (error) throw error;
}

/**
 * Get top N users by gold descending.
 * @param {number} limit
 * @returns {Promise<Array<{user_id: string, gold: number}>>}
 */
export async function getLeaderboard(limit = 10) {
  const { data, error } = await supabase
    .from('bounty_users')
    .select('user_id, gold')
    .order('gold', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

// ============================================================
// Scheduler persistence – bounty_schedule table
// ============================================================

/**
 * Persist the next scheduled spawn timestamp.
 * @param {Date} date
 */
export async function persistNextSpawnAt(date) {
  const { error } = await supabase
    .from('bounty_schedule')
    .upsert({ id: 1, next_spawn_at: date.toISOString() }, { onConflict: 'id' });

  if (error) throw error;
}

/**
 * Read the persisted next spawn timestamp, or null if no row exists.
 * @returns {Promise<Date|null>}
 */
export async function getNextSpawnAt() {
  const { data, error } = await supabase
    .from('bounty_schedule')
    .select('next_spawn_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw error;
  return data ? new Date(data.next_spawn_at) : null;
}

/**
 * Delete the persisted schedule row (id=1) so the scheduler will
 * compute a fresh next-spawn time on the next cycle.
 */
export async function clearSchedule() {
  const { error } = await supabase
    .from('bounty_schedule')
    .delete()
    .eq('id', 1);

  if (error) throw error;
}

// ============================================================
// Instance lock – bot_instance_lock table (duplicate guard)
// ============================================================

/**
 * Try to acquire the singleton instance lock.
 * @param {string} instanceId
 * @param {number} [staleThresholdSec=60]
 * @returns {Promise<boolean>} true if the lock was acquired
 */
export async function acquireInstanceLock(instanceId, staleThresholdSec = 60) {
  const { data, error } = await supabase.rpc('try_acquire_lock', {
    p_instance_id: instanceId,
    p_stale_threshold_seconds: staleThresholdSec,
  });

  if (error) throw error;
  return data;
}

/**
 * Refresh the heartbeat timestamp for this instance's lock row.
 * @param {string} instanceId
 */
export async function heartbeatLock(instanceId) {
  const { error } = await supabase
    .from('bot_instance_lock')
    .update({ heartbeat_at: new Date().toISOString() })
    .eq('id', 1)
    .eq('instance_id', instanceId);

  if (error) throw error;
}

/**
 * Release this instance's lock (set heartbeat to epoch so it's immediately stale).
 * @param {string} instanceId
 */
export async function releaseLock(instanceId) {
  const { error } = await supabase
    .from('bot_instance_lock')
    .update({ heartbeat_at: '1970-01-01T00:00:00Z' })
    .eq('id', 1)
    .eq('instance_id', instanceId);

  if (error) throw error;
}
