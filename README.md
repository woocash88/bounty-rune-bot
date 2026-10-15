# Bounty Rune Bot

Discord bot that randomly spawns "Bounty Rune" messages into selected text channels. The first user to click the **Zbierz bounty** button earns Gold. Balances are persisted in Supabase and can be viewed via slash commands.

## Features

- **Randomized spawn schedule** — uses a Poisson/exponential-interval model so spawns happen at random times, averaging ~1 per week (configurable). The schedule is persisted in Supabase and resumes across restarts.
- **Claim button** — first click wins the gold; the button is disabled instantly and the message is deleted so only one claim succeeds.
- **Persistent Gold** — balances stored in Supabase with atomic increments to prevent race conditions.
- **Slash commands** — check balance, view leaderboard, admin commands for Gold management.
- **Duplicate instance protection** — an instance lock in the database prevents a second bot process from starting a duplicate scheduler.
- **Graceful shutdown** — SIGINT/SIGTERM stop the scheduler, release the lock, and clean up.

## Tech Stack

- Node.js (LTS) + ESM
- discord.js v14
- @supabase/supabase-js
- dotenv

## Setup

### 1. Prerequisites

- Node.js v18 or later
- A Discord application with a bot token (https://discord.com/developers/applications)
- A Supabase project (https://supabase.com)

### 2. Environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application client ID |
| `DISCORD_GUILD_ID` | Server (guild) ID for guild-scoped command registration |
| `BOUNTY_CHANNEL_IDS` | Comma-separated list of text channel IDs where runes can spawn |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side, not anon key) |
| `BOUNTY_AVG_PER_WEEK` | Average spawns per week (default: 1) |
| `BOUNTY_GOLD_REWARD` | Gold awarded per claim (default: 50) |
| `BOUNTY_CLAIM_TIMEOUT_MS` | Ephemeral confirmation auto-delete delay in ms (default: 30000) |
| `ADMIN_LOG_CHANNEL_ID` | Optional: channel ID for scheduler error notifications |
| `MAX_GOLD_ADJUSTMENT` | Optional: max gold per /add or /remove command (default: 100000) |
| `BOUNTY_DUEL_STAKE` | Optional: base gold stake per player in /duel (default: 50); the real stake is rolled after acceptance (x1/x2/x4/x6 or VA BANK) |
| `BOUNTY_ROSHAN_ENTRY` | Optional: entry fee per player in /roshan (default: 50). Paid when the fight starts, never refunded; a lost fight costs only this fee |
| `BOUNTY_ROSHAN_GOLD` | Optional: gold prize pool in /roshan, split among the party (default: 660). The per-player share is rounded up (pool / party size), so with a pool that doesn't divide evenly the total payout can slightly exceed the pool. |
| `BOUNTY_ROSHAN_DEATH_CHANCE` | Optional: chance in percent (default: 5, 0 disables) that after a won /roshan fight one random player dies and gets no reward; the pool is then split among the survivors |
| `BOUNTY_ROSHAN_CHANCE_3` / `_4` / `_5` | Optional: /roshan win chance in percent for 3/4/5 players (defaults: 20/28/38) |
| `BOUNTY_ROSHAN_LOBBY_TIMEOUT_MIN` | Optional: minutes before an unfilled /roshan lobby expires (default: 10) |

### 3. Database

Run the SQL in `db/schema.sql` in your Supabase SQL editor. This creates all required tables and functions:

| Table | Purpose |
|---|---|
| `bounty_users` | User gold balances |
| `bounty_schedule` | Persisted next-spawn timestamp (singleton row) |
| `bot_instance_lock` | Instance lock for duplicate-process prevention (singleton row) |

| Function | Purpose |
|---|---|
| `increment_gold` | Atomic gold increment/decrement with 0-floor clamping |
| `try_deduct_gold` | Atomic gold deduction with row-level locking (returns false if insufficient) |
| `try_acquire_lock` | Atomic instance lock acquire with stale-threshold check |

### 4. Install dependencies

```bash
npm install
```

### 5. Register slash commands

```bash
npm run deploy
```

This registers all 10 slash commands to your test guild (guild-scoped for instant updates).

### 6. Start the bot

```bash
npm start        # Production
npm run dev      # Development (with nodemon auto-restart)
```

## Slash Commands

| Command | Description |
|---|---|
| `/bounty [user]` | Publiczny profil gracza: Gold, zebrane Bounty, zabite Roshany (swój lub wskazanego gracza) |
| `/bountyrank` | Top 10 leaderboard |
| `/resetglobal` | (Admin) Reset all users' Gold to 0 |
| `/reset <user>` | (Admin) Reset a specific user's Gold to 0 |
| `/add <user> <gold>` | (Admin) Add Gold to a user |
| `/remove <user> <gold>` | (Admin) Remove Gold from a user (won't go below 0) |
| `/rerollschedule` | (Admin) Clear the persisted schedule and recompute the next Bounty Rune spawn time using the current `BOUNTY_AVG_PER_WEEK` value |
| `/give <user> <amount>` | Przekaż część swojego Golda innemu użytkownikowi |
| `/duel <user>` | Wyzwij innego użytkownika na pojedynek o Gold. Stawka jest losowana kostką k100 po akceptacji: 1–50 → x1, 51–75 → x2, 76–90 → x4, 91–99 → x6 bazowej stawki (BOUNTY_DUEL_STAKE), 100 → **VA BANK** (cały portfel uboższego gracza). Stawka nigdy nie przekracza portfela uboższego gracza, a obaj płacą tyle samo. Zwycięzca dostaje 2× stawka |
| `/next` | Sprawdź kiedy pojawi się następna Bounty Runa (odczyt tylko, brak efektów ubocznych) |
| `/bounty_settings` | (Admin) Podsumowanie wszystkich ustawień w jednym embedzie |
| `/bounty_gold_reward [value]` | (Admin) Nagroda za Bounty Runę w Gold; bez argumentu pokazuje aktualną wartość |
| `/bounty_avg_per_week [value]` | (Admin) Średnia liczba spawnów na tydzień; od razu przelicza termin następnej runy |
| `/bounty_claim_timeout [value]` | (Admin) Po ilu sekundach znika potwierdzenie zebrania runy |
| `/bounty_duel_stake [value]` | (Admin) Stawka w /duel (na gracza) |
| `/roshan_entry [value]` | (Admin) Wpisowe do walki z Roshanem (na gracza) |
| `/roshan_gold [value]` | (Admin) Pula nagrody za Roshana, dzielona na drużynę |
| `/roshan_5_winchance`, `/roshan_4_winchance`, `/roshan_3_winchance [value]` | (Admin) Szansa na pokonanie Roshana w % dla 5/4/3 graczy |
| `/roshan_death_chance [value]` | (Admin) Szansa w % (domyślnie 5, 0 wyłącza), że po wygranej walce jeden losowy gracz poległ i nie dostaje nagrody — pulę dzielą ocaleni |
| `/roshan_lobby_timeout [value]` | (Admin) Po ilu minutach wygasa niezapełnione lobby Roshana |
| `/roshan` | Przywołaj Roshana: zbierz 3–5 graczy, walka z ukrytą szansą na wygraną (nagroda/kara: BOUNTY_ROSHAN_GOLD dzielone na drużynę, udział na osobę zaokrąglany w górę — przy puli niepodzielnej równo suma wypłat może lekko przekroczyć pulę) |

## Reliability

- **Race-safe claims**: button is disabled as the first action, an in-memory claim set prevents double-processing, and gold is awarded atomically via a Postgres function.
- **Persistent schedule**: the next spawn time is stored in Supabase. Restarting the bot mid-wait does not reset the timer.
- **Duplicate-process guard**: on startup the bot acquires a DB lock with a 60-second stale threshold and sends a 30-second heartbeat. A second instance will refuse to start its scheduler.
- **Graceful shutdown**: SIGINT/SIGTERM stop the scheduler, release the lock, and close the Discord connection.
- **Input validation**: `/add` and `/remove` enforce a configurable upper bound (`MAX_GOLD_ADJUSTMENT`).
- **Admin alerts**: if `ADMIN_LOG_CHANNEL_ID` is set, scheduler errors are posted to that channel.

## Project Structure

```
├── db/
│   └── schema.sql              # Supabase table + function SQL
├── src/
│   ├── commands/               # One file per slash command
│   ├── db/
│   │   ├── supabaseClient.js   # Supabase client init
│   │   └── queries.js          # DB query helpers
│   ├── events/
│   │   ├── ready.js            # Client ready handler + instance lock
│   │   └── interactionCreate.js# Interaction handler (commands + buttons)
│   ├── scheduler/
│   │   └── bountyScheduler.js  # Randomized bounty rune spawn scheduler
│   ├── utils/
│   │   ├── bountyEmbed.js      # Embed + button builder
│   │   ├── heartbeat.js        # Instance lock heartbeat loop
│   │   └── logger.js           # Simple logger with timestamps
│   ├── deployCommands.js       # Slash command registration script
│   └── index.js                # Bot entry point + graceful shutdown
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## License

MIT

## Ustawienia zmieniane z Discorda

Wartości powyższych komend są zapisywane w tabeli `bot_settings` (Supabase) i działają od razu, bez restartu. Kolejność: wartość ustawiona z Discorda > `.env` > domyślna. Wymaga uruchomienia sekcji `bot_settings` z `db/schema.sql`.
