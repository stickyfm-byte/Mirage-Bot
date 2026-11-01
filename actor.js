const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events,
  PermissionFlagsBits, SlashCommandBuilder, MessageFlags,
} = require("discord.js");
const fs = require("node:fs/promises");
const path = require("node:path");

const CONFIG = {
  guildId: process.env.GUILD_ID,
  actorRoleId: process.env.ACTOR_ROLE_ID || "",
  version: process.env.ACTOR_AGREEMENT_VERSION || "1.0",
  eulaUrl: "https://docs.google.com/document/d/1x1YsOs-Nk7RXeh9mAdWeeFnTPjYznqmlnn-vRT_WHxM/edit",
  regulationsUrl: "https://docs.google.com/document/d/1cX0b4oiThucX00KVYpucKVVnHigPYfWNfhrKTy0k1qw/edit",
};

const DB_PATH = path.join(__dirname, "data", "actor-agreement.json");
let records = {};
let saveQueue = Promise.resolve();
let client;

async function loadDB() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  try {
    records = JSON.parse(await fs.readFile(DB_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    records = {};
    await saveDB();
  }
  if (!records || typeof records !== "object" || Array.isArray(records)) records = {};
}

async function saveDB() {
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    const temp = DB_PATH + ".tmp";
    await fs.writeFile(temp, JSON.stringify(records, null, 2), { mode: 0o600 });
    await fs.rename(temp, DB_PATH);
  });
  return saveQueue;
}

function hasCurrentAcceptance(userId) {
  const record = records[userId];
  return Boolean(record && record.status === "accepted" &&
    record.version === CONFIG.version && record.acceptedAt);
}

async function getActorRole(guild) {
  if (!CONFIG.actorRoleId) throw new Error("ACTOR_ROLE_ID is not configured.");
  const role = await guild.roles.fetch(CONFIG.actorRoleId);
  if (!role) throw new Error("The configured Actor role could not be found. Check ACTOR_ROLE_ID.");
  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("The bot needs the Manage Roles permission.");
  }
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error("Move the bot's highest role above Actor in Server Settings > Roles.");
  }
  return role;
}

async function removeActorRole(member, reason) {
  const role = await getActorRole(member.guild);
  if (member.roles.cache.has(role.id)) await member.roles.remove(role, reason);
}

function agreementButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mirage_actor_agree").setLabel("I Agree").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mirage_actor_disagree").setLabel("I Disagree").setStyle(ButtonStyle.Danger)
  )];
}

function agreementEmbed() {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("MIRAGE | ACTOR AGREEMENT")
    .setDescription(
      "You have been assigned the **Actor** role in Mirage. Before your role can be activated, you must read and respond to both documents below.\\n\\n" +
      "📄 **[Actor End User Licence Agreement](" + CONFIG.eulaUrl + ")**\\n" +
      "📘 **[Actor Regulations & Code of Conduct](" + CONFIG.regulationsUrl + ")**\\n\\n" +
      "**Please read both documents in full before responding.**\\n\\n" +
      "By selecting **I Agree**, you confirm that you have read, understood and agree to follow both documents. Your Actor role will then be restored.\\n\\n" +
      "If you select **I Disagree**, your Actor role will remain removed and you will not be able to accept again unless an administrator re-enables the agreement for you.\\n\\n" +
      "**Minimum age:** 14+\\n**Agreement version:** " + CONFIG.version
    )
    .setFooter({ text: "Mirage • Actor participation requires agreement" })
    .setTimestamp();
}

async function sendAgreement(member) {
  await member.send({ embeds: [agreementEmbed()], components: agreementButtons() });
}

async function startAgreement(member, { force = false } = {}) {
  if (!CONFIG.actorRoleId || member.user.bot || member.guild.id !== CONFIG.guildId) return;
  const existing = records[member.id];
  if (hasCurrentAcceptance(member.id)) return;

  if (existing?.status === "declined" && !force) {
    await removeActorRole(member, "Actor agreement was previously declined");
    await member.send("Your Actor agreement was previously declined. Your Actor role cannot be restored until a Mirage administrator re-enables the agreement.").catch(() => {});
    return;
  }

  if (existing?.status === "pending" && existing.version === CONFIG.version && !force) {
    await removeActorRole(member, "Actor agreement is awaiting a response");
    return;
  }

  records[member.id] = {
    status: "pending",
    version: CONFIG.version,
    assignedAt: Date.now(),
    acceptedAt: null,
    declinedAt: null,
    enabledBy: force ? (existing?.enabledBy || null) : null,
  };
  await saveDB();
  await removeActorRole(member, "Actor agreement acceptance required");

  try {
    await sendAgreement(member);
  } catch (error) {
    console.error("Could not DM Actor agreement to " + member.user.tag + ":", error);
    throw new Error("Agreement remains pending, but the member's DMs could not be delivered.");
  }
}

const actorCommands = [
  new SlashCommandBuilder()
    .setName("actor-agreement-status")
    .setDescription("Check your Actor agreement status, or an actor's status.")
    .addUserOption(option => option.setName("member").setDescription("Member to check (administrators only)").setRequired(false)),
  new SlashCommandBuilder()
    .setName("actor-agreement-resend")
    .setDescription("Resend a pending Actor agreement.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(option => option.setName("member").setDescription("Member who needs the agreement").setRequired(true)),
  new SlashCommandBuilder()
    .setName("actor-agreement-enable")
    .setDescription("Allow a member who declined to accept the Actor agreement again.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(option => option.setName("member").setDescription("Member whose agreement should be re-enabled").setRequired(true)),
];

function registerActor(clientInstance) {
  client = clientInstance;

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (!CONFIG.actorRoleId || newMember.guild.id !== CONFIG.guildId) return;
    const hadActor = oldMember.roles.cache.has(CONFIG.actorRoleId);
    const hasActor = newMember.roles.cache.has(CONFIG.actorRoleId);
    if (!hadActor && hasActor && !hasCurrentAcceptance(newMember.id)) {
      try {
        await startAgreement(newMember);
      } catch (error) {
        console.error("Actor agreement enforcement failed for " + newMember.user.tag + ":", error);
      }
    }
  });

  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isButton() &&
          ["mirage_actor_agree", "mirage_actor_disagree"].includes(interaction.customId)) {
        if (interaction.inGuild()) {
          return interaction.reply({ content: "Please use the Actor agreement buttons in your direct messages.", flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const record = records[interaction.user.id];
        if (!record || record.status !== "pending" || record.version !== CONFIG.version) {
          return interaction.editReply("You do not have a pending Actor agreement for the current version. Contact Mirage administration if you believe this is incorrect.");
        }

        const guild = await client.guilds.fetch(CONFIG.guildId);
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.editReply("You must be a member of Mirage to complete this agreement.");

        if (interaction.customId === "mirage_actor_disagree") {
          await removeActorRole(member, "Actor agreement declined");
          record.status = "declined";
          record.declinedAt = Date.now();
          record.declinedBy = interaction.user.id;
          await saveDB();
          return interaction.editReply("You have declined the Mirage Actor Agreement. Your Actor role will remain removed. You cannot accept again unless an administrator re-enables the agreement for you.");
        }

        record.status = "accepted";
        record.acceptedAt = Date.now();
        await saveDB();

        try {
          const role = await getActorRole(guild);
          await member.roles.add(role, "Accepted Mirage Actor Agreement v" + CONFIG.version);
        } catch (error) {
          record.status = "pending";
          record.acceptedAt = null;
          await saveDB();
          console.error("Could not restore Actor role:", error);
          return interaction.editReply("Your agreement was received, but the Actor role could not be restored. Contact Mirage administration.");
        }

        return interaction.editReply("Your acceptance of the Mirage Actor Agreement, version **" + CONFIG.version + "**, has been recorded. Your Actor role has been restored.");
      }

      if (!interaction.isChatInputCommand() || !interaction.inGuild() || interaction.guildId !== CONFIG.guildId) return;
      if (!interaction.commandName.startsWith("actor-agreement-")) return;

      const target = interaction.options.getUser("member") || interaction.user;
      const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

      if (target.id !== interaction.user.id && !isAdmin) {
        return interaction.reply({ content: "You need **Manage Server** permission to check another member's agreement.", flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === "actor-agreement-status") {
        const record = records[target.id];
        if (!record) return interaction.reply({ content: "No Actor agreement record exists for " + target.tag + ".", flags: MessageFlags.Ephemeral });

        const acceptedAt = record.acceptedAt ? "<t:" + Math.floor(record.acceptedAt / 1000) + ":F>" : "Not recorded";
        const declinedAt = record.declinedAt ? "<t:" + Math.floor(record.declinedAt / 1000) + ":F>" : "Not recorded";
        return interaction.reply({
          content: "**Member:** " + target.tag + "\\n**Status:** " + record.status + "\\n**Version:** " + record.version + "\\n**Accepted:** " + acceptedAt + "\\n**Declined:** " + declinedAt,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!isAdmin) return interaction.reply({ content: "You need **Manage Server** permission to use this command.", flags: MessageFlags.Ephemeral });

      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "That user is not currently a member of Mirage.", flags: MessageFlags.Ephemeral });

      if (interaction.commandName === "actor-agreement-resend") {
        const record = records[target.id];
        if (!record || record.status !== "pending" || record.version !== CONFIG.version) {
          return interaction.reply({ content: "That member does not have a pending agreement. If they declined, use /actor-agreement-enable first.", flags: MessageFlags.Ephemeral });
        }
        await sendAgreement(member);
        return interaction.reply({ content: "The pending Actor agreement has been resent to " + target.tag + ".", flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === "actor-agreement-enable") {
        const record = records[target.id];
        if (!record || record.status !== "declined") {
          return interaction.reply({ content: "That member does not have a declined Actor agreement. Only declined agreements can be re-enabled with this command.", flags: MessageFlags.Ephemeral });
        }
        await startAgreement(member, { force: true });
        records[target.id].enabledBy = interaction.user.id;
        await saveDB();
        return interaction.reply({ content: "The Actor agreement has been re-enabled and sent to " + target.tag + ". They may now choose Agree or Disagree again.", flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      console.error("Actor agreement interaction error:", error);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "An error occurred while processing the Actor agreement. Check the bot console.", flags: MessageFlags.Ephemeral }).catch(() => {});
      } else if (interaction.isRepliable() && interaction.deferred) {
        await interaction.editReply("An error occurred while processing the Actor agreement. Contact Mirage administration.").catch(() => {});
      }
    }
  });

  client.once(Events.ClientReady, async () => {
    try {
      await loadDB();
      if (!CONFIG.actorRoleId) {
        console.warn("Actor agreement system is disabled: ACTOR_ROLE_ID is not configured.");
        return;
      }
      console.log("Mirage Actor agreement system is active.");
    } catch (error) {
      console.error("Could not initialise Actor agreement database:", error);
    }
  });
}

module.exports = { actorCommands, registerActor };
