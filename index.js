
require('dotenv').config();

// ========================================
// STARTUP DIAGNOSTICS
// ========================================

function logMemory(stage) {
  const memory = process.memoryUsage();
  const mb = value => (value / 1024 / 1024).toFixed(1);
  console.log(
    `[memory] ${stage} | RSS ${mb(memory.rss)} MB | heap ${mb(memory.heapUsed)}/${mb(memory.heapTotal)} MB | external ${mb(memory.external)} MB`
  );
}

console.log('[startup] Mirage Bot process launched.');
console.log(`[startup] Node.js ${process.version} | platform ${process.platform}`);

// Show what limits Node can actually see. If the V8 heap limit is far above
// your host's RAM allowance, the garbage collector will happily let memory
// grow until the host kills the process.
try {
  const heapLimitMb = (
    require('node:v8').getHeapStatistics().heap_size_limit / 1024 / 1024
  ).toFixed(0);
  let cgroupLimit = 'unknown';
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = require('node:fs').readFileSync(file, 'utf8').trim();
      cgroupLimit = /^\d+$/.test(raw) && Number(raw) < 2 ** 50
        ? `${(Number(raw) / 1024 / 1024).toFixed(0)} MB`
        : 'none';
      break;
    } catch {}
  }
  console.log(`[startup] V8 heap limit ${heapLimitMb} MB | container memory limit ${cgroupLimit}`);
  console.log(`[startup] NODE_OPTIONS=${process.env.NODE_OPTIONS || '(not set)'} | execArgv=${process.execArgv.join(' ') || '(none)'}`);
} catch {}

logMemory('process start');

// Sampled once a minute (every 10 seconds was noisy). Also warns loudly when
// the process gets close to a 1 GB host limit so it shows up in your console.
const memoryMonitor = setInterval(() => {
  logMemory('runtime sample');
  if (process.memoryUsage().rss > 800 * 1024 * 1024) {
    console.warn('[memory] WARNING: RSS is above 800 MB. Send this log to your developer.');
  }
}, 60 * 1000);
memoryMonitor.unref();

process.on('uncaughtException', error => {
  console.error('[process] Uncaught exception:', error);
});

process.on('unhandledRejection', reason => {
  console.error('[process] Unhandled rejection:', reason);
});

process.on('warning', warning => {
  console.warn('[process] Node warning:', warning);
});

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  Options,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

// ========================================
// CONFIGURATION
// ========================================

const REQUIRED = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'TRUSTED_ROLE_ID',
  'VERIFIED_ROLE_ID',
  'MODERATOR_ROLE_ID',
];

for (const key of REQUIRED) {
  if (!process.env[key]?.trim()) {
    console.error(`Missing ${key} in your environment variables.`);
    process.exit(1);
  }
}

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  TRUSTED_ROLE_ID,
  VERIFIED_ROLE_ID,
  LINK_CHANNEL_ID = '',
  MODERATOR_ROLE_ID,
  MODERATOR_PENDING_ROLE_ID = '',
  HANDBOOK_CHANNEL_ID = '',
  HANDBOOK_VERSION = '1.1',
  HANDBOOK_DEADLINE_HOURS = '24',
  TRUSTED_CHECK_CHANNEL_ID = '',
} = process.env;

const HANDBOOK_URL =
  'https://docs.google.com/document/d/1oj7AjwgOFiwpU4ZrvhYu4adc_TF0ek_vMlFKYuNFrL0/edit';
const DEADLINE_HOURS = Number(HANDBOOK_DEADLINE_HOURS);

if (!Number.isFinite(DEADLINE_HOURS) || DEADLINE_HOURS <= 0) {
  console.error('HANDBOOK_DEADLINE_HOURS must be a positive number.');
  process.exit(1);
}

const CODE_LIFETIME = 5 * 60 * 1000;
const CODE_COOLDOWN = 30 * 1000;
const MAX_ATTEMPTS = 5;

const DATA_DIR = path.join(__dirname, 'data');
const VERIFICATION_DATABASE = path.join(DATA_DIR, 'verification.json');
const HANDBOOK_DATABASE = path.join(DATA_DIR, 'handbook.json');
const TRUSTED_CHECK_DATABASE = path.join(DATA_DIR, 'trusted-check.json');

// This bot never reads messages, presences, voice, threads, emojis, etc., so
// there is no reason to keep any of that in memory. Guild members, roles and
// channels (which the bot does use) keep the discord.js defaults.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
    PresenceManager: 0,
    VoiceStateManager: 0,
    StageInstanceManager: 0,
    ThreadManager: 0,
    ThreadMemberManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
    GuildScheduledEventManager: 0,
    GuildInviteManager: 0,
    GuildBanManager: 0,
    // NOTE: do NOT zero ReactionManager. The weekly Trusted check reads
    // message.reactions.resolve('✅'); an empty reaction cache would make the
    // bot think nobody reacted and remove Trusted from everyone.
    AutoModerationRuleManager: 0,
    EntitlementManager: 0,
    BaseGuildEmojiManager: 0,
  }),
});

let db = {
  codes: {},
  records: {},
};

let handbookDB = {
  records: {},
};

let trustedCheckDB = {
  nextRunAt: null,
  activeCheck: null,
};

let verificationSaveQueue = Promise.resolve();
let handbookSaveQueue = Promise.resolve();
let trustedCheckSaveQueue = Promise.resolve();
let deadlineTimer = null;
let trustedCheckTimer = null;
let trustedCheckRunning = false;

client.on('error', error => console.error('[discord] Client error:', error));
client.on('shardError', error => console.error('[discord] Gateway shard error:', error));

// ========================================
// SLASH COMMANDS
// ========================================

const commands = [
  new SlashCommandBuilder()
    .setName('verify-panel')
    .setDescription('Post the Mirage verification panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Verify your Mirage Discord account.')
    .addStringOption(option =>
      option
        .setName('code')
        .setDescription('Your private verification code.')
        .setMinLength(8)
        .setMaxLength(8)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('verify-status')
    .setDescription('Check your Mirage verification status.'),

  new SlashCommandBuilder()
    .setName('handbook-status')
    .setDescription('Check your moderator handbook agreement status.'),

  new SlashCommandBuilder()
    .setName('handbook-resend')
    .setDescription('Resend the moderator handbook agreement to a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(option =>
      option
        .setName('member')
        .setDescription('The member who needs to accept the handbook.')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('trusted-check')
    .setDescription('Manually start a Trusted role reaction check.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('ban-notice')
    .setDescription('Send a formal Mirage removal notice to a user by Discord ID.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option =>
      option
        .setName('user-id')
        .setDescription('The recipient\'s Discord user ID.')
        .setMinLength(17)
        .setMaxLength(20)
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('The recipient\'s name to display in the notice.')
        .setMaxLength(32)
        .setRequired(true)
    ),
].map(command => command.toJSON());

// ========================================
// DATABASE
// ========================================

async function loadJSON(file, fallback) {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;

    await fs.writeFile(file, JSON.stringify(fallback, null, 2), {
      mode: 0o600,
    });

    return fallback;
  }
}

async function saveJSON(file, data, queueName) {
  const operation = async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });

    const temp = `${file}.tmp`;

    await fs.writeFile(temp, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });

    await fs.rename(temp, file);
  };

  if (queueName === 'verification') {
    verificationSaveQueue = verificationSaveQueue
      .catch(() => {})
      .then(operation);

    return verificationSaveQueue;
  }

  if (queueName === 'trusted') {
    trustedCheckSaveQueue = trustedCheckSaveQueue
      .catch(() => {})
      .then(operation);
    return trustedCheckSaveQueue;
  }

  handbookSaveQueue = handbookSaveQueue
    .catch(() => {})
    .then(operation);

  return handbookSaveQueue;
}

async function loadDatabase() {
  const parsed = await loadJSON(VERIFICATION_DATABASE, {
    codes: {},
    records: {},
  });

  db = {
    codes: parsed.codes || {},
    records: parsed.records || {},
  };
}

async function saveDatabase() {
  return saveJSON(
    VERIFICATION_DATABASE,
    db,
    'verification'
  );
}

async function loadHandbookDatabase() {
  const parsed = await loadJSON(HANDBOOK_DATABASE, {
    records: {},
  });

  handbookDB = {
    records: parsed.records || {},
  };
}

async function saveHandbookDatabase() {
  return saveJSON(
    HANDBOOK_DATABASE,
    handbookDB,
    'handbook'
  );
}

async function loadTrustedCheckDatabase() {
  const parsed = await loadJSON(TRUSTED_CHECK_DATABASE, {
    nextRunAt: null,
    activeCheck: null,
  });

  trustedCheckDB = {
    nextRunAt: parsed.nextRunAt || null,
    activeCheck: parsed.activeCheck || null,
  };
}

async function saveTrustedCheckDatabase() {
  return saveJSON(
    TRUSTED_CHECK_DATABASE,
    trustedCheckDB,
    'trusted'
  );
}

// ========================================
// VERIFICATION CODES
// ========================================

function hashCode(code) {
  return crypto
    .createHash('sha256')
    .update(code.toUpperCase())
    .digest('hex');
}

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);

  return Array.from(bytes)
    .map(byte => alphabet[byte % alphabet.length])
    .join('');
}

// ========================================
// ROLE HELPERS
// ========================================

async function getVerifiedRole(guild) {
  const botMember = await guild.members.fetchMe();

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('The bot needs the Manage Roles permission.');
  }

  const role = await guild.roles.fetch(VERIFIED_ROLE_ID);

  if (!role) {
    throw new Error('The configured Verified role does not exist.');
  }

  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error(
      'Move the bot role above Verified in Server Settings > Roles.'
    );
  }

  return role;
}

async function getModeratorRole(guild) {
  const botMember = await guild.members.fetchMe();

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('The bot needs the Manage Roles permission.');
  }

  const role = await guild.roles.fetch(MODERATOR_ROLE_ID);

  if (!role) {
    throw new Error('The configured Moderator role does not exist.');
  }

  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error(
      'Move the bot role above Moderator in Server Settings > Roles.'
    );
  }

  return role;
}

async function getMember(interaction) {
  return interaction.guild.members.fetch(interaction.user.id);
}

function hasTrusted(member) {
  return member.roles.cache.has(TRUSTED_ROLE_ID);
}

function hasVerified(member) {
  return member.roles.cache.has(VERIFIED_ROLE_ID);
}

function hasAcceptedCurrentHandbook(userId) {
  const record = handbookDB.records[userId];

  return Boolean(
    record &&
    record.status === 'accepted' &&
    record.version === HANDBOOK_VERSION
  );
}

// ========================================
// VERIFICATION PANEL
// ========================================

const verificationPanel = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId('mirage_get_verification_code')
    .setLabel('Get verification code')
    .setStyle(ButtonStyle.Primary)
);

// ========================================
// HANDBOOK AGREEMENT BUTTONS
// ========================================

function createHandbookButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('mirage_handbook_accept')
        .setLabel('Accept Handbook')
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId('mirage_handbook_decline')
        .setLabel('Decline')
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function createHandbookEmbed(deadline) {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('MIRAGE | MODERATOR HANDBOOK')
    .setDescription(
      'Your account has been assigned the Moderator role. ' +
      'Before you can access Moderator permissions, you must read and ' +
      'accept the current Mirage Moderator Staff Handbook.\n\n' +

      `📘 **[Read the Moderator Handbook](${HANDBOOK_URL})**\n\n` +

      '**Please read the entire handbook before accepting.**\n\n' +

      'By selecting **Accept Handbook**, you confirm that you have read ' +
      'and agree to follow the current handbook. If you decline, your ' +
      'Moderator access will remain disabled.\n\n' +

      `**Handbook version:** ${HANDBOOK_VERSION}\n` +
      `**Response deadline:** <t:${Math.floor(deadline / 1000)}:F>\n\n` +

      `You have ${DEADLINE_HOURS} hour(s) to respond.`
    )
    .setFooter({
      text: 'Mirage Staff • Handbook acceptance required',
    })
    .setTimestamp();
}
// ========================================
// HANDBOOK ROLE MANAGEMENT
// ========================================

async function setPending(member) {
  const moderatorRole = await getModeratorRole(member.guild);

  if (member.roles.cache.has(MODERATOR_ROLE_ID)) {
    await member.roles.remove(
      moderatorRole,
      'Moderator handbook acceptance required'
    );
  }

  if (MODERATOR_PENDING_ROLE_ID) {
    const pendingRole = await member.guild.roles.fetch(
      MODERATOR_PENDING_ROLE_ID
    );

    if (!pendingRole) {
      throw new Error(
        'The configured pending role does not exist.'
      );
    }

    const botMember = await member.guild.members.fetchMe();

    if (botMember.roles.highest.comparePositionTo(pendingRole) <= 0) {
      throw new Error(
        'Move the bot role above the pending role.'
      );
    }

    if (!member.roles.cache.has(MODERATOR_PENDING_ROLE_ID)) {
      await member.roles.add(
        pendingRole,
        'Waiting for moderator handbook acceptance'
      );
    }
  }
}

async function clearPendingRole(member) {
  if (!MODERATOR_PENDING_ROLE_ID) return;

  if (member.roles.cache.has(MODERATOR_PENDING_ROLE_ID)) {
    const pendingRole = await member.guild.roles.fetch(
      MODERATOR_PENDING_ROLE_ID
    );

    if (pendingRole) {
      await member.roles.remove(
        pendingRole,
        'Moderator handbook agreement processed'
      );
    }
  }
}

async function sendHandbookDM(member) {
  const record = handbookDB.records[member.id];

  if (!record || record.status !== 'pending') return;

  const embed = createHandbookEmbed(record.deadline);

  await member.send({
    embeds: [embed],
    components: createHandbookButtons(),
  });
}

async function beginHandbookAgreement(member, forceResend = false) {
  if (member.user.bot) return;

  const existing = handbookDB.records[member.id];
  const now = Date.now();

  if (
    existing &&
    existing.status === 'accepted' &&
    existing.version === HANDBOOK_VERSION
  ) {
    return;
  }

  if (
    existing &&
    existing.status === 'pending' &&
    existing.version === HANDBOOK_VERSION &&
    existing.deadline > now
  ) {
    await setPending(member);

    if (forceResend) {
      await sendHandbookDM(member);
    }

    return;
  }

  const deadline = now + DEADLINE_HOURS * 60 * 60 * 1000;

  handbookDB.records[member.id] = {
    status: 'pending',
    version: HANDBOOK_VERSION,
    startedAt: new Date(now).toISOString(),
    deadline,
    acceptedAt: null,
  };

  await saveHandbookDatabase();
  await setPending(member);

  try {
    await sendHandbookDM(member);
  } catch (error) {
    console.error(
      `Could not DM the handbook agreement to ${member.user.tag}:`,
      error.message
    );
  }

  console.log(
    `Handbook acceptance required from ${member.user.tag}.`
  );
}

async function expireHandbookAgreement(member) {
  const record = handbookDB.records[member.id];

  if (!record || record.status !== 'pending') return;

  try {
    await setPending(member);
    await clearPendingRole(member);

    record.status = 'expired';
    record.expiredAt = new Date().toISOString();

    await saveHandbookDatabase();

    await member.send(
      'Your Mirage Moderator Handbook agreement deadline has passed. ' +
      'Your Moderator access remains disabled. Contact server management ' +
      'if you still need to complete the agreement.'
    ).catch(() => {});

    console.log(`Handbook agreement expired for ${member.user.tag}.`);
  } catch (error) {
    console.error(
      `Failed to expire handbook agreement for ${member.user.tag}:`,
      error
    );
  }
}

async function checkHandbookDeadlines() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const now = Date.now();

  for (const [userId, record] of Object.entries(handbookDB.records)) {
    if (
      record.status !== 'pending' ||
      record.deadline > now
    ) {
      continue;
    }

    try {
      const member = await guild.members.fetch(userId).catch(() => null);

      if (!member) {
        record.status = 'expired';
        record.expiredAt = new Date().toISOString();
        await saveHandbookDatabase();
        continue;
      }

      await expireHandbookAgreement(member);
    } catch (error) {
      console.error(`Deadline check failed for ${userId}:`, error);
    }
  }
}

async function reconcileModerators(guild) {
  // Avoid fetching and caching every server member on startup; this can
  // exceed the bot's memory limit on larger Discord servers.
  for (const member of guild.members.cache.values()) {
    if (!member.roles.cache.has(MODERATOR_ROLE_ID)) continue;
    if (hasAcceptedCurrentHandbook(member.id)) continue;

    try {
      await beginHandbookAgreement(member);
    } catch (error) {
      console.error(
        `Could not reconcile moderator ${member.user.tag}:`,
        error
      );
    }
  }

  await checkHandbookDeadlines();
}

// ========================================
// WEEKLY TRUSTED ROLE CHECK
// ========================================

const TRUSTED_CHECK_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const TRUSTED_CHECK_RANDOM_WINDOW = 24 * 60 * 60 * 1000;
const TRUSTED_CHECK_DEADLINE = 24 * 60 * 60 * 1000;
const TRUSTED_CHECK_EMOJI = '✅';

function randomTrustedCheckDelay() {
  return TRUSTED_CHECK_INTERVAL +
    Math.floor(Math.random() * TRUSTED_CHECK_RANDOM_WINDOW);
}

async function postTrustedCheck(guild) {
  if (!TRUSTED_CHECK_CHANNEL_ID) {
    console.error('TRUSTED_CHECK_CHANNEL_ID is not configured.');
    return;
  }

  const channel = await guild.channels.fetch(TRUSTED_CHECK_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased() || !channel.messages || !channel.send) {
    throw new Error('Trusted check channel is missing or is not a text channel.');
  }

  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('The bot needs Manage Roles to run Trusted checks.');
  }

  const trustedRole = await guild.roles.fetch(TRUSTED_ROLE_ID);
  if (!trustedRole) throw new Error('Trusted role could not be found.');
  if (botMember.roles.highest.comparePositionTo(trustedRole) <= 0) {
    throw new Error('Move the bot role above Trusted in the role hierarchy.');
  }

  const memberIds = guild.members.cache
    .filter(member => !member.user.bot && member.roles.cache.has(TRUSTED_ROLE_ID))
    .map(member => member.id);

  if (memberIds.length === 0) {
    trustedCheckDB.nextRunAt = Date.now() + randomTrustedCheckDelay();
    await saveTrustedCheckDatabase();
    console.log('No Trusted members found; this weekly check was skipped.');
    return false;
  }

  const startedAt = Date.now();
  const deadline = startedAt + TRUSTED_CHECK_DEADLINE;
  const message = await channel.send({
    content:
      `<@&${trustedRole.id}>\n\n` +
      '**MIRAGE | TRUSTED ROLE CHECK**\n\n' +
      'React to this message with **✅** within the next **24 hours** ' +
      'to keep your Trusted role.\n\n' +
      'If you do not react before the deadline, your **Trusted role will be removed**.\n\n' +
      `**Deadline:** <t:${Math.floor(deadline / 1000)}:F>\n\n` +
      'This is a mandatory weekly activity check.',
    allowedMentions: { roles: [trustedRole.id] },
  });

  await message.react(TRUSTED_CHECK_EMOJI);

  trustedCheckDB.activeCheck = {
    messageId: message.id,
    channelId: channel.id,
    startedAt,
    deadline,
    memberIds,
  };
  trustedCheckDB.nextRunAt = startedAt + randomTrustedCheckDelay();
  await saveTrustedCheckDatabase();

  console.log(`Trusted check posted for ${memberIds.length} members.`);
  return true;
}

async function fetchTrustedReactors(message) {
  const reaction = message.reactions.resolve(TRUSTED_CHECK_EMOJI);
  if (!reaction) return new Set();

  const reactors = new Set();
  let after;

  while (true) {
    const batch = await reaction.users.fetch({
      limit: 100,
      ...(after ? { after } : {}),
    });
    if (batch.size === 0) break;

    for (const user of batch.values()) {
      if (!user.bot) reactors.add(user.id);
    }

    if (batch.size < 100) break;
    after = batch.last().id;
  }

  return reactors;
}

async function finishTrustedCheck(guild) {
  const check = trustedCheckDB.activeCheck;
  if (!check || Date.now() < check.deadline) return;

  const channel = await guild.channels.fetch(check.channelId).catch(() => null);
  const message = channel?.messages
    ? await channel.messages.fetch(check.messageId).catch(() => null)
    : null;

  // Never remove roles if the original message cannot be verified.
  if (!message) {
    console.error('Trusted check message unavailable; postponing the check by five minutes.');
    check.deadline = Date.now() + 5 * 60 * 1000;
    await saveTrustedCheckDatabase();
    return;
  }

  const reactors = await fetchTrustedReactors(message);
  const trustedRole = await guild.roles.fetch(TRUSTED_ROLE_ID);
  const botMember = await guild.members.fetchMe();

  if (!trustedRole || !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      botMember.roles.highest.comparePositionTo(trustedRole) <= 0) {
    throw new Error('Cannot safely remove Trusted: check role configuration and permissions.');
  }

  let retained = 0;
  let removed = 0;
  let failed = 0;

  for (const userId of check.memberIds) {
    if (reactors.has(userId)) {
      retained++;
      continue;
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || !member.roles.cache.has(TRUSTED_ROLE_ID)) continue;

    try {
      await member.roles.remove(trustedRole, 'Did not react to the weekly Trusted role check within 24 hours');
      removed++;
      await member.send(
        'Your **Trusted** role has been removed because you did not react to the weekly Mirage Trusted role check within 24 hours.'
      ).catch(() => {});
    } catch (error) {
      failed++;
      console.error(`Could not remove Trusted from ${userId}:`, error);
    }
  }

  await message.reply({
    content:
      '**MIRAGE | TRUSTED ROLE CHECK COMPLETED**\n\n' +
      `Members who kept Trusted: **${retained}**\n` +
      `Trusted roles removed: **${removed}**` +
      (failed ? `\nMembers needing manual review: **${failed}**` : ''),
    allowedMentions: { parse: [] },
  }).catch(() => {});

  trustedCheckDB.activeCheck = null;
  await saveTrustedCheckDatabase();
  console.log(`Trusted check completed: ${retained} retained, ${removed} removed, ${failed} failed.`);
}

async function runTrustedCheckScheduler() {
  if (trustedCheckRunning) return;
  trustedCheckRunning = true;

  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    if (trustedCheckDB.activeCheck) {
      await finishTrustedCheck(guild);
      return;
    }

    if (!trustedCheckDB.nextRunAt) {
      // First check is scheduled randomly within the next seven days.
      trustedCheckDB.nextRunAt = Date.now() + Math.floor(Math.random() * TRUSTED_CHECK_INTERVAL);
      await saveTrustedCheckDatabase();
      console.log(`First Trusted check scheduled for ${new Date(trustedCheckDB.nextRunAt).toISOString()}.`);
      return;
    }

    if (Date.now() >= trustedCheckDB.nextRunAt) {
      await postTrustedCheck(guild);
    }
  } catch (error) {
    console.error('Trusted role check scheduler error:', error);
  } finally {
    trustedCheckRunning = false;
  }
}

async function startTrustedChecks() {
  if (!TRUSTED_CHECK_CHANNEL_ID) {
    console.warn('Weekly Trusted checks are disabled: TRUSTED_CHECK_CHANNEL_ID is not set.');
    return;
  }

  await runTrustedCheckScheduler();
  if (trustedCheckTimer) clearInterval(trustedCheckTimer);
  trustedCheckTimer = setInterval(runTrustedCheckScheduler, 30 * 1000);
  console.log('Weekly Trusted role checks are active.');
}

// ========================================
// REGISTER SLASH COMMANDS
// ========================================

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log(
    'Registered commands: /verify-panel, /link, /verify-status, ' +
    '/handbook-status, /handbook-resend, /trusted-check, /ban-notice'
  );
}

// ========================================
// BOT READY
// ========================================

client.once('ready', async () => {
  console.log(`Mirage Bot online as ${client.user.tag}`);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    await reconcileModerators(guild);
    await startTrustedChecks();

    if (deadlineTimer) clearInterval(deadlineTimer);

    deadlineTimer = setInterval(() => {
      checkHandbookDeadlines().catch(error => {
        console.error('Handbook deadline checker failed:', error);
      });
    }, 30 * 1000);

    console.log('Moderator handbook system is active.');
  } catch (error) {
    console.error('Could not initialise the handbook system:', error);
  }
});

// ========================================
// DETECT MODERATOR ROLE ASSIGNMENTS
// ========================================

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const hadModerator = oldMember.roles.cache.has(MODERATOR_ROLE_ID);
    const hasModeratorNow = newMember.roles.cache.has(MODERATOR_ROLE_ID);

    if (!hasModeratorNow) return;

    // A newly assigned Moderator role requires acceptance.
    // A current acceptance prevents the bot from removing the role.
    if (
      !hadModerator ||
      !hasAcceptedCurrentHandbook(newMember.id)
    ) {
      await beginHandbookAgreement(newMember);
    }
  } catch (error) {
    console.error(
      `Moderator role update failed for ${newMember.user.tag}:`,
      error
    );
  }
});

// ========================================
// INTERACTIONS
// ========================================

client.on('interactionCreate', async interaction => {
  try {
    // ------------------------------------
    // HANDBOOK ACCEPT / DECLINE BUTTONS
    // ------------------------------------

    if (
      interaction.isButton() &&
      [
        'mirage_handbook_accept',
        'mirage_handbook_decline',
      ].includes(interaction.customId)
    ) {
      if (interaction.inGuild()) {
        return interaction.reply({
          content: 'Please use the handbook buttons in your direct messages.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const record = handbookDB.records[interaction.user.id];

      if (
        !record ||
        record.status !== 'pending' ||
        record.version !== HANDBOOK_VERSION
      ) {
        return interaction.editReply(
          'You do not have a pending agreement for the current handbook. ' +
          'Contact server management if you believe this is incorrect.'
        );
      }

      if (record.deadline <= Date.now()) {
        record.status = 'expired';
        record.expiredAt = new Date().toISOString();
        await saveHandbookDatabase();

        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members
          .fetch(interaction.user.id)
          .catch(() => null);

        if (member) {
          await setPending(member);
          await clearPendingRole(member);
        }

        return interaction.editReply(
          'Your handbook acceptance deadline has passed. ' +
          'Contact server management for assistance.'
        );
      }

      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members
        .fetch(interaction.user.id)
        .catch(() => null);

      if (!member) {
        return interaction.editReply(
          'You are no longer a member of the Mirage server.'
        );
      }

      if (interaction.customId === 'mirage_handbook_decline') {
        await setPending(member);
        await clearPendingRole(member);

        record.status = 'declined';
        record.declinedAt = new Date().toISOString();

        await saveHandbookDatabase();

        return interaction.editReply(
          'You declined the Moderator Handbook. Your Moderator access ' +
          'will remain disabled. Contact server management if you wish ' +
          'to discuss this decision.'
        );
      }

      // Save acceptance before restoring the Moderator role so the
      // role-update listener recognises this as an accepted member.
      record.status = 'accepted';
      record.acceptedAt = new Date().toISOString();

      await saveHandbookDatabase();

      try {
        const moderatorRole = await getModeratorRole(guild);

        await member.roles.add(
          moderatorRole,
          `Accepted Moderator Handbook version ${HANDBOOK_VERSION}`
        );

        await clearPendingRole(member);

        return interaction.editReply(
          `You have accepted the Mirage Moderator Handbook, version ` +
          `**${HANDBOOK_VERSION}**. Your Moderator role has been restored.`
        );
      } catch (error) {
        record.status = 'pending';
        record.acceptedAt = null;
        await saveHandbookDatabase();

        console.error('Could not restore Moderator role:', error);

        return interaction.editReply(
          'Your acceptance could not be completed because the bot could ' +
          'not restore your Moderator role. Please contact server management.'
        );
      }
    }

    // ------------------------------------
    // VERIFICATION BUTTON
    // ------------------------------------

    if (
      interaction.isButton() &&
      interaction.customId === 'mirage_get_verification_code'
    ) {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: 'Use this button in the Mirage Discord server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const member = await getMember(interaction);

      if (!hasTrusted(member)) {
        return interaction.reply({
          content: 'You need the **Trusted** role before you can verify.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (hasVerified(member)) {
        return interaction.reply({
          content: 'You already have the **Verified** role.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const now = Date.now();
      const existing = db.codes[interaction.user.id];

      if (
        existing &&
        existing.expiresAt > now &&
        existing.cooldownUntil > now &&
        existing.attempts < MAX_ATTEMPTS
      ) {
        const remaining = Math.ceil(
          (existing.cooldownUntil - now) / 1000
        );

        return interaction.reply({
          content: `Please wait ${remaining} seconds before requesting another code.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const code = generateCode();

      db.codes[interaction.user.id] = {
        hash: hashCode(code),
        expiresAt: now + CODE_LIFETIME,
        cooldownUntil: now + CODE_COOLDOWN,
        attempts: 0,
      };

      await saveDatabase();

      return interaction.reply({
        content:
          `Your verification code is **${code}**\n\n` +
          'Run `/link` and enter this code. It expires in five minutes ' +
          'and can only be used once. Do not share it.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!interaction.isChatInputCommand()) return;

    // ------------------------------------
    // /TRUSTED-CHECK
    // ------------------------------------

    if (interaction.commandName === 'trusted-check') {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: 'Use this command in the Mirage server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need **Manage Server** permission to start a Trusted check.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!TRUSTED_CHECK_CHANNEL_ID) {
        return interaction.reply({
          content: 'The Trusted check channel has not been configured. Set TRUSTED_CHECK_CHANNEL_ID in your environment variables.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (trustedCheckDB.activeCheck) {
        return interaction.reply({
          content: 'A Trusted role check is already active. Members must complete the current check before another can begin.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (trustedCheckRunning) {
        return interaction.reply({
          content: 'The Trusted check scheduler is currently processing. Please try again shortly.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      trustedCheckRunning = true;

      try {
        const posted = await postTrustedCheck(interaction.guild);

        if (posted === false) {
          return interaction.editReply('There are currently no members with the Trusted role, so no check was posted.');
        }

        return interaction.editReply('A Trusted role check has been posted. Members have 24 hours to react with ✅.');
      } catch (error) {
        console.error('Manual Trusted check failed:', error);
        return interaction.editReply('The Trusted role check could not be started. Check the bot console for details.');
      } finally {
        trustedCheckRunning = false;
      }
    }

    // ------------------------------------
    // /BAN-NOTICE
    // ------------------------------------

    if (interaction.commandName === 'ban-notice') {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: 'Use this command in the Mirage server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need **Manage Server** permission to send a removal notice.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const userId = interaction.options.getString('user-id', true).trim();
      const displayName = interaction.options.getString('name', true).trim();

      if (!/^\\d{17,20}$/.test(userId)) {
        return interaction.reply({
          content: 'That does not appear to be a valid Discord user ID.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        // Fetch by ID so the command also works after the recipient has been banned.
        const targetUser = await client.users.fetch(userId);

        const notice = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('MIRAGE | MEMBERSHIP TERMINATION')
          .setDescription(
            `Hello **${displayName}**,\n\n` +
            'I am contacting you to formally inform you that, following a review ' +
            'of evidence provided to Mirage Administration, your membership within ' +
            'Mirage has been permanently terminated.\n\n' +
            'Evidence was provided and subsequently verified showing that you shared ' +
            'Nazi-related material. Having considered the circumstances and the context ' +
            'surrounding the incident, we have determined that your actions are incompatible ' +
            'with the standards and regulations upheld by Mirage.\n\n' +
            'Although the incident did not take place within the Mirage server itself, ' +
            'your position as both a Builder and Trusted member means that your conduct ' +
            'and the expectations associated with those positions are taken seriously.\n\n' +
            'This decision has not been made lightly. However, Mirage maintains a strict ' +
            'position regarding extremist and discriminatory material, and we are not ' +
            'prepared to make exceptions where such conduct has been established.\n\n' +
            'Your removal is effective immediately. We wish you the best going forward.'
          )
          .setFooter({ text: 'Mirage Administration' })
          .setTimestamp();

        await targetUser.send({
          embeds: [notice],
          allowedMentions: { parse: [] },
        });

        console.log(
          `Ban notice sent to user ${userId} by ${interaction.user.tag}.`
        );

        return interaction.editReply(
          `The formal Mirage removal notice was successfully sent to **${displayName}**.`
        );
      } catch (error) {
        console.error(`Could not send ban notice to ${userId}:`, error);

        return interaction.editReply(
          'The notice could not be delivered. The user ID may be incorrect, ' +
          'or the recipient may have direct messages disabled.'
        );
      }
    }

    // ------------------------------------
    // /VERIFY-PANEL
    // ------------------------------------

    if (interaction.commandName === 'verify-panel') {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: 'Use this command in the Mirage server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (
        !interaction.memberPermissions?.has(
          PermissionFlagsBits.ManageGuild
        )
      ) {
        return interaction.reply({
          content: 'You need **Manage Server** permission to post the panel.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const channel = LINK_CHANNEL_ID
        ? await interaction.guild.channels
            .fetch(LINK_CHANNEL_ID)
            .catch(() => null)
        : interaction.channel;

      if (!channel?.isTextBased() || !channel.send) {
        return interaction.reply({
          content: 'Could not find the configured verification channel. Check LINK_CHANNEL_ID in .env.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await channel.send({
        content:
          '**MIRAGE | DISCORD VERIFICATION**\n\n' +
          'You must already have the **Trusted** role to receive Verified.\n\n' +
          'Click the button below to receive a private one-time code, ' +
          'then run `/link` with that code.',
        components: [verificationPanel],
      });

      return interaction.reply({
        content: `Verification panel posted in ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ------------------------------------
    // /HANDBOOK-STATUS
    // ------------------------------------

    if (interaction.commandName === 'handbook-status') {
      const record = handbookDB.records[interaction.user.id];

      if (!record) {
        return interaction.reply({
          content:
            'You do not have a recorded Moderator Handbook agreement.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const statusText = {
        accepted: 'Accepted',
        pending: 'Awaiting your response',
        declined: 'Declined',
        expired: 'Expired',
      }[record.status] || 'Unknown';

      return interaction.reply({
        content:
          `**Handbook status:** ${statusText}\n` +
          `**Version:** ${record.version}\n` +
          (
            record.status === 'pending'
              ? `**Deadline:** <t:${Math.floor(record.deadline / 1000)}:F>`
              : record.acceptedAt
                ? `**Accepted:** <t:${Math.floor(Date.parse(record.acceptedAt) / 1000)}:F>`
                : ''
          ),
        flags: MessageFlags.Ephemeral,
      });
    }

    // ------------------------------------
    // /HANDBOOK-RESEND
    // ------------------------------------

    if (interaction.commandName === 'handbook-resend') {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: 'Use this command in the Mirage server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (
        !interaction.memberPermissions?.has(
          PermissionFlagsBits.ManageGuild
        )
      ) {
        return interaction.reply({
          content: 'You need **Manage Server** permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const targetUser = interaction.options.getUser('member', true);
      const targetMember = await interaction.guild.members
        .fetch(targetUser.id)
        .catch(() => null);

      if (!targetMember) {
        return interaction.reply({
          content: 'That member is not in the Mirage server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const record = handbookDB.records[targetUser.id];

      if (
        record &&
        record.status === 'accepted' &&
        record.version === HANDBOOK_VERSION
      ) {
        return interaction.reply({
          content: 'That member has already accepted the current handbook.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await beginHandbookAgreement(targetMember, true);

      return interaction.reply({
        content: `The handbook agreement has been sent to ${targetUser}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Remaining commands must be used in the server.
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: 'Use this command in the Mirage server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const member = await getMember(interaction);

    // ------------------------------------
    // /VERIFY-STATUS
    // ------------------------------------

    if (interaction.commandName === 'verify-status') {
      if (hasVerified(member)) {
        return interaction.reply({
          content: 'Your status is **Verified**.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!hasTrusted(member)) {
        return interaction.reply({
          content: 'You are not eligible yet. You need the Trusted role first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      return interaction.reply({
        content: 'You have Trusted but are not Verified. Use the verification panel to continue.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // ------------------------------------
    // /LINK
    // ------------------------------------

    if (interaction.commandName !== 'link') return;

    if (!hasTrusted(member)) {
      return interaction.reply({
        content: 'You need the **Trusted** role before you can verify.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (hasVerified(member)) {
      return interaction.reply({
        content: 'You already have the **Verified** role.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const code = interaction.options
      .getString('code', true)
      .trim()
      .toUpperCase();

    const entry = db.codes[interaction.user.id];

    if (!entry || entry.expiresAt <= Date.now()) {
      delete db.codes[interaction.user.id];
      await saveDatabase();

      return interaction.reply({
        content: 'Your code is missing or expired. Request a new one.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (entry.attempts >= MAX_ATTEMPTS) {
      delete db.codes[interaction.user.id];
      await saveDatabase();

      return interaction.reply({
        content: 'Too many incorrect attempts. Request a new code.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (hashCode(code) !== entry.hash) {
      entry.attempts += 1;

      if (entry.attempts >= MAX_ATTEMPTS) {
        delete db.codes[interaction.user.id];
      }

      await saveDatabase();

      return interaction.reply({
        content:
          'Incorrect code. ' +
          `${Math.max(0, MAX_ATTEMPTS - entry.attempts)} attempts remaining.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let verifiedRole;

    try {
      verifiedRole = await getVerifiedRole(interaction.guild);
    } catch (error) {
      console.error('Role configuration error:', error);

      return interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
    }

    await member.roles.add(
      verifiedRole,
      'Trusted member completed Mirage Discord verification'
    );

    delete db.codes[interaction.user.id];

    db.records[interaction.user.id] = {
      verifiedAt: new Date().toISOString(),
      method: 'discord-one-time-code',
    };

    await saveDatabase();

    return interaction.reply({
      content:
        'You have successfully received the **Verified** role!\n\n' +
        'This verifies your Discord account eligibility only.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error('Interaction error:', error);

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content: 'An error occurred. Please try again or contact a moderator.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } else if (
      interaction.isRepliable() &&
      interaction.deferred
    ) {
      await interaction.editReply(
        'An error occurred. Please contact server management.'
      ).catch(() => {});
    }
  }
});

// ========================================
// START BOT
// ========================================

(async () => {
  try {
    console.log('[startup] Loading verification database...');
    await loadDatabase();
    logMemory('after verification database');

    console.log('[startup] Loading handbook database...');
    await loadHandbookDatabase();
    logMemory('after handbook database');

    console.log('[startup] Loading Trusted-check database...');
    await loadTrustedCheckDatabase();
    logMemory('after Trusted-check database');

    console.log('[startup] Registering Discord slash commands...');
    await registerCommands();
    logMemory('after command registration');

    console.log('[startup] Connecting to Discord gateway...');
    await client.login(DISCORD_TOKEN);
    console.log('[startup] Discord login request completed.');
    logMemory('after Discord login');
  } catch (error) {
    console.error('[startup] Failed to start Mirage Bot:', error);
    process.exit(1);
  }
})();
