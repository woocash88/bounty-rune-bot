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
| `BOUNTY_DUEL_STAKE` | Optional: gold stake per player in /duel (default: 50) |

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
| `/bounty` | Check your Gold balance |
| `/bountyrank` | Top 10 leaderboard |
| `/resetglobal` | (Admin) Reset all users' Gold to 0 |
| `/reset <user>` | (Admin) Reset a specific user's Gold to 0 |
| `/add <user> <gold>` | (Admin) Add Gold to a user |
| `/remove <user> <gold>` | (Admin) Remove Gold from a user (won't go below 0) |
| `/rerollschedule` | (Admin) Clear the persisted schedule and recompute the next Bounty Rune spawn time using the current `BOUNTY_AVG_PER_WEEK` value |
| `/give <user> <amount>` | Przekaż część swojego Golda innemu użytkownikowi |
| `/duel <user>` | Wyzwij innego użytkownika na pojedynek o Gold (stawka: BOUNTY_DUEL_STAKE) |

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
