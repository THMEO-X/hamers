require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');

const config = require('./config.json');
const human = require('./human');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!DISCORD_TOKEN || !GROQ_API_KEY) {
  console.error('Thiếu DISCORD_TOKEN hoặc GROQ_API_KEY trong file .env');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const TRAINING_FILE = path.join(DATA_DIR, 'training.jsonl');

fs.mkdirSync(DATA_DIR, { recursive: true });

let channelStore = {};
try {
  channelStore = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
} catch {
  channelStore = {};
}

const saveChannels = () =>
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channelStore, null, 2));

const appendJsonl = (file, obj) =>
  fs.appendFile(file, JSON.stringify(obj) + '\n', (err) => {
    if (err) console.error('Lỗi ghi file:', err.message);
  });

const isActiveChannel = (guildId, channelId) =>
  (channelStore[guildId] || []).includes(channelId);

const contexts = new Map();

function getContext(channelId) {
  if (!contexts.has(channelId)) contexts.set(channelId, []);
  return contexts.get(channelId);
}

function pushContext(channelId, msg) {
  const ctx = getContext(channelId);
  ctx.push(msg);
  while (ctx.length > config.maxHistory) ctx.shift();
}

async function askGroq(messages, attempt = 0) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
  });

  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get('retry-after')) || 2 * (attempt + 1);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return askGroq(messages, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

function splitMessage(text, limit = 1900) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

require('./keep_alive')(client);

const commands = [
  new SlashCommandBuilder()
    .setName('channel')
    .setDescription('Chỉ định channel để bot trả lời (chỉ owner server)')
    .addStringOption((o) =>
      o.setName('id').setDescription('ID của channel').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Dừng bot ở channel chỉ định (chỉ owner server)')
    .addStringOption((o) =>
      o.setName('id').setDescription('ID của channel').setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
  } catch (err) {
    console.error(`Không đăng ký được lệnh ở ${guild.name}:`, err.message);
  }
}

client.once('clientReady', async () => {
  console.log(`Hamers đã online: ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) await registerCommands(guild);
});

client.on('guildCreate', registerCommands);

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) {
    return interaction.reply({
      content: 'Lệnh này chỉ dùng trong server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.user.id !== interaction.guild.ownerId) {
    return interaction.reply({
      content: 'Chỉ owner server mới được dùng lệnh này.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const channelId = interaction.options.getString('id').trim();
  const guildId = interaction.guild.id;
  const target = await interaction.guild.channels.fetch(channelId).catch(() => null);

  if (interaction.commandName === 'channel') {
    if (!target || !target.isTextBased()) {
      return interaction.reply({
        content: 'ID channel không hợp lệ.',
        flags: MessageFlags.Ephemeral,
      });
    }
    channelStore[guildId] = channelStore[guildId] || [];
    if (channelStore[guildId].includes(channelId)) {
      return interaction.reply({
        content: `Bot đã hoạt động ở <#${channelId}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    channelStore[guildId].push(channelId);
    saveChannels();
    return interaction.reply(`Đã bật bot ở <#${channelId}>.`);
  }

  if (interaction.commandName === 'stop') {
    const list = channelStore[guildId] || [];
    if (!list.includes(channelId)) {
      return interaction.reply({
        content: 'Channel này chưa được bật.',
        flags: MessageFlags.Ephemeral,
      });
    }
    channelStore[guildId] = list.filter((id) => id !== channelId);
    saveChannels();
    return interaction.reply(`Đã dừng bot ở <#${channelId}>.`);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const mentioned = message.mentions.has(client.user, {
    ignoreEveryone: true,
    ignoreRoles: true,
  });
  const inActiveChannel = isActiveChannel(message.guild.id, message.channel.id);

  let shouldReply = mentioned;
  if (!shouldReply && inActiveChannel && !config.mentionOnlyInChannels) {
    shouldReply = true;
  }
  if (!shouldReply) return;

  const content = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();
  if (!content) return;

  const channelId = message.channel.id;
  const userText = `${message.author.username}: ${content}`;

  appendJsonl(HISTORY_FILE, {
    ts: new Date().toISOString(),
    guildId: message.guild.id,
    channelId,
    userId: message.author.id,
    username: message.author.username,
    role: 'user',
    content,
  });

  pushContext(channelId, { role: 'user', content: userText });

  try {
    let answer = human.matchIntent(content);
    const canned = answer !== null;

    if (!canned) {
      await message.channel.sendTyping().catch(() => {});
      answer = await askGroq([
        { role: 'system', content: config.systemPrompt },
        ...getContext(channelId),
      ]);
    }

    if (!answer) return;

    const finalText = human.decorate(answer, content);

    pushContext(channelId, { role: 'assistant', content: finalText });

    appendJsonl(HISTORY_FILE, {
      ts: new Date().toISOString(),
      guildId: message.guild.id,
      channelId,
      userId: client.user.id,
      username: client.user.username,
      role: 'assistant',
      source: canned ? 'canned' : 'groq',
      content: finalText,
    });

    appendJsonl(TRAINING_FILE, {
      messages: [
        { role: 'system', content: config.systemPrompt },
        { role: 'user', content },
        { role: 'assistant', content: finalText },
      ],
    });

    const chunks = splitMessage(finalText);
    await message.reply({
      content: chunks[0],
      allowedMentions: { repliedUser: false, parse: [] },
    });
    for (const chunk of chunks.slice(1)) {
      await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  } catch (err) {
    console.error(err.message);
    await message
      .reply({
        content: 'Đã xảy ra lỗi khi xử lý yêu cầu.',
        allowedMentions: { repliedUser: false },
      })
      .catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
