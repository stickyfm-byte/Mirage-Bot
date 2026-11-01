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


## Actor agreement system

The bot includes a separate Actor agreement workflow. When the configured Actor role is assigned, the bot removes it temporarily, gives the member **Pending Actor**, and privately sends both Mirage Actor documents. The Pending Actor role is removed and the Actor role is restored only after the member selects **I Agree**. Members who decline have neither role until an administrator re-enables the agreement.

Add this environment variable to your hosting panel:

- `ACTOR_ROLE_ID` — the Discord ID of the Actor role.
- `PENDING_ACTOR_ROLE_ID` — the Discord ID of the Pending Actor role (create this role in Discord first).

Optional:

- `ACTOR_AGREEMENT_VERSION` — agreement version recorded for each acceptance (defaults to `1.0`). Increase this when actors must accept a materially updated agreement.

Administrator commands (requires **Manage Server**):

- `/actor-agreement-status` — check your status; administrators may specify another member.
- `/actor-agreement-resend` — resend an agreement that is still pending.
- `/actor-agreement-enable` — allow a member who declined to respond again and send them a fresh agreement.

A declined member cannot restore the Actor role by having it manually reassigned. An administrator must first use `/actor-agreement-enable`. Agreement records are stored in `data/actor-agreement.json`.

Place the bot's highest role above both the Actor and Pending Actor roles and ensure it has **Manage Roles** permission. Members must be able to receive direct messages from the server.


## Opt-in bot DM history

The bot includes an administrator-only `/chat-history user:@Member` command. It displays up to the 15 most recent text messages that a member has sent to the bot in DMs. The bot stores at most the latest 100 text messages per consenting user. Server-channel messages and attachments are not recorded by this feature.

**Discord Developer Portal requirement:** enable **Message Content Intent** under your bot's Privileged Gateway Intents. The bot also requests the Direct Messages gateway intent. Without Message Content Intent, Discord will not provide the DM text needed by this feature.

Recording is opt-in. On first contact, the bot explains the feature and asks the user to send `START` to display the consent buttons. Messages are only saved after the user selects **I Agree**. Selecting **I Do Not Agree** leaves recording disabled.

Users can send:
- `STOP` — stop recording future messages. Previously stored history remains.
- `DELETE` — delete their stored history and turn recording off.
- `START` — review the notice and opt in again.

Only members with the Discord **Administrator** permission can use `/chat-history`. Results are sent ephemerally. Store the bot's `data/` directory securely on persistent hosting storage, restrict access to it, and establish an appropriate retention policy for your community.
