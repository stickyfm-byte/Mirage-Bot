// DatHost Minecraft console bridge for Mirage Bot.
// Loaded with Node's --require flag so index.js does not need invasive changes.

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const ENV = process.env;
const EMAIL = ENV.DATHOST_EMAIL?.trim();
const PASSWORD = ENV.DATHOST_PASSWORD;
const SERVER_ID = ENV.DATHOST_SERVER_ID?.trim();
const CHANNEL_ID = ENV.DATHOST_CONSOLE_CHANNEL_ID?.trim();
const ALLOWED_ROLE_ID = ENV.DATHOST_CONSOLE_ROLE_ID?.trim();
const GUILD_ID = ENV.GUILD_ID?.trim();
const API_BASE = 'https://dathost.com/api/0.1';
const POLL_INTERVAL_MS = 5000;
const MAX_LOG_LINES = 200;
const MAX_COMMAND_LENGTH = 500;

function log(message, error) {
  if (error) console.error('[dathost-console]', message, error);
  else console.log('[dathost-console]', message);
}

function getAuthHeader() {
  return 'Basic ' + Buffer.from(EMAIL + ':' + PASSWORD).toString('base64');
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: getAuthHeader(),
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`DatHost API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function normaliseLines(payload) {
  if (Array.isArray(payload)) return payload.map(String);
  if (typeof payload === 'string') {
    return payload.split(/\r?\n/).filter(Boolean);
  }
  if (payload && Array.isArray(payload.lines)) {
    return payload.lines.map(String);
  }
  if (payload && Array.isArray(payload.console)) {
    return payload.console.map(String);
  }
  throw new Error('Unexpected DatHost console response format.');
}

function overlapLength(previous, current) {
  const max = Math.min(previous.length, current.length);
  for (let size = max; size > 0; size--) {
    let matches = true;
    for (let i = 0; i < size; i++) {
      if (previous[previous.length - size + i] !== current[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

function safeLogLine(line) {
  return String(line)
    .replace(/@/g, '@\u200b')
    .replace(/\u0000/g, '')
    .replace(/`/g, 'ˋ')
    .slice(0, 500);
}

async function sendLogLines(channel, lines) {
  if (!lines.length) return;

  let chunk = [];
  let length = 0;

  for (const rawLine of lines) {
    const line = safeLogLine(rawLine);
    const addition = line.length + 1;

    if (chunk.length && length + addition > 1700) {
      await channel.send({
        content: '```text\n' + chunk.join('\n') + '\n```',
        allowedMentions: { parse: [] },
      });
      chunk = [];
      length = 0;
    }

    chunk.push(line);
    length += addition;
  }

  if (chunk.length) {
    await channel.send({
      content: '```text\n' + chunk.join('\n') + '\n```',
      allowedMentions: { parse: [] },
    });
  }
}

function hasConsoleAccess(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return Boolean(ALLOWED_ROLE_ID && member.roles?.cache?.has(ALLOWED_ROLE_ID));
}

function attachConsoleBridge(client) {
  if (!EMAIL || !PASSWORD || !SERVER_ID || !CHANNEL_ID || !GUILD_ID || !ALLOWED_ROLE_ID) {
    log(
      'Bridge disabled. Configure DATHOST_EMAIL, DATHOST_PASSWORD, DATHOST_SERVER_ID, ' +
      'DATHOST_CONSOLE_CHANNEL_ID, DATHOST_CONSOLE_ROLE_ID and GUILD_ID in the bot host environment.'
    );
    return;
  }

  if (client.__mirageDathostBridgeAttached) return;
  client.__mirageDathostBridgeAttached = true;

  // The main bot already requests MessageContent. Add GuildMessages before login
  // so the bridge can receive messages sent in the console channel.
  try {
    client.options.intents = client.options.intents.add(GatewayIntentBits.GuildMessages);
  } catch (error) {
    log('Could not enable the GuildMessages intent.', error);
    return;
  }

  let consoleChannel = null;
  let previousLines = null;
  let polling = false;
  let lastApiErrorAt = 0;
  const commandCooldowns = new Map();

  async function pollConsole() {
    if (polling || !consoleChannel) return;
    polling = true;

    try {
      const url = `${API_BASE}/game-servers/${encodeURIComponent(SERVER_ID)}/console?max_lines=${MAX_LOG_LINES}`;
      const payload = await apiRequest(url);
      const currentLines = normaliseLines(payload);

      if (previousLines === null) {
        previousLines = currentLines.slice(-MAX_LOG_LINES);
        await sendLogLines(consoleChannel, currentLines.slice(-25));
        return;
      }

      const overlap = overlapLength(previousLines, currentLines);
      const newLines = overlap > 0
        ? currentLines.slice(overlap)
        : currentLines.slice(-Math.min(currentLines.length, 20));

      if (newLines.length) await sendLogLines(consoleChannel, newLines);
      previousLines = currentLines.slice(-MAX_LOG_LINES);
    } catch (error) {
      const now = Date.now();
      if (now - lastApiErrorAt > 60000) {
        lastApiErrorAt = now;
        log('Unable to retrieve server console output. Check the DatHost API credentials, server ID and API access.', error);
        await consoleChannel.send({
          content: '⚠️ **Console connection issue:** I could not retrieve logs from DatHost. Check the bot host logs for details.',
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
    } finally {
      polling = false;
    }
  }

  client.on('messageCreate', async message => {
    if (message.author.bot || message.guildId !== GUILD_ID || message.channelId !== CHANNEL_ID) return;

    const member = message.member ||
      await message.guild.members.fetch(message.author.id).catch(() => null);

    if (!hasConsoleAccess(member)) {
      await message.reply({
        content: 'You do not have permission to use the Minecraft console.',
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
      return;
    }

    const command = message.content.trim().replace(/^\//, '');
    if (!command) return;

    if (command.length > MAX_COMMAND_LENGTH || /[\r\n\u0000]/.test(command)) {
      await message.reply({
        content: `Commands must be a single line and no longer than ${MAX_COMMAND_LENGTH} characters.`,
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
      return;
    }

    const now = Date.now();
    const lastCommandAt = commandCooldowns.get(message.author.id) || 0;
    if (now - lastCommandAt < 1200) {
      await message.reply({
        content: 'Please wait a moment before sending another command.',
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
      return;
    }
    commandCooldowns.set(message.author.id, now);

    try {
      const url = `${API_BASE}/game-servers/${encodeURIComponent(SERVER_ID)}/console`;
      await apiRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ line: command }).toString(),
      });

      log(`Console command sent by ${message.author.tag}: ${command.slice(0, 120)}`);
      await message.react('✅').catch(() => {});
    } catch (error) {
      log('Failed to send a console command.', error);
      await message.reply({
        content: 'DatHost rejected the command or the console connection failed. Check the bot host logs.',
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
    }
  });

  client.once('ready', async () => {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      consoleChannel = await guild.channels.fetch(CHANNEL_ID);

      if (!consoleChannel || consoleChannel.type !== ChannelType.GuildText) {
        throw new Error('DATHOST_CONSOLE_CHANNEL_ID must point to a text channel in GUILD_ID.');
      }

      log(`Connected to Discord channel #${consoleChannel.name}; polling DatHost every ${POLL_INTERVAL_MS / 1000}s.`);
      await consoleChannel.send({
        content: '**MIRAGE | MINECRAFT CONSOLE**\nLive DatHost output is connected. Send a console command as a normal message in this channel.',
        allowedMentions: { parse: [] },
      });

      await pollConsole();
      const timer = setInterval(pollConsole, POLL_INTERVAL_MS);
      timer.unref();
    } catch (error) {
      log('Could not initialise the console channel.', error);
    }
  });
}

const originalLogin = require('discord.js').Client.prototype.login;
require('discord.js').Client.prototype.login = function (...args) {
  attachConsoleBridge(this);
  return originalLogin.apply(this, args);
};
