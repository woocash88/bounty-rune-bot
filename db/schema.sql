-- Bounty Rune Bot database schema
-- Run this SQL in your Supabase SQL editor to create all tables and functions.

-- ============================================================
-- Table: gold balances
-- ============================================================
CREATE TABLE IF NOT EXISTS bounty_users (
  user_id   TEXT PRIMARY KEY,
  gold      INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Function: atomic gold increment (race-safe via upsert)
-- ============================================================
CREATE OR REPLACE FUNCTION increment_gold(p_user_id TEXT, p_amount INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_gold INTEGER;
BEGIN
  INSERT INTO bounty_users (user_id, gold, updated_at)
  VALUES (p_user_id, GREATEST(p_amount, 0), NOW())
  ON CONFLICT (user_id)
  DO UPDATE SET
    gold = GREATEST(bounty_users.gold + p_amount, 0),
    updated_at = NOW()
  WHERE bounty_users.user_id = p_user_id
  RETURNING bounty_users.gold INTO v_new_gold;

  RETURN v_new_gold;
END;
$$;

-- ============================================================
-- Table: scheduler state (persisted across restarts)
-- Singleton row (id = 1) holding the next scheduled spawn time.
-- ============================================================
CREATE TABLE IF NOT EXISTS bounty_schedule (
  id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_spawn_at  TIMESTAMPTZ NOT NULL
);

-- ============================================================
-- Function: atomic gold deduction (race-safe via row lock)
-- Returns TRUE if the user had sufficient funds and deducted,
-- FALSE if they didn't exist or had insufficient gold.
-- Uses FOR UPDATE row locking so concurrent deductions can't
-- both succeed and push the balance negative.
-- ============================================================
CREATE OR REPLACE FUNCTION try_deduct_gold(p_user_id TEXT, p_amount INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_gold INTEGER;
BEGIN
  SELECT gold INTO v_current_gold FROM bounty_users WHERE user_id = p_user_id FOR UPDATE;

  IF v_current_gold IS NULL OR v_current_gold < p_amount THEN
    RETURN FALSE;
  END IF;

  UPDATE bounty_users
  SET gold = gold - p_amount, updated_at = NOW()
  WHERE user_id = p_user_id;

  RETURN TRUE;
END;
$$;

-- ============================================================
-- Table: bot instance lock (prevents duplicate schedulers)
-- Singleton row (id = 1). Used with the try_acquire_lock function
-- to ensure only one bot instance runs the scheduler at a time.
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_instance_lock (
  id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  instance_id  TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Function: try to acquire the instance lock
-- Returns TRUE if this instance got the lock (either no prior
-- lock existed, or the prior lock was stale), FALSE if another
-- instance is still alive.
-- ============================================================
CREATE OR REPLACE FUNCTION try_acquire_lock(
  p_instance_id            TEXT,
  p_stale_threshold_seconds INTEGER DEFAULT 60
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_heartbeat_at TIMESTAMPTZ;
BEGIN
  SELECT heartbeat_at INTO v_heartbeat_at FROM bot_instance_lock WHERE id = 1;

  IF v_heartbeat_at IS NULL THEN
    INSERT INTO bot_instance_lock (id, instance_id, started_at, heartbeat_at)
    VALUES (1, p_instance_id, NOW(), NOW());
    RETURN TRUE;
  END IF;

  IF v_heartbeat_at < NOW() - (p_stale_threshold_seconds::TEXT || ' seconds')::INTERVAL THEN
    UPDATE bot_instance_lock
    SET instance_id  = p_instance_id,
        started_at   = NOW(),
        heartbeat_at = NOW()
    WHERE id = 1;
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

-- ============================================================
-- Profile stats (migration: safe to re-run)
-- bounties_collected: Bounty Runes claimed
-- roshans_killed: Roshan fights won (counted per party member)
-- ============================================================
ALTER TABLE bounty_users ADD COLUMN IF NOT EXISTS bounties_collected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bounty_users ADD COLUMN IF NOT EXISTS roshans_killed INTEGER NOT NULL DEFAULT 0;

-- Atomic stat increment. p_stat must be 'bounties_collected' or 'roshans_killed'.
CREATE OR REPLACE FUNCTION increment_stat(p_user_id TEXT, p_stat TEXT, p_amount INTEGER DEFAULT 1)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_stat NOT IN ('bounties_collected', 'roshans_killed') THEN
    RAISE EXCEPTION 'Unknown stat: %', p_stat;
  END IF;

  INSERT INTO bounty_users (user_id, gold, bounties_collected, roshans_killed, updated_at)
  VALUES (
    p_user_id, 0,
    CASE WHEN p_stat = 'bounties_collected' THEN p_amount ELSE 0 END,
    CASE WHEN p_stat = 'roshans_killed' THEN p_amount ELSE 0 END,
    NOW()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    bounties_collected = bounty_users.bounties_collected
      + CASE WHEN p_stat = 'bounties_collected' THEN p_amount ELSE 0 END,
    roshans_killed = bounty_users.roshans_killed
      + CASE WHEN p_stat = 'roshans_killed' THEN p_amount ELSE 0 END,
    updated_at = NOW();
END;
$$;

-- ============================================================
-- Runtime settings changed from Discord (key/value, numeric)
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_settings (
  key        TEXT PRIMARY KEY,
  value      DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- /give weekly limit (migration: safe to re-run)
-- last_give_at: when the user last transferred gold to someone
-- ============================================================
ALTER TABLE bounty_users ADD COLUMN IF NOT EXISTS last_give_at TIMESTAMPTZ;

-- Atomically claim the user's /give slot.
-- Returns NULL if the slot was claimed (transfer allowed, last_give_at = now),
-- or the timestamp when the user may give again if still on cooldown.
CREATE OR REPLACE FUNCTION try_claim_give(p_user_id TEXT, p_cooldown_seconds INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_last TIMESTAMPTZ;
  v_window INTERVAL := make_interval(secs => p_cooldown_seconds);
BEGIN
  INSERT INTO bounty_users (user_id, gold, updated_at)
  VALUES (p_user_id, 0, NOW())
  ON CONFLICT (user_id) DO NOTHING;

  SELECT last_give_at INTO v_last FROM bounty_users WHERE user_id = p_user_id FOR UPDATE;

  IF v_last IS NOT NULL AND v_last > NOW() - v_window THEN
    RETURN v_last + v_window;
  END IF;

  UPDATE bounty_users SET last_give_at = NOW() WHERE user_id = p_user_id;
  RETURN NULL;
END;
$$;

-- Release the slot again (used when the transfer didn't actually happen).
CREATE OR REPLACE FUNCTION release_give_claim(p_user_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE bounty_users SET last_give_at = NULL WHERE user_id = p_user_id;
END;
$$;
