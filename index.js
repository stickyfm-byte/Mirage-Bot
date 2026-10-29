
require('dotenv').config();

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

let db = {
  codes: {},
  records: {},
};

let handbookDB = {
  records: {},
};

let verificationSaveQueue = Promise.resolve();
let handbookSaveQueue = Promise.resolve();
let deadlineTimer = null;

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
  await guild.members.fetch();

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
    '/handbook-status, /handbook-resend'
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
    await loadDatabase();
    await loadHandbookDatabase();
    await registerCommands();
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    console.error('Failed to start Mirage Bot:', error);
    process.exit(1);
  }
})();
