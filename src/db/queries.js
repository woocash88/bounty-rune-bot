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
 * Atomically increment a profile stat ('bounties_collected' | 'roshans_killed').
 * @param {string} userId
 * @param {'bounties_collected'|'roshans_killed'} stat
 * @param {number} [amount=1]
 */
export async function incrementStat(userId, stat, amount = 1) {
  const { error } = await supabase.rpc('increment_stat', {
    p_user_id: userId,
    p_stat: stat,
    p_amount: amount,
  });

  if (error) throw error;
}

/**
 * Get a user's profile stats (zeros if the user has no row yet).
 * @param {string} userId
 * @returns {Promise<{gold: number, bounties_collected: number, roshans_killed: number}>}
 */
export async function getUserStats(userId) {
  const { data, error } = await supabase
    .from('bounty_users')
    .select('gold, bounties_collected, roshans_killed')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return {
    gold: data?.gold ?? 0,
    bounties_collected: data?.bounties_collected ?? 0,
    roshans_killed: data?.roshans_killed ?? 0,
  };
}

/**
 * Atomically claim a user's weekly /give slot.
 * @param {string} userId
 * @param {number} cooldownSeconds
 * @returns {Promise<Date|null>} null if claimed; otherwise when the user may give again
 */
export async function tryClaimGive(userId, cooldownSeconds) {
  const { data, error } = await supabase.rpc('try_claim_give', {
    p_user_id: userId,
    p_cooldown_seconds: cooldownSeconds,
  });

  if (error) throw error;
  return data ? new Date(data) : null;
}

/**
 * Release a claimed /give slot (the transfer didn't happen).
 * @param {string} userId
 */
export async function releaseGiveClaim(userId) {
  const { error } = await supabase.rpc('release_give_claim', { p_user_id: userId });
  if (error) throw error;
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
 * @returns {Promise<Array<{user_id: string, gold: number, roshans_killed: number}>>}
 */
export async function getLeaderboard(limit = 10) {
  const { data, error } = await supabase
    .from('bounty_users')
    .select('user_id, gold, roshans_killed')
    .order('gold', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

// ============================================================
// Runtime settings – bot_settings table
// ============================================================

/**
 * @returns {Promise<Array<{key: string, value: number}>>}
 */
export async function getAllSettings() {
  const { data, error } = await supabase.from('bot_settings').select('key, value');
  if (error) throw error;
  return data ?? [];
}

/**
 * @param {string} key
 * @param {number} value
 */
export async function upsertSetting(key, value) {
  const { error } = await supabase
    .from('bot_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
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
