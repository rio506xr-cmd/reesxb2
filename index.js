import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import ytdlp from 'youtube-dl-exec';
import ffmpegPath from 'ffmpeg-static';

// ========================================
// الإعدادات
// ========================================

// ضع آيدي روم الصوت هنا
const VOICE_CHANNEL_ID = '1567744230418284554';

// التوكن من Render
// يدعم TOKEN و DISCORD_TOKEN
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;

const PORT = Number(process.env.PORT || 10000);

const MAX_QUEUE = 50;
const METADATA_TIMEOUT_MS = 45000;
const PREVIEW_TTL_MS = 10 * 60 * 1000;

if (!TOKEN) {
  throw new Error('أضف TOKEN أو DISCORD_TOKEN في Render.');
}

if (!/^\d{17,20}$/.test(VOICE_CHANNEL_ID)) {
  throw new Error('ضع آيدي روم الصوت الصحيح في index.js.');
}

// إضافة FFmpeg إلى PATH
if (ffmpegPath) {
  process.env.PATH =
    `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH || ''}`;
}

// ========================================
// Discord Client
// ========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const states = new Map();
const previews = new Map();

let configuredGuildId = null;

// ========================================
// نظام الموسيقى
// ========================================

function getState(guildId) {
  if (!states.has(guildId)) {

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    const state = {
      guildId,
      player,
      connection: null,

      queue: [],
      current: null,

      process: null,
      preparing: false,

      panelMessage: null,
      lastStderr: '',
    };

    // عند انتهاء الأغنية
    player.on(AudioPlayerStatus.Idle, () => {

      state.current = null;
      state.process = null;
      state.preparing = false;

      void refreshPanel(state);
      void playNext(state);
    });

    // معالجة أخطاء الصوت
    player.on('error', (error) => {

      console.error('[PLAYER ERROR]', error);

      state.current = null;
      state.preparing = false;

      stopYtDlp(state);

      void refreshPanel(state);

      setTimeout(() => {
        void playNext(state);
      }, 800).unref?.();
    });

    states.set(guildId, state);
  }

  return states.get(guildId);
}

// ========================================
// أدوات مساعدة
// ========================================

function formatDuration(seconds) {

  if (!Number.isFinite(seconds) || seconds < 0) {
    return 'غير معروف';
  }

  const total = Math.floor(seconds);

  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function cleanText(value, max = 180) {

  return String(value || 'غير معروف')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, max);
}

// ========================================
// تصميم بطاقة الأغنية
// ========================================

function buildTrackEmbed(track, statusText = 'معاينة الأغنية') {

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(cleanText(track.title, 240))
    .setURL(track.webpageUrl)
    .setDescription(
      `**الفنان:** ${cleanText(track.artist)}\n` +
      `**المدة:** ${formatDuration(track.duration)}\n` +
      `**الحالة:** ${statusText}`
    )
    .setFooter({
      text: 'Music Player • yt-dlp',
    });

  if (track.thumbnail && /^https?:\/\//i.test(track.thumbnail)) {
    embed.setThumbnail(track.thumbnail);
  }

  return embed;
}

// ========================================
// بطاقة قائمة التشغيل
// ========================================

function buildQueueEmbed(state) {

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎶 قائمة التشغيل')
    .setDescription(
      state.current
        ? `**يعمل الآن:** [${cleanText(state.current.title, 100)}](${state.current.webpageUrl})\n\n`
        : 'لا توجد أغنية قيد التشغيل حالياً.\n\n'
    );

  if (state.queue.length) {

    const upcoming = state.queue
      .slice(0, 10)
      .map((track, index) =>
        `**${index + 1}.** [${cleanText(track.title, 90)}](${track.webpageUrl}) — ${formatDuration(track.duration)}`
      );

    embed.addFields({
      name: `القادم (${state.queue.length})`,
      value: upcoming.join('\n').slice(0, 1024),
    });

  } else {

    embed.addFields({
      name: 'القادم',
      value: 'القائمة فارغة.',
    });
  }

  return embed;
}

// ========================================
// أزرار التحكم
// ========================================

function controlRow(state) {

  const paused =
    state.player.state.status === AudioPlayerStatus.Paused;

  return new ActionRowBuilder().addComponents(

    new ButtonBuilder()
      .setCustomId('music:toggle')
      .setLabel(paused ? 'استئناف' : 'إيقاف مؤقت')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('music:skip')
      .setLabel('تخطي')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('music:queue')
      .setLabel('القائمة')
      .setEmoji('📃')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('music:stop')
      .setLabel('إيقاف')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),

  );
}

// ========================================
// تحديث لوحة التحكم
// ========================================

async function refreshPanel(state) {

  if (!state.panelMessage) return;

  try {

    const embed = state.current
      ? buildTrackEmbed(
          state.current,
          state.player.state.status === AudioPlayerStatus.Paused
            ? 'متوقفة مؤقتاً'
            : 'قيد التشغيل'
        )
      : buildQueueEmbed(state);

    await state.panelMessage.edit({
      embeds: [embed],
      components: [controlRow(state)],
    });

  } catch (error) {

    if (error?.code !== 10008) {
      console.error('[PANEL UPDATE]', error.message);
    }

    state.panelMessage = null;
  }
}

// ========================================
// إيقاف عملية yt-dlp
// ========================================

function stopYtDlp(state) {

  const child = state.process;

  state.process = null;

  if (child && child.exitCode === null && !child.killed) {

    try {
      child.kill('SIGKILL');
    } catch {
      // انتهت العملية بالفعل
    }
  }
}

// ========================================
// قراءة بيانات الأغنية باستخدام yt-dlp
// ========================================

function runYtDlpForJson(url) {

  return new Promise((resolve, reject) => {

    const child = ytdlp.exec(url, {

      dumpSingleJson: true,
      skipDownload: true,
      noPlaylist: true,
      noWarnings: true,
      quiet: true,

      socketTimeout: 20,
      retries: 1,

    });

    const stdout = [];
    const stderr = [];

    let settled = false;

    const timer = setTimeout(() => {

      if (!settled) {

        settled = true;

        child.kill('SIGKILL');

        reject(
          new Error('انتهت مهلة قراءة بيانات الأغنية.')
        );
      }

    }, METADATA_TIMEOUT_MS);

    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      stdout.push(Buffer.from(chunk));
    });

    child.stderr?.on('data', (chunk) => {

      stderr.push(Buffer.from(chunk));

      while (
        stderr.reduce((size, part) => size + part.length, 0) > 12000
      ) {
        stderr.shift();
      }
    });

    child.once('error', (error) => {

      if (settled) return;

      settled = true;

      clearTimeout(timer);

      reject(error);
    });

    child.once('close', (code) => {

      if (settled) return;

      settled = true;

      clearTimeout(timer);

      const output = Buffer
        .concat(stdout)
        .toString('utf8')
        .trim();

      if (code !== 0 || !output) {

        const details = Buffer
          .concat(stderr)
          .toString('utf8')
          .trim()
          .slice(-1200);

        reject(
          new Error(details || `yt-dlp انتهى برمز ${code}.`)
        );

        return;
      }

      try {

        resolve(JSON.parse(output));

      } catch {

        reject(
          new Error('تعذر قراءة بيانات الأغنية من yt-dlp.')
        );
      }
    });
  });
}

// ========================================
// التحقق من الرابط
// ========================================

function validateHttpUrl(rawUrl) {

  let parsed;

  try {

    parsed = new URL(rawUrl.trim());

  } catch {

    throw new Error(
      'الرابط غير صحيح. أرسل رابطاً كاملاً يبدأ بـ https://'
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {

    throw new Error(
      'المسموح روابط HTTP أو HTTPS فقط.'
    );
  }

  return parsed.toString();
}

// ========================================
// استخراج معلومات الأغنية
// ========================================

async function getTrackInfo(rawUrl, requesterId) {

  const url = validateHttpUrl(rawUrl);

  const info = await runYtDlpForJson(url);

  const entry = Array.isArray(info.entries)
    ? info.entries.find(Boolean)
    : info;

  if (!entry) {

    throw new Error(
      'لم أجد مقطعاً قابلاً للتشغيل في هذا الرابط.'
    );
  }

  const pageUrl =
    entry.webpage_url ||
    entry.original_url ||
    url;

  return {

    id: String(entry.id || randomUUID()),

    title: cleanText(
      entry.title || 'بدون عنوان',
      240
    ),

    artist: cleanText(
      entry.artist ||
      entry.uploader ||
      entry.channel ||
      'غير معروف',
      180
    ),

    duration: Number.isFinite(Number(entry.duration))
      ? Number(entry.duration)
      : null,

    thumbnail:
      entry.thumbnail ||
      entry.thumbnails?.at(-1)?.url ||
      null,

    webpageUrl: pageUrl,
    url: pageUrl,

    requesterId,
  };
}

// ========================================
// تشغيل الأغنية باستخدام yt-dlp
// ========================================

function launchYtDlpStream(state, track) {

  const child = ytdlp.exec(track.url, {

    format: 'bestaudio/best',
    output: '-',

    noPlaylist: true,
    quiet: true,
    noWarnings: true,
    noProgress: true,

    socketTimeout: 20,
    retries: 2,
    fragmentRetries: 2,

  });

  state.process = child;
  state.lastStderr = '';

  child.stderr?.on('data', (chunk) => {

    state.lastStderr =
      (state.lastStderr + chunk.toString('utf8'))
        .slice(-3000);
  });

  child.once('error', (error) => {

    console.error('[YT-DLP PROCESS]', error);
  });

  child.once('close', (code) => {

    if (state.process === child) {
      state.process = null;
    }

    if (code !== 0 && code !== null) {

      console.error(
        '[YT-DLP EXIT]',
        code,
        state.lastStderr.slice(-1000)
      );
    }
  });

  return child;
}

// ========================================
// تشغيل التالي من قائمة الانتظار
// ========================================

async function playNext(state) {

  if (
    state.preparing ||
    state.player.state.status !== AudioPlayerStatus.Idle
  ) {
    return;
  }

  const track = state.queue.shift();

  if (!track) {

    state.current = null;

    await refreshPanel(state);

    return;
  }

  state.preparing = true;
  state.current = track;

  try {

    const child = launchYtDlpStream(state, track);

    const resource = createAudioResource(child.stdout, {

      inputType: StreamType.Arbitrary,

      metadata: track,

    });

    state.player.play(resource);

    state.preparing = false;

    await refreshPanel(state);

  } catch (error) {

    console.error('[PLAY NEXT]', error);

    state.preparing = false;
    state.current = null;

    stopYtDlp(state);

    await refreshPanel(state);

    setTimeout(() => {
      void playNext(state);
    }, 1200).unref?.();
  }
}

// ========================================
// الاتصال بروم الصوت المحدد في index.js
// ========================================

async function ensureVoiceConnection(guild) {

  const voiceChannel =
    await client.channels.fetch(VOICE_CHANNEL_ID);

  if (
    !voiceChannel ||
    !voiceChannel.isVoiceBased() ||
    voiceChannel.type === ChannelType.GuildStageVoice
  ) {

    throw new Error(
      'آيدي روم الصوت غير صحيح. استخدم روم صوت عادي وليس Stage.'
    );
  }

  if (voiceChannel.guildId !== guild.id) {

    throw new Error(
      'روم الصوت المحدد ليس في هذا السيرفر.'
    );
  }

  const permissions =
    voiceChannel.permissionsFor(client.user);

  if (
    !permissions?.has(PermissionFlagsBits.Connect) ||
    !permissions?.has(PermissionFlagsBits.Speak)
  ) {

    throw new Error(
      'البوت يحتاج صلاحية Connect و Speak في روم الصوت.'
    );
  }

  const state = getState(guild.id);

  if (
    !state.connection ||
    state.connection.state.status === VoiceConnectionStatus.Destroyed
  ) {

    state.connection = joinVoiceChannel({

      channelId: voiceChannel.id,

      guildId: guild.id,

      adapterCreator: guild.voiceAdapterCreator,

      selfDeaf: true,
      selfMute: false,

    });

    state.connection.subscribe(state.player);

    state.connection.on('error', (error) => {
      console.error('[VOICE CONNECTION]', error);
    });
  }

  await entersState(
    state.connection,
    VoiceConnectionStatus.Ready,
    25000
  );

  return state;
}

// ========================================
// التحقق من وجود المستخدم في روم الصوت
// ========================================

function requireUserInConfiguredVoice(interaction) {

  const currentVoiceId =
    interaction.guild?.voiceStates?.cache?.get(interaction.user.id)?.channelId;

  return currentVoiceId === VOICE_CHANNEL_ID;
}

// ========================================
// تسجيل أوامر Slash
// ========================================

async function registerCommands(guild) {

  const commands = [

    new SlashCommandBuilder()
      .setName('song')
      .setDescription('اعرض الأغنية ثم أضفها إلى قائمة التشغيل')
      .addStringOption(option =>
        option
          .setName('url')
          .setDescription('رابط المقطع الصوتي')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('عرض قائمة التشغيل'),

    new SlashCommandBuilder()
      .setName('pause')
      .setDescription('إيقاف الأغنية مؤقتاً'),

    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('استئناف الأغنية'),

    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('تخطي الأغنية الحالية'),

    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('إيقاف التشغيل ومسح القائمة'),

  ];

  const existing = await guild.commands.fetch();

  for (const builder of commands) {

    const data = builder.toJSON();

    const old = existing.find(
      command => command.name === data.name
    );

    if (old) {

      await old.edit(data);

    } else {

      await guild.commands.create(data);
    }
  }

  console.log(
    `[SLASH COMMANDS] Registered in ${guild.name}`
  );
}

// ========================================
// رسائل الأخطاء
// ========================================

async function replyError(interaction, message) {

  const payload = {
    content: `⚠️ ${message}`,
    ephemeral: true,
  };

  if (interaction.deferred || interaction.replied) {

    return interaction.followUp(payload).catch(() => {});
  }

  return interaction.reply(payload).catch(() => {});
}

// ========================================
// أمر /song
// ========================================

async function handleSongCommand(interaction) {

  if (!requireUserInConfiguredVoice(interaction)) {

    return replyError(
      interaction,
      'ادخل روم الصوت المحدد في أعلى index.js أولاً.'
    );
  }

  await interaction.deferReply();

  try {

    const state =
      await ensureVoiceConnection(interaction.guild);

    const rawUrl =
      interaction.options.getString('url', true);

    const track = await getTrackInfo(
      rawUrl,
      interaction.user.id
    );

    if (state.queue.length >= MAX_QUEUE) {

      return interaction.editReply(
        `القائمة ممتلئة. الحد الأقصى ${MAX_QUEUE} أغنية.`
      );
    }

    const previewId =
      randomUUID().replaceAll('-', '').slice(0, 24);

    previews.set(previewId, {
      track,
      guildId: interaction.guildId,
    });

    const cleanupTimer = setTimeout(() => {
      previews.delete(previewId);
    }, PREVIEW_TTL_MS);

    cleanupTimer.unref?.();

    const row = new ActionRowBuilder().addComponents(

      new ButtonBuilder()
        .setCustomId(`song:add:${previewId}`)
        .setLabel('إضافة إلى قائمة التشغيل')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId(`song:cancel:${previewId}`)
        .setLabel('إلغاء')
        .setStyle(ButtonStyle.Secondary),

    );

    await interaction.editReply({

      embeds: [
        buildTrackEmbed(track, 'جاهزة للإضافة'),
      ],

      components: [row],

    });

  } catch (error) {

    console.error('[SONG COMMAND]', error);

    const message =
      /not a bot|Unsupported URL|No video|private|unavailable|not available/i.test(error.message)
        ? 'المقطع غير متاح أو الرابط غير مدعوم حالياً. جرّب رابطاً عاماً آخر.'
        : `تعذر جلب بيانات المقطع: ${cleanText(error.message, 300)}`;

    await interaction.editReply({

      content: `⚠️ ${message}`,

      embeds: [],
      components: [],

    }).catch(() => {});
  }
}

// ========================================
// التعامل مع الأزرار
// ========================================

async function handleButton(interaction) {

  const [scope, action, id] =
    interaction.customId.split(':');

  // إلغاء معاينة الأغنية
  if (scope === 'song' && action === 'cancel') {

    previews.delete(id);

    return interaction.update({

      content: 'تم إلغاء طلب الأغنية.',

      embeds: [],
      components: [],

    });
  }

  // إضافة الأغنية إلى القائمة
  if (scope === 'song' && action === 'add') {

    const preview = previews.get(id);

    if (
      !preview ||
      preview.guildId !== interaction.guildId
    ) {

      return replyError(
        interaction,
        'انتهت صلاحية معاينة الأغنية. استخدم /song من جديد.'
      );
    }

    if (!requireUserInConfiguredVoice(interaction)) {

      return replyError(
        interaction,
        'ادخل روم الصوت المحدد أولاً.'
      );
    }

    const state = getState(interaction.guildId);

    if (state.queue.length >= MAX_QUEUE) {

      return replyError(
        interaction,
        `القائمة ممتلئة. الحد الأقصى ${MAX_QUEUE} أغنية.`
      );
    }

    previews.delete(id);

    const track = {
      ...preview.track,
      requesterId: interaction.user.id,
    };

    state.queue.push(track);

    // لوحة التحكم تظهر في نفس الشات الذي استخدم فيه /song
    state.panelMessage = interaction.message;

    await interaction.update({

      embeds: [
        buildTrackEmbed(track, 'تمت إضافتها إلى القائمة'),
      ],

      components: [
        controlRow(state),
      ],

    });

    try {

      await ensureVoiceConnection(interaction.guild);

      await playNext(state);

    } catch (error) {

      console.error('[QUEUE / VOICE]', error);

      await interaction.followUp({

        content:
          `⚠️ تمت إضافة الأغنية، لكن تعذر الاتصال بالروم: ${cleanText(error.message, 250)}`,

        ephemeral: true,

      }).catch(() => {});
    }

    return;
  }

  if (scope !== 'music') return;

  if (
    !interaction.guild ||
    interaction.guildId !== configuredGuildId
  ) {

    return replyError(
      interaction,
      'هذا التحكم متاح في السيرفر المحدد فقط.'
    );
  }

  if (!requireUserInConfiguredVoice(interaction)) {

    return replyError(
      interaction,
      'ادخل روم الصوت المحدد للتحكم بالتشغيل.'
    );
  }

  const state = getState(interaction.guildId);

  // إيقاف مؤقت / استئناف
  if (action === 'toggle') {

    if (
      state.player.state.status === AudioPlayerStatus.Paused
    ) {

      state.player.unpause();

    } else if (
      state.player.state.status === AudioPlayerStatus.Playing
    ) {

      state.player.pause();

    } else {

      return replyError(
        interaction,
        'ما فيه أغنية تعمل حالياً.'
      );
    }

    state.panelMessage = interaction.message;

    await interaction.update({

      embeds: [
        state.current
          ? buildTrackEmbed(
              state.current,
              state.player.state.status === AudioPlayerStatus.Paused
                ? 'متوقفة مؤقتاً'
                : 'قيد التشغيل'
            )
          : buildQueueEmbed(state),
      ],

      components: [
        controlRow(state),
      ],

    });

    return;
  }

  // تخطي
  if (action === 'skip') {

    if (!state.current) {

      return replyError(
        interaction,
        'ما فيه أغنية لتخطيها.'
      );
    }

    state.panelMessage = interaction.message;

    stopYtDlp(state);

    state.current = null;
    state.preparing = false;

    if (
      state.player.state.status !== AudioPlayerStatus.Idle
    ) {

      state.player.stop(true);

    } else {

      void playNext(state);
    }

    await interaction.reply({

      content: '⏭️ تم تخطي الأغنية.',

      ephemeral: true,

    });

    return;
  }

  // إيقاف ومسح القائمة
  if (action === 'stop') {

    state.panelMessage = interaction.message;

    state.queue = [];
    state.current = null;
    state.preparing = false;

    stopYtDlp(state);

    if (
      state.player.state.status !== AudioPlayerStatus.Idle
    ) {

      state.player.stop(true);
    }

    await interaction.reply({

      content: '⏹️ تم إيقاف التشغيل ومسح القائمة.',

      ephemeral: true,

    });

    await refreshPanel(state);

    return;
  }

  // عرض القائمة
  if (action === 'queue') {

    return interaction.reply({

      embeds: [
        buildQueueEmbed(state),
      ],

      ephemeral: true,

    });
  }
}

// ========================================
// أوامر Slash الإضافية
// ========================================

async function handleSlashCommand(interaction) {

  if (interaction.guildId !== configuredGuildId) {

    return replyError(
      interaction,
      'البوت مضبوط على سيرفر واحد وروم صوت واحد.'
    );
  }

  if (!requireUserInConfiguredVoice(interaction)) {

    return replyError(
      interaction,
      'ادخل روم الصوت المحدد في أعلى index.js أولاً.'
    );
  }

  if (interaction.commandName === 'song') {

    return handleSongCommand(interaction);
  }

  const state =
    await ensureVoiceConnection(interaction.guild);

  if (interaction.commandName === 'queue') {

    return interaction.reply({

      embeds: [
        buildQueueEmbed(state),
      ],

      ephemeral: true,

    });
  }

  if (interaction.commandName === 'pause') {

    if (
      state.player.state.status !== AudioPlayerStatus.Playing
    ) {

      return replyError(
        interaction,
        'ما فيه أغنية تعمل حالياً.'
      );
    }

    state.player.pause();

    await interaction.reply({

      content: '⏸️ تم الإيقاف المؤقت.',

      ephemeral: true,

    });

    await refreshPanel(state);

    return;
  }

  if (interaction.commandName === 'resume') {

    if (
      state.player.state.status !== AudioPlayerStatus.Paused
    ) {

      return replyError(
        interaction,
        'الأغنية ليست متوقفة مؤقتاً.'
      );
    }

    state.player.unpause();

    await interaction.reply({

      content: '▶️ تم استئناف التشغيل.',

      ephemeral: true,

    });

    await refreshPanel(state);

    return;
  }

  if (interaction.commandName === 'skip') {

    if (!state.current) {

      return replyError(
        interaction,
        'ما فيه أغنية لتخطيها.'
      );
    }

    stopYtDlp(state);

    state.current = null;
    state.preparing = false;

    if (
      state.player.state.status !== AudioPlayerStatus.Idle
    ) {

      state.player.stop(true);

    } else {

      void playNext(state);
    }

    return interaction.reply({

      content: '⏭️ تم تخطي الأغنية.',

      ephemeral: true,

    });
  }

  if (interaction.commandName === 'stop') {

    state.queue = [];
    state.current = null;
    state.preparing = false;

    stopYtDlp(state);

    if (
      state.player.state.status !== AudioPlayerStatus.Idle
    ) {

      state.player.stop(true);
    }

    await interaction.reply({

      content: '⏹️ تم إيقاف التشغيل ومسح القائمة.',

      ephemeral: true,

    });

    await refreshPanel(state);
  }
}

// ========================================
// استقبال التفاعلات
// ========================================

client.on(Events.InteractionCreate, async (interaction) => {

  try {

    if (interaction.isChatInputCommand()) {

      await handleSlashCommand(interaction);

    } else if (interaction.isButton()) {

      await handleButton(interaction);
    }

  } catch (error) {

    console.error('[INTERACTION ERROR]', error);

    await replyError(
      interaction,
      'صار خطأ غير متوقع. راجع Logs في Render.'
    );
  }
});

// ========================================
// تشغيل البوت
// ========================================

client.once(Events.ClientReady, async (readyClient) => {

  console.log(
    `[DISCORD READY] Logged in as ${readyClient.user.tag}`
  );

  try {

    const voiceChannel =
      await client.channels.fetch(VOICE_CHANNEL_ID);

    if (!voiceChannel?.guild) {

      throw new Error(
        'لم أجد روم الصوت. تأكد من آيدي الروم وأن البوت موجود بالسيرفر.'
      );
    }

    configuredGuildId = voiceChannel.guild.id;

    await registerCommands(voiceChannel.guild);

    await ensureVoiceConnection(voiceChannel.guild);

    console.log(
      `[VOICE READY] Connected to ${voiceChannel.name}`
    );

  } catch (error) {

    console.error(
      '[STARTUP VOICE/COMMANDS]',
      error
    );
  }
});

// ========================================
// Render Web Service
// ========================================

const server = createServer((req, res) => {

  if (req.url === '/health' || req.url === '/') {

    const body = JSON.stringify({

      status: client.isReady() ? 'ok' : 'starting',

      discord: client.isReady(),

      voiceChannelConfigured:
        VOICE_CHANNEL_ID !== 'PUT_VOICE_CHANNEL_ID_HERE',

    });

    res.writeHead(
      client.isReady() ? 200 : 503,
      {
        'content-type': 'application/json; charset=utf-8',

        'content-length': Buffer.byteLength(body),
      }
    );

    res.end(body);

    return;
  }

  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
  });

  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {

  console.log(
    `[HTTP READY] Listening on 0.0.0.0:${PORT}`
  );
});

// ========================================
// معالجة إغلاق الخدمة والأخطاء
// ========================================

process.on('unhandledRejection', (error) => {

  console.error(
    '[UNHANDLED REJECTION]',
    error
  );
});

process.on('uncaughtException', (error) => {

  console.error(
    '[UNCAUGHT EXCEPTION]',
    error
  );

  process.exit(1);
});

async function shutdown(signal) {

  console.log(`[SHUTDOWN] ${signal}`);

  for (const state of states.values()) {

    state.queue = [];

    stopYtDlp(state);

    try {
      state.player.stop(true);
    } catch {}

    try {
      state.connection?.destroy();
    } catch {}
  }

  server.close();

  client.destroy();

  process.exit(0);
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

// تسجيل الدخول
client.login(TOKEN).catch((error) => {

  console.error(
    '[DISCORD LOGIN FAILED]',
    error
  );

  process.exit(1);
});