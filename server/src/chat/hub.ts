import * as crypto from 'crypto';
import type { PlatformId } from '../config';
import { bus } from '../lib/bus';
import { exec } from '../lib/db';
import { logger } from '../lib/log';
import { getUserById, mergeSettings } from '../lib/users';
import { getAccount, type PlatformAccountRow } from '../platforms/accounts';
import { withToken } from '../platforms';
import { relayManager } from '../relay/manager';
import type { ChatMessage } from '../types';
import { isBot } from './bots';
import { channelEmotes, globalEmotes, kickEmotes, tokenize, type PlatformEmoteRange } from './emotes';
import { TwitchChatClient, type IncomingChat } from './twitchChat';
import { YoutubeChatClient } from './youtubeChat';

const log = logger('chat');

const RECENT_LIMIT = 200;
const RATE_WINDOW_MS = 60_000;

interface UserChat {
  userId: string;
  twitch: TwitchChatClient | null;
  youtube: YoutubeChatClient | null;
  youtubeRetry: NodeJS.Timeout | null;
  kickChatroomId: string | null;
  recent: ChatMessage[];
  times: number[];
  chatters: Map<PlatformId, Set<string>>;
  messageCount: Map<PlatformId, number>;
  connected: Map<PlatformId, boolean>;
  twitchChannelId: string;
}

class ChatHub {
  private readonly users = new Map<string, UserChat>();

  private state(userId: string): UserChat {
    let s = this.users.get(userId);
    if (!s) {
      s = {
        userId,
        twitch: null,
        youtube: null,
        youtubeRetry: null,
        kickChatroomId: null,
        recent: [],
        times: [],
        chatters: new Map(),
        messageCount: new Map(),
        connected: new Map(),
        twitchChannelId: '',
      };
      this.users.set(userId, s);
    }
    return s;
  }

  /** Verbindet alles, was für diesen Nutzer möglich ist. Mehrfach aufrufbar. */
  async ensureForUser(userId: string): Promise<void> {
    const user = await getUserById(userId);
    if (!user) return;
    const s = this.state(userId);

    const twitchAcc = await getAccount(userId, 'twitch');
    if (twitchAcc && twitchAcc.connected_via === 'oauth' && !s.twitch) {
      await this.connectTwitch(s, twitchAcc);
    }

    const ytAcc = await getAccount(userId, 'youtube');
    if (ytAcc && ytAcc.connected_via === 'oauth' && !s.youtube) {
      this.connectYoutube(s, ytAcc);
    }

    const kickAcc = await getAccount(userId, 'kick');
    if (kickAcc && kickAcc.connected_via === 'oauth') {
      s.kickChatroomId = (kickAcc.extra as { chatroomId?: string }).chatroomId ?? null;
      s.connected.set('kick', true);
    }
  }

  private async connectTwitch(s: UserChat, acc: PlatformAccountRow): Promise<void> {
    try {
      const token = await withToken(acc, async (t) => t);
      const login = acc.channel_login === '' ? acc.display_name.toLowerCase() : acc.channel_login;
      s.twitchChannelId = acc.channel_id;
      void channelEmotes(acc.channel_id).catch(() => undefined);

      const client = new TwitchChatClient(login, token, login, {
        message: (m) => void this.onMessage(s.userId, 'twitch', m),
        deleteMessage: (id) => void this.onDelete(s.userId, 'twitch', id),
        purgeUser: (authorId, loginName) => void this.onPurge(s.userId, 'twitch', authorId, loginName),
        clearChat: () => void this.onClearAll(s.userId, 'twitch'),
        event: (e) => void this.onEvent(s.userId, 'twitch', e),
        state: (connected, error) => {
          s.connected.set('twitch', connected);
          if (!connected && error) log.warn(`Twitch-Chat: ${error}`);
        },
      });
      client.connect();
      s.twitch = client;
    } catch (err) {
      log.warn('Twitch-Chat konnte nicht verbunden werden', err);
    }
  }

  private connectYoutube(s: UserChat, acc: PlatformAccountRow): void {
    const liveChatId = (acc.extra as { liveChatId?: string }).liveChatId ?? null;
    if (!liveChatId) {
      // Die Chat-ID entsteht erst, wenn die Sendung läuft. Später erneut versuchen.
      if (s.youtubeRetry) return;
      s.youtubeRetry = setTimeout(() => {
        s.youtubeRetry = null;
        void this.ensureForUser(s.userId);
      }, 30_000);
      s.youtubeRetry.unref();
      return;
    }

    const client = new YoutubeChatClient(
      liveChatId,
      async () => withToken(acc, async (t) => t),
      {
        message: (m) => void this.onMessage(s.userId, 'youtube', m),
        deleteMessage: (id) => void this.onDelete(s.userId, 'youtube', id),
        event: (e) => void this.onEvent(s.userId, 'youtube', e),
        state: (connected) => s.connected.set('youtube', connected),
        quotaExhausted: () => {
          bus.publish(s.userId, { type: 'toast', toast: { level: 'warn', code: 'youtube_quota', platform: 'youtube' } });
        },
      },
    );
    client.start();
    s.youtube = client;
  }

  // ── Kick kommt über Webhooks herein ───────────────────────

  async handleKickChat(
    userId: string,
    payload: { messageId: string; senderId: string; senderName: string; color: string; content: string; badges: string[] },
  ): Promise<void> {
    const { text, ranges } = kickEmotes(payload.content);
    await this.onMessage(userId, 'kick', {
      platformMsgId: payload.messageId,
      authorId: payload.senderId,
      author: payload.senderName,
      color: payload.color,
      badges: payload.badges,
      text,
      ranges,
      at: new Date().toISOString(),
    });
  }

  async handleKickEvent(
    userId: string,
    e: { type: string; actor: string; amount: number; detail: Record<string, unknown> },
  ): Promise<void> {
    await this.onEvent(userId, 'kick', e);
  }

  // ── Gemeinsame Verarbeitung ───────────────────────────────

  private async onMessage(userId: string, platform: PlatformId, incoming: IncomingChat): Promise<void> {
    const user = await getUserById(userId);
    if (!user) return;
    const settings = mergeSettings(user.settings);
    const s = this.state(userId);

    const maps = [await globalEmotes()];
    if (s.twitchChannelId !== '') {
      try {
        maps.unshift(await channelEmotes(s.twitchChannelId));
      } catch {
        /* globale Emotes reichen */
      }
    }

    const fragments = tokenize(incoming.text, incoming.ranges as PlatformEmoteRange[], maps);
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      platform,
      platformMsgId: incoming.platformMsgId,
      authorId: incoming.authorId,
      author: incoming.author,
      color: incoming.color,
      badges: incoming.badges,
      text: incoming.text,
      fragments,
      at: incoming.at,
      isBot: isBot(incoming.author, settings.customBotNames),
    };

    s.recent.push(message);
    if (s.recent.length > RECENT_LIMIT) s.recent.splice(0, s.recent.length - RECENT_LIMIT);

    const now = Date.now();
    s.times.push(now);
    while (s.times.length > 0 && now - s.times[0] > RATE_WINDOW_MS) s.times.shift();

    if (!message.isBot) {
      let set = s.chatters.get(platform);
      if (!set) {
        set = new Set();
        s.chatters.set(platform, set);
      }
      if (incoming.authorId !== '') set.add(incoming.authorId);
      s.messageCount.set(platform, (s.messageCount.get(platform) ?? 0) + 1);
    }

    bus.publish(userId, { type: 'chat', message });

    const sessionId = relayManager.session(userId)?.sessionId ?? null;
    await exec(
      `INSERT INTO chat_messages
         (id, user_id, session_id, platform, platform_msg, author_id, author, color, body, fragments, badges, is_bot, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)`,
      [
        message.id,
        userId,
        sessionId,
        platform,
        message.platformMsgId,
        message.authorId,
        message.author,
        message.color,
        message.text,
        JSON.stringify(fragments),
        JSON.stringify(message.badges),
        message.isBot,
        message.at,
      ],
    ).catch((err) => log.warn('Chat-Nachricht nicht gespeichert', err));
  }

  private async onDelete(userId: string, platform: PlatformId, platformMsgId: string): Promise<void> {
    const s = this.state(userId);
    const hit = s.recent.filter((m) => m.platform === platform && m.platformMsgId === platformMsgId);
    const ids = hit.map((m) => m.id);
    s.recent = s.recent.filter((m) => !(m.platform === platform && m.platformMsgId === platformMsgId));
    if (ids.length > 0) bus.publish(userId, { type: 'chat:delete', ids });
    await exec('UPDATE chat_messages SET deleted = true WHERE user_id = $1 AND platform = $2 AND platform_msg = $3', [
      userId,
      platform,
      platformMsgId,
    ]).catch(() => undefined);
  }

  private async onPurge(userId: string, platform: PlatformId, authorId: string, login: string): Promise<void> {
    const s = this.state(userId);
    const match = (m: ChatMessage): boolean =>
      m.platform === platform &&
      ((authorId !== '' && m.authorId === authorId) || m.author.toLowerCase() === login.toLowerCase());

    const ids = s.recent.filter(match).map((m) => m.id);
    s.recent = s.recent.filter((m) => !match(m));
    if (ids.length > 0) bus.publish(userId, { type: 'chat:delete', ids });
    bus.publish(userId, { type: 'chat:purge', platform, authorId: authorId === '' ? login : authorId });

    await exec(
      `UPDATE chat_messages SET deleted = true
        WHERE user_id = $1 AND platform = $2 AND (author_id = $3 OR lower(author) = lower($4))`,
      [userId, platform, authorId, login],
    ).catch(() => undefined);
  }

  private async onClearAll(userId: string, platform: PlatformId): Promise<void> {
    const s = this.state(userId);
    const ids = s.recent.filter((m) => m.platform === platform).map((m) => m.id);
    s.recent = s.recent.filter((m) => m.platform !== platform);
    if (ids.length > 0) bus.publish(userId, { type: 'chat:delete', ids });
  }

  private async onEvent(
    userId: string,
    platform: PlatformId,
    e: { type: string; actor: string; amount: number; detail: Record<string, unknown> },
  ): Promise<void> {
    bus.publish(userId, { type: 'stream:event', platform, event: e.type, actor: e.actor, amount: e.amount });
    const sessionId = relayManager.session(userId)?.sessionId ?? null;
    await exec(
      'INSERT INTO stream_events (user_id, session_id, platform, type, actor, amount, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [userId, sessionId, platform, e.type, e.actor, Math.round(e.amount), JSON.stringify(e.detail)],
    ).catch((err) => log.warn('Ereignis nicht gespeichert', err));
  }

  // ── Abfragen ──────────────────────────────────────────────

  recent(userId: string, limit = 100, hideBots = false): ChatMessage[] {
    const s = this.users.get(userId);
    if (!s) return [];
    const list = hideBots ? s.recent.filter((m) => !m.isBot) : s.recent;
    return list.slice(-limit);
  }

  rates(userId: string): { messagesPerMinute: number; chatters: number; perPlatform: Partial<Record<PlatformId, number>> } {
    const s = this.users.get(userId);
    if (!s) return { messagesPerMinute: 0, chatters: 0, perPlatform: {} };
    const perPlatform: Partial<Record<PlatformId, number>> = {};
    let chatters = 0;
    for (const [p, set] of s.chatters) {
      perPlatform[p] = set.size;
      chatters += set.size;
    }
    return { messagesPerMinute: s.times.length, chatters, perPlatform };
  }

  connectionState(userId: string): Partial<Record<PlatformId, boolean>> {
    const s = this.users.get(userId);
    if (!s) return {};
    const out: Partial<Record<PlatformId, boolean>> = {};
    for (const [p, v] of s.connected) out[p] = v;
    return out;
  }

  /** Zählerstände für die Statistik-Abtastung und danach zurücksetzen. */
  takeCounters(userId: string): { messages: Partial<Record<PlatformId, number>>; chatters: Partial<Record<PlatformId, number>> } {
    const s = this.users.get(userId);
    if (!s) return { messages: {}, chatters: {} };
    const messages: Partial<Record<PlatformId, number>> = {};
    const chatters: Partial<Record<PlatformId, number>> = {};
    for (const [p, n] of s.messageCount) messages[p] = n;
    for (const [p, set] of s.chatters) chatters[p] = set.size;
    s.messageCount.clear();
    return { messages, chatters };
  }

  resetSession(userId: string): void {
    const s = this.users.get(userId);
    if (!s) return;
    s.chatters.clear();
    s.messageCount.clear();
    s.times = [];
  }

  async stopForUser(userId: string): Promise<void> {
    const s = this.users.get(userId);
    if (!s) return;
    s.twitch?.close();
    s.youtube?.stop();
    if (s.youtubeRetry) clearTimeout(s.youtubeRetry);
    this.users.delete(userId);
  }

  async stopAll(): Promise<void> {
    for (const id of Array.from(this.users.keys())) await this.stopForUser(id);
  }
}

export const chatHub = new ChatHub();
