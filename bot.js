/**
 * Discord Auto-Mod + Auto-Role Bot
 * 
 * SETUP:
 *   1. npm install discord.js
 *   2. Fill in the CONFIG section below
 *   3. node bot.js
 * 
 * REQUIRED BOT PERMISSIONS (when inviting):
 *   - Manage Roles
 *   - Kick Members
 *   - Ban Members
 *   - Manage Messages
 *   - Read Message History
 *   - View Channels / Send Messages
 * 
 * REQUIRED PRIVILEGED INTENTS (Discord Developer Portal):
 *   - Server Members Intent
 *   - Message Content Intent
 */

const { Client, GatewayIntentBits, Partials, EmbedBuilder, AuditLogEvent } = require("discord.js");

// ─────────────────────────────────────────────
//  CONFIG — edit these values
// ─────────────────────────────────────────────
const CONFIG = {
  token: "YOUR_BOT_TOKEN_HERE",

  // Auto-Role: role name(s) to assign when someone joins
  // Add as many as you like, e.g. ["Member", "Newcomer"]
  autoRoles: ["Member"],

  // Mod-log channel name (must already exist in your server)
  logChannel: "mod-logs",

  // Auto-mod settings
  autoMod: {
    // Max mentions per message before action is taken
    maxMentions: 5,

    // Delete messages containing these words/phrases (lowercase)
    bannedWords: ["badword1", "badword2"],

    // Spam: max messages within the time window before mute
    spamLimit: 5,
    spamWindowMs: 5000,       // 5 seconds

    // How long (ms) to mute a spammer (0 = no mute, just delete)
    muteDurationMs: 60_000,   // 1 minute

    // Role name used for muting (bot will create it if missing)
    muteRoleName: "Muted",

    // Invite link detection — delete messages with discord invites
    blockInvites: true,

    // Excessive caps: delete if message is >70% uppercase and >10 chars
    blockCaps: true,
    capsThreshold: 0.70,
  },
};
// ─────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// In-memory spam tracker: { userId: [timestamp, ...] }
const spamTracker = new Map();

// ─── Utility: send to mod-log channel ────────
async function log(guild, embed) {
  const channel = guild.channels.cache.find(
    (c) => c.name === CONFIG.logChannel && c.isTextBased()
  );
  if (channel) await channel.send({ embeds: [embed] }).catch(() => {});
}

function modEmbed(color, title, fields) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(fields)
    .setTimestamp();
}

// ─── Utility: get or create Muted role ───────
async function getMuteRole(guild) {
  let role = guild.roles.cache.find((r) => r.name === CONFIG.autoMod.muteRoleName);
  if (!role) {
    role = await guild.roles.create({
      name: CONFIG.autoMod.muteRoleName,
      permissions: [],
      reason: "Auto-mod mute role",
    });
    // Deny SEND_MESSAGES in every text channel
    for (const [, channel] of guild.channels.cache) {
      if (channel.isTextBased()) {
        await channel.permissionOverwrites
          .edit(role, { SendMessages: false })
          .catch(() => {});
      }
    }
  }
  return role;
}

// ─────────────────────────────────────────────
//  EVENT: guildMemberAdd — auto-role
// ─────────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  const { guild } = member;
  const assigned = [];

  for (const roleName of CONFIG.autoRoles) {
    const role = guild.roles.cache.find((r) => r.name === roleName);
    if (role) {
      await member.roles.add(role).catch(() => {});
      assigned.push(role.name);
    } else {
      console.warn(`[auto-role] Role "${roleName}" not found in ${guild.name}`);
    }
  }

  await log(
    guild,
    modEmbed(0x57f287, "Member joined", [
      { name: "User", value: `${member.user.tag} (${member.id})`, inline: true },
      { name: "Roles assigned", value: assigned.length ? assigned.join(", ") : "none", inline: true },
    ])
  );
});

// ─────────────────────────────────────────────
//  EVENT: messageCreate — auto-mod
// ─────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const { guild, member, author, content } = message;
  const cfg = CONFIG.autoMod;
  const lower = content.toLowerCase();

  // Helper: delete + log
  async function punish(reason, color = 0xfee75c) {
    await message.delete().catch(() => {});
    await log(
      guild,
      modEmbed(color, "Message removed", [
        { name: "User", value: `${author.tag} (${author.id})`, inline: true },
        { name: "Reason", value: reason, inline: true },
        { name: "Channel", value: `<#${message.channelId}>`, inline: true },
        { name: "Content", value: content.slice(0, 300) || "(empty)" },
      ])
    );
  }

  // 1. Banned words
  if (cfg.bannedWords.some((w) => lower.includes(w))) {
    return punish("Banned word detected", 0xed4245);
  }

  // 2. Invite links
  if (cfg.blockInvites && /(discord\.gg|discord\.com\/invite)\//i.test(content)) {
    return punish("Unauthorized invite link", 0xed4245);
  }

  // 3. Excessive caps
  if (cfg.blockCaps && content.length > 10) {
    const upper = content.replace(/[^a-zA-Z]/g, "");
    if (upper.length > 0 && (upper.replace(/[^A-Z]/g, "").length / upper.length) >= cfg.capsThreshold) {
      return punish("Excessive caps", 0xfee75c);
    }
  }

  // 4. Mass mentions
  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  if (mentionCount > cfg.maxMentions) {
    return punish(`Mass mentions (${mentionCount})`, 0xed4245);
  }

  // 5. Spam detection
  const now = Date.now();
  const userId = author.id;
  const timestamps = (spamTracker.get(userId) || []).filter(
    (t) => now - t < cfg.spamWindowMs
  );
  timestamps.push(now);
  spamTracker.set(userId, timestamps);

  if (timestamps.length >= cfg.spamLimit) {
    spamTracker.delete(userId);
    await punish(`Spam (${timestamps.length} messages in ${cfg.spamWindowMs / 1000}s)`, 0xed4245);

    if (cfg.muteDurationMs > 0 && member) {
      const muteRole = await getMuteRole(guild);
      await member.roles.add(muteRole).catch(() => {});
      await log(
        guild,
        modEmbed(0xed4245, "Member muted", [
          { name: "User", value: `${author.tag} (${author.id})` },
          { name: "Duration", value: `${cfg.muteDurationMs / 1000}s` },
          { name: "Reason", value: "Spam" },
        ])
      );
      setTimeout(async () => {
        await member.roles.remove(muteRole).catch(() => {});
        await log(
          guild,
          modEmbed(0x57f287, "Member unmuted", [
            { name: "User", value: `${author.tag} (${author.id})` },
          ])
        );
      }, cfg.muteDurationMs);
    }
  }
});

// ─────────────────────────────────────────────
//  READY
// ─────────────────────────────────────────────
client.once("ready", () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`   Auto-roles : ${CONFIG.autoRoles.join(", ")}`);
  console.log(`   Log channel: #${CONFIG.logChannel}`);
});

client.login(CONFIG.token);
