
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");

const CONFIG = {
  guildId: process.env.GUILD_ID,
  moderatorRoleId: process.env.MODERATOR_ROLE_ID,
  pendingRoleId: process.env.MODERATOR_PENDING_ROLE_ID || "",
  channelId: process.env.HANDBOOK_CHANNEL_ID,
  version: process.env.HANDBOOK_VERSION || "1.1",
  deadlineHours: Number(process.env.HANDBOOK_DEADLINE_HOURS || 24),
};

const DB_PATH = path.join(__dirname, "data", "handbook.json");
const DEADLINE_MS = CONFIG.deadlineHours * 60 * 60 * 1000;

let records = {};
let saveQueue = Promise.resolve();

async function loadDB() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });

  try {
    records = JSON.parse(await fs.readFile(DB_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    records = {};
    await saveDB();
  }

  if (!records || typeof records !== "object" || Array.isArray(records)) {
    records = {};
  }
}

async function saveDB() {
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });

    const temp = `${DB_PATH}.tmp`;
    await fs.writeFile(temp, JSON.stringify(records, null, 2));
    await fs.rename(temp, DB_PATH);
  });

  return saveQueue;
}

function currentAcceptance(userId) {
  const record = records[userId];

  return Boolean(
    record &&
    record.status === "accepted" &&
    record.version === CONFIG.version &&
    record.acceptedAt
  );
}

function buttons(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`handbook:accept:${userId}`)
      .setLabel("I Agree")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`handbook:decline:${userId}`)
      .setLabel("I Do Not Agree")
      .setStyle(ButtonStyle.Danger)
  );
}

function agreementEmbed(record) {
  const timestamp = Math.floor(record.deadlineAt / 1000);

  return new EmbedBuilder()
    .setColor(0x4A90E2)
    .setTitle("Mirage Moderator Staff Handbook")
    .setDescription(
      `Before receiving or retaining Moderator permissions, ` +
      `you must read and agree to the current handbook.\n\n` +
      `**Version:** ${CONFIG.version}\n` +
      `**Read the handbook:** <#${CONFIG.channelId}>\n` +
      `**Deadline:** <t:${timestamp}:F> (<t:${timestamp}:R>)\n\n` +
      `By selecting **I Agree**, you confirm that you have read ` +
      `the handbook and agree to follow its policies and procedures.\n\n` +
      `If you decline or miss the deadline, you will not retain ` +
      `Moderator access. Contact a Senior Moderator, Administrator, ` +
      `or Senior Administrator if you have questions.`
    );
}

async function getRole(guild, roleId, label) {
  const role = await guild.roles.fetch(roleId);

  if (!role) {
    throw new Error(`${label} role not found. Check your role ID.`);
  }

  const botMember = await guild.members.fetchMe();

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("The bot needs Manage Roles permission.");
  }

  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error(
      `Move the bot's highest role above ${label} in Server Settings > Roles.`
    );
  }

  return role;
}

async function setPending(member, reason) {
  const moderatorRole = await getRole(
    member.guild,
    CONFIG.moderatorRoleId,
    "Moderator"
  );

  // Remove moderation access first.
  if (member.roles.cache.has(moderatorRole.id)) {
    await member.roles.remove(moderatorRole, reason);
  }

  if (CONFIG.pendingRoleId) {
    const pendingRole = await getRole(
      member.guild,
      CONFIG.pendingRoleId,
      "Moderator Pending"
    );

    if (!member.roles.cache.has(pendingRole.id)) {
      await member.roles.add(pendingRole, reason);
    }
  }
}

async function clearPendingRole(member) {
  if (!CONFIG.pendingRoleId) return;

  const pendingRole = await getRole(
    member.guild,
    CONFIG.pendingRoleId,
    "Moderator Pending"
  );

  if (member.roles.cache.has(pendingRole.id)) {
    await member.roles.remove(pendingRole, "Handbook decision recorded");
  }
}

async function notifyStaff(guild, message) {
  const channel = await guild.channels.fetch(CONFIG.channelId).catch(() => null);

  if (channel?.isTextBased()) {
    await channel.send(message).catch(console.error);
  }
}

async function sendAgreement(member) {
  const record = records[member.id];

  await member.send({
    embeds: [agreementEmbed(record)],
    components: [buttons(member.id)],
  });
}

async function beginAgreement(member, reset = false) {
  if (member.guild.id !== CONFIG.guildId || member.user.bot) return;

  if (!reset && currentAcceptance(member.id)) return;

  const existing = records[member.id];

  // Do not restart the 24-hour timer on repeated role events.
  if (
    !reset &&
    existing?.status === "pending" &&
    existing.version === CONFIG.version &&
    existing.deadlineAt > Date.now()
  ) {
    await setPending(member, "Handbook agreement still pending");
    return;
  }

  const now = Date.now();

  records[member.id] = {
    version: CONFIG.version,
    status: "pending",
    assignedAt: now,
    deadlineAt: now + DEADLINE_MS,
    acceptedAt: null,
  };

  await saveDB();

  // Always remove Moderator before attempting to DM.
  await setPending(member, "Handbook agreement required");

  try {
    await sendAgreement(member);
  } catch (error) {
    console.error("Could not DM handbook agreement:", error);

    await notifyStaff(
      member.guild,
      `I could not DM the handbook agreement to <@${member.id}>. ` +
      `Their Moderator access has been removed. Ask them to enable DMs, ` +
      `then use /handbook-resend.`
    );
  }
}

async function expireAgreement(guild, userId, record) {
  const member = await guild.members.fetch(userId).catch(() => null);

  if (member) {
    await setPending(member, "Handbook deadline expired");
    await clearPendingRole(member);
    await member.send(
      "Your deadline to accept the Mirage Moderator Staff Handbook has expired. " +
      "Your Moderator access remains removed. Contact senior staff if you believe this is an error."
    ).catch(() => {});
  }

  record.status = "expired";
  record.expiredAt = Date.now();
  await saveDB();
}

async function checkDeadlines() {
  const guild = await client.guilds.fetch(CONFIG.guildId).catch(() => null);
  if (!guild) return;

  for (const [userId, record] of Object.entries(records)) {
    if (
      record.status !== "pending" ||
      record.version !== CONFIG.version ||
      Date.now() < record.deadlineAt
    ) continue;

    try {
      await expireAgreement(guild, userId, record);
    } catch (error) {
      console.error(`Could not expire handbook agreement for ${userId}:`, error);
      await notifyStaff(
        guild,
        `Handbook enforcement failed for <@${userId}>. Check the bot's role hierarchy and permissions.`
      );
    }
  }
}

const handbookCommands = [
  new SlashCommandBuilder()
    .setName("handbook-status")
    .setDescription("Check a member's handbook agreement.")
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member to check")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("handbook-resend")
    .setDescription("Resend a pending handbook agreement.")
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member to contact")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(command => command.toJSON());

let client;

function registerHandbook(clientInstance) {
  client = clientInstance;

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (newMember.guild.id !== CONFIG.guildId) return;

    const hadRole = oldMember.roles.cache.has(CONFIG.moderatorRoleId);
    const hasRole = newMember.roles.cache.has(CONFIG.moderatorRoleId);

    if (!hadRole && hasRole && !currentAcceptance(newMember.id)) {
      try {
        await beginAgreement(newMember);
      } catch (error) {
        console.error("Handbook enforcement error:", error);

        await notifyStaff(
          newMember.guild,
          `Could not enforce handbook acceptance for <@${newMember.id}>. ` +
          `Remove their Moderator role manually and check the bot's permissions.`
        );
      }
    }
  });

  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isButton() && interaction.customId.startsWith("handbook:")) {
        const [prefix, action, userId] = interaction.customId.split(":");

        if (interaction.user.id !== userId) {
          return interaction.reply({
            content: "This agreement belongs to another Discord account.",
            flags: MessageFlags.Ephemeral,
          });
        }

        const record = records[userId];

        if (
          !record ||
          record.status !== "pending" ||
          record.version !== CONFIG.version
        ) {
          return interaction.reply({
            content: "You have no pending agreement for the current handbook.",
            flags: MessageFlags.Ephemeral,
          });
        }

        if (Date.now() >= record.deadlineAt) {
          const guild = await client.guilds.fetch(CONFIG.guildId);
          await expireAgreement(guild, userId, record);

          return interaction.update({
            content: "Your agreement deadline has expired. Contact senior staff.",
            embeds: [],
            components: [],
          });
        }

        const guild = await client.guilds.fetch(CONFIG.guildId);
        const member = await guild.members.fetch(userId).catch(() => null);

        if (!member) {
          return interaction.reply({
            content: "You must be a member of Mirage to complete this agreement.",
            flags: MessageFlags.Ephemeral,
          });
        }

        if (action === "decline") {
          record.status = "declined";
          record.declinedAt = Date.now();
          await saveDB();

          await setPending(member, "Handbook agreement declined");
          await clearPendingRole(member);

          return interaction.update({
            content: "You declined the handbook. Moderator access has been removed.",
            embeds: [],
            components: [],
          });
        }

        if (action !== "accept") return;

        // Save first so the role-update listener recognises acceptance.
        record.status = "accepted";
        record.acceptedAt = Date.now();
        await saveDB();

        try {
          const role = await getRole(guild, CONFIG.moderatorRoleId, "Moderator");
          await member.roles.add(role, `Accepted handbook v${CONFIG.version}`);
          await clearPendingRole(member);
        } catch (error) {
          record.status = "pending";
          record.acceptedAt = null;
          await saveDB();

          console.error("Could not grant Moderator role:", error);

          return interaction.reply({
            content: "Your acceptance could not be completed because of a role permission error. Contact senior staff.",
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.update({
          content: `Your acceptance of handbook v${CONFIG.version} has been recorded. Your Moderator role has been granted.`,
          embeds: [],
          components: [],
        });
      }

      if (!interaction.isChatInputCommand()) return;
      if (!interaction.inGuild() || interaction.guildId !== CONFIG.guildId) return;

      if (interaction.commandName === "handbook-status") {
        const target = interaction.options.getUser("member") || interaction.user;
        const record = records[target.id];

        if (!record) {
          return interaction.reply({
            content: `No handbook agreement record found for ${target.tag}.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content:
            `**Member:** ${target.tag}\n` +
            `**Status:** ${record.status}\n` +
            `**Version:** ${record.version}\n` +
            `**Accepted:** ${record.acceptedAt ? `<t:${Math.floor(record.acceptedAt / 1000)}:F>` : "Not recorded"}\n` +
            `**Deadline:** <t:${Math.floor(record.deadlineAt / 1000)}:F>`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === "handbook-resend") {
        const target = interaction.options.getUser("member", true);
        const record = records[target.id];

        if (
          !record ||
          record.status !== "pending" ||
          record.version !== CONFIG.version
        ) {
          return interaction.reply({
            content: "That member has no pending agreement for the current handbook.",
            flags: MessageFlags.Ephemeral,
          });
        }

        if (Date.now() >= record.deadlineAt) {
          await expireAgreement(interaction.guild, target.id, record);

          return interaction.reply({
            content: "That member's agreement deadline has expired.",
            flags: MessageFlags.Ephemeral,
          });
        }

        const member = await interaction.guild.members.fetch(target.id).catch(() => null);

        if (!member) {
          return interaction.reply({
            content: "That user is not currently in Mirage.",
            flags: MessageFlags.Ephemeral,
          });
        }

        await sendAgreement(member);

        return interaction.reply({
          content: `Resent the agreement to ${target.tag}. The original deadline has not changed.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      console.error("Handbook interaction error:", error);

      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "An error occurred. Check the bot console or contact senior staff.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
    }
  });

  client.once(Events.ClientReady, async () => {
    try {
      await loadDB();

      const guild = await client.guilds.fetch(CONFIG.guildId);
      const members = await guild.members.fetch();

      // Reconcile moderators who were assigned while the bot was offline.
      for (const member of members.values()) {
        if (member.user.bot) continue;

        if (
          member.roles.cache.has(CONFIG.moderatorRoleId) &&
          !currentAcceptance(member.id)
        ) {
          await beginAgreement(member).catch(async error => {
            console.error("Startup reconciliation error:", error);
            await notifyStaff(guild, `Could not enforce handbook acceptance for <@${member.id}>.`);
          });
        }
      }

      await checkDeadlines();
      setInterval(() => {
        checkDeadlines().catch(console.error);
      }, 30_000);

      console.log("Mirage handbook acceptance system is active.");
    } catch (error) {
      console.error("Could not initialise handbook acceptance:", error);
    }
  });
}

module.exports = {
  registerHandbook,
  handbookCommands,
};
