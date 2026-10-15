
require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

// ================================
// CONFIGURATION
// ================================

const REQUIRED = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'TRUSTED_ROLE_ID',
  'VERIFIED_ROLE_ID',
];

for (const key of REQUIRED) {
  if (!process.env[key]?.trim()) {
    console.error(`Missing ${key} in your .env file.`);
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
} = process.env;

const CODE_LIFETIME = 5 * 60 * 1000;
const CODE_COOLDOWN = 30 * 1000;
const MAX_ATTEMPTS = 5;

const DATA_DIR = path.join(__dirname, 'data');
const DATABASE = path.join(DATA_DIR, 'verification.json');

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

let saveQueue = Promise.resolve();

// ================================
// SLASH COMMANDS
// ================================

const commands = [
  new SlashCommandBuilder()
    .setName('verify-panel')
    .setDescription('Post the Mirage verification panel.')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    ),

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
].map(command => command.toJSON());

// ================================
// DATABASE
// ================================

async function loadDatabase() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(DATABASE, 'utf8');
    const parsed = JSON.parse(raw);

    db = {
      codes: parsed.codes || {},
      records: parsed.records || {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveDatabase();
  }
}

async function saveDatabase() {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });

    const temp = `${DATABASE}.tmp`;

    await fs.writeFile(
      temp,
      JSON.stringify(db, null, 2),
      { mode: 0o600 }
    );

    await fs.rename(temp, DATABASE);
  });

  return saveQueue;
}

// ================================
// VERIFICATION CODES
// ================================

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

// ================================
// ROLE PERMISSIONS
// ================================

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

async function getMember(interaction) {
  return interaction.guild.members.fetch(interaction.user.id);
}

function hasTrusted(member) {
  return member.roles.cache.has(TRUSTED_ROLE_ID);
}

function hasVerified(member) {
  return member.roles.cache.has(VERIFIED_ROLE_ID);
}

// ================================
// VERIFICATION PANEL
// ================================

const panel = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId('mirage_get_verification_code')
    .setLabel('Get verification code')
    .setStyle(ButtonStyle.Primary)
);

// ================================
// REGISTER COMMANDS
// ================================

async function registerCommands() {
  const rest = new REST({ version: '10' })
    .setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log(
    'Registered commands: /verify-panel, /link, /verify-status'
  );
}

// ================================
// BOT READY
// ================================

client.once('ready', () => {
  console.log(`Mirage Bot online as ${client.user.tag}`);
});

// ================================
// INTERACTIONS
// ================================

client.on('interactionCreate', async interaction => {
  try {
    // ----- Verification button -----

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
          'Run `/link` and enter this code. It expires in five minutes and can only be used once. Do not share it.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!interaction.isChatInputCommand()) return;

    // ----- /verify-panel -----

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
          'Click the button below to receive a private one-time code, then run `/link` with that code.',
        components: [panel],
      });

      return interaction.reply({
        content: `Verification panel posted in ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Remaining commands must be used in the server
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: 'Use this command in the Mirage Discord server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const member = await getMember(interaction);

    // ----- /verify-status -----

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

    // ----- /link -----

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
          `Incorrect code. ` +
          `${Math.max(0, MAX_ATTEMPTS - entry.attempts)} attempts remaining.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Validate bot role permissions before assigning Verified
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
    }
  }
});

// ================================
// START BOT
// ================================

(async () => {
  try {
    await loadDatabase();
    await registerCommands();
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    console.error('Failed to start Mirage Bot:', error);
    process.exit(1);
  }
})();
