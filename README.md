# Mirage Bot

A starter Discord bot for Mirage SMP using Node.js and discord.js.

## Requirements

- Node.js 20 or newer
- A Discord application and bot from the Discord Developer Portal
- Bot invited with the `bot` and `applications.commands` scopes
- Bot role placed above the `Verified` role

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in the IDs and token in `.env`.
3. Open a terminal in this folder and run:

   ```bash
   npm install discord.js dotenv
   npm start
   ```

4. Try `/link` and `/verify` in your Discord server.

## Important limitation

`/verify` checks only whether a member has the `Trusted` role, then grants `Verified`. It does **not** verify Minecraft ownership. `/link` is an informational placeholder until a Minecraft plugin or another trusted verification method is connected.

Never commit `.env` or share your bot token. If a token is exposed, reset it in the Discord Developer Portal.
