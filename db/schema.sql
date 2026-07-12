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
