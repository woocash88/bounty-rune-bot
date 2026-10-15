import { getAllSettings, upsertSetting } from '../db/queries.js';
import { log, error } from './logger.js';

/**
 * Runtime-configurable settings.
 * Precedence: value set from Discord (stored in Supabase) > .env > default.
 *
 * `scale` converts the unit shown to admins into the stored unit
 * (e.g. claim timeout: admins type seconds, code stores milliseconds).
 */
export const SETTINGS = {
  gold_reward: {
    env: 'BOUNTY_GOLD_REWARD', def: 50, min: 1, max: 100000, int: true, scale: 1,
    label: 'Nagroda za Bounty Runę', unit: 'Gold',
  },
  avg_per_week: {
    env: 'BOUNTY_AVG_PER_WEEK', def: 1, min: 0.1, max: 100, int: false, scale: 1,
    label: 'Średnia liczba spawnów Bounty Runy na tydzień', unit: 'spawnów/tydzień',
  },
  claim_timeout: {
    env: 'BOUNTY_CLAIM_TIMEOUT_MS', def: 30000, min: 5, max: 600, int: true, scale: 1000,
    label: 'Czas do automatycznego zniknięcia potwierdzenia zebrania runy', unit: 's',
  },
  duel_stake: {
    env: 'BOUNTY_DUEL_STAKE', def: 50, min: 1, max: 100000, int: true, scale: 1,
    label: 'Stawka w pojedynku (na gracza)', unit: 'Gold',
  },
  roshan_entry: {
    env: 'BOUNTY_ROSHAN_ENTRY', def: 50, min: 1, max: 100000, int: true, scale: 1,
    label: 'Wpisowe do walki z Roshanem (na gracza)', unit: 'Gold',
  },
  roshan_gold: {
    env: 'BOUNTY_ROSHAN_GOLD', def: 660, min: 1, max: 100000, int: true, scale: 1,
    label: 'Pula nagrody za Roshana (dzielona na ocalałych)', unit: 'Gold',
  },
  roshan_chance_5: {
    env: 'BOUNTY_ROSHAN_CHANCE_5', def: 38, min: 0, max: 100, int: false, scale: 1,
    label: 'Szansa na pokonanie Roshana — 5 graczy', unit: '%',
  },
  roshan_chance_4: {
    env: 'BOUNTY_ROSHAN_CHANCE_4', def: 28, min: 0, max: 100, int: false, scale: 1,
    label: 'Szansa na pokonanie Roshana — 4 graczy', unit: '%',
  },
  roshan_chance_3: {
    env: 'BOUNTY_ROSHAN_CHANCE_3', def: 20, min: 0, max: 100, int: false, scale: 1,
    label: 'Szansa na pokonanie Roshana — 3 graczy', unit: '%',
  },
  roshan_death_chance: {
    env: 'BOUNTY_ROSHAN_DEATH_CHANCE', def: 5, min: 0, max: 100, int: false, scale: 1,
    label: 'Szansa na śmierć losowego gracza po wygranej walce', unit: '%',
  },
  roshan_lobby_timeout: {
    env: 'BOUNTY_ROSHAN_LOBBY_TIMEOUT_MIN', def: 10, min: 1, max: 120, int: true, scale: 1,
    label: 'Czas oczekiwania lobby Roshana', unit: 'min',
  },
};

// Overrides set from Discord. Map<key, number> (stored unit).
const overrides = new Map();

/** Load overrides from Supabase. Call once at startup, before logging in. */
export async function loadSettings() {
  try {
    const rows = await getAllSettings();
    for (const { key, value } of rows) {
      const n = Number(value);
      if (SETTINGS[key] && Number.isFinite(n)) overrides.set(key, n);
    }
    log(`Loaded ${overrides.size} setting override(s) from database.`);
  } catch (err) {
    // Table may not exist yet — fall back to .env/defaults.
    error('Could not load settings from database (using .env/defaults):', err.message);
  }
}

/** Current value in the stored unit (ms for claim_timeout, percent for chances, ...). */
export function getSetting(key) {
  const s = SETTINGS[key];
  if (!s) throw new Error(`Unknown setting: ${key}`);
  if (overrides.has(key)) return overrides.get(key);
  const fromEnv = Number(process.env[s.env]);
  if (process.env[s.env] !== undefined && process.env[s.env] !== '' && Number.isFinite(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return s.def;
}

/** Current value in the unit admins see (seconds for claim_timeout, ...). */
export function getSettingDisplay(key) {
  return getSetting(key) / SETTINGS[key].scale;
}

/** Persist and apply a new value given in the admin-facing unit. */
export async function setSetting(key, displayValue) {
  const s = SETTINGS[key];
  const stored = displayValue * s.scale;
  await upsertSetting(key, stored);
  overrides.set(key, stored);
  return stored;
}
