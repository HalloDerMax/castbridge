import WebSocket from 'ws';
import { logger } from '../lib/log';
import { twitchEmoteRanges, type PlatformEmoteRange } from './emotes';

const log = logger('chat:twitch');

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

export interface IncomingChat {
  platformMsgId: string;
  authorId: string;
  author: string;
  color: string;
  badges: string[];
  text: string;
  ranges: PlatformEmoteRange[];
  at: string;
}

export interface TwitchChatHandlers {
  message(msg: IncomingChat): void;
  deleteMessage(platformMsgId: string): void;
  purgeUser(authorId: string, login: string): void;
  clearChat(): void;
  event(e: { type: string; actor: string; amount: number; detail: Record<string, unknown> }): void;
  state(connected: boolean, error?: string): void;
}

function parseTags(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    out[pair.slice(0, idx)] = pair
      .slice(idx + 1)
      .replace(/\\s/g, ' ')
      .replace(/\\:/g, ';')
      .replace(/\\\\/g, '\\');
  }
  return out;
}

interface IrcLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
  trailing: string;
}

function parseLine(line: string): IrcLine | null {
  let rest = line;
  let tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const trailingIdx = rest.indexOf(' :');
  let trailing = '';
  let head = rest;
  if (trailingIdx >= 0) {
    trailing = rest.slice(trailingIdx + 2);
    head = rest.slice(0, trailingIdx);
  }
  const parts = head.split(' ').filter((p) => p !== '');
  const command = parts.shift();
  if (!command) return null;
  return { tags, prefix, command, params: parts, trailing };
}

/**
 * Liest den Twitch-Chat über IRC. Nur lesen - das Tool schreibt und moderiert
 * nicht. Gelöschte Nachrichten (CLEARMSG) und Timeouts/Bans (CLEARCHAT)
 * werden weitergemeldet, damit sie auch im Overlay verschwinden.
 */
export class TwitchChatClient {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly channel: string,
    private readonly token: string,
    private readonly login: string,
    private readonly handlers: TwitchChatHandlers,
  ) {}

  connect(): void {
    this.closedByUs = false;
    const ws = new WebSocket(IRC_URL);
    this.ws = ws;

    ws.on('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send(`PASS oauth:${this.token}`);
      ws.send(`NICK ${this.login.toLowerCase()}`);
      ws.send(`JOIN #${this.channel.toLowerCase()}`);
      this.reconnectAttempt = 0;
      this.handlers.state(true);
      log.info(`Verbunden mit #${this.channel}`);

      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING :tmi.twitch.tv');
      }, 240_000);
      this.pingTimer.unref();
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      for (const line of raw.toString().split('\r\n')) {
        if (line !== '') this.handleLine(line);
      }
    });

    ws.on('error', (err: Error) => {
      log.warn('IRC-Fehler', err);
      this.handlers.state(false, err.message);
    });

    ws.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.handlers.state(false);
      if (this.closedByUs) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
    log.info(`IRC-Neuverbindung in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUs) this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private handleLine(line: string): void {
    const msg = parseLine(line);
    if (!msg) return;

    if (msg.command === 'PING') {
      this.ws?.send(`PONG :${msg.trailing}`);
      return;
    }

    switch (msg.command) {
      case 'PRIVMSG': {
        const t = msg.tags;
        this.handlers.message({
          platformMsgId: t.id ?? '',
          authorId: t['user-id'] ?? '',
          author: t['display-name'] ?? msg.prefix.split('!')[0],
          color: t.color ?? '',
          badges: (t.badges ?? '').split(',').filter((b) => b !== '').map((b) => b.split('/')[0]),
          text: msg.trailing,
          ranges: twitchEmoteRanges(t.emotes),
          at: t['tmi-sent-ts'] ? new Date(Number(t['tmi-sent-ts'])).toISOString() : new Date().toISOString(),
        });
        break;
      }
      case 'CLEARMSG': {
        const id = msg.tags['target-msg-id'];
        if (id) this.handlers.deleteMessage(id);
        break;
      }
      case 'CLEARCHAT': {
        // Mit Parameter: einzelner Nutzer (Timeout/Ban). Ohne: ganzer Chat.
        const login = msg.trailing;
        if (login !== '') this.handlers.purgeUser(msg.tags['target-user-id'] ?? '', login);
        else this.handlers.clearChat();
        break;
      }
      case 'USERNOTICE': {
        const t = msg.tags;
        const kind = t['msg-id'] ?? '';
        const actor = t['display-name'] ?? t.login ?? '';
        if (kind === 'sub' || kind === 'resub') {
          this.handlers.event({ type: 'sub', actor, amount: 1, detail: { tier: t['msg-param-sub-plan'] ?? '' } });
        } else if (kind === 'subgift' || kind === 'anonsubgift') {
          this.handlers.event({
            type: 'subgift',
            actor,
            amount: 1,
            detail: { recipient: t['msg-param-recipient-display-name'] ?? '' },
          });
        } else if (kind === 'submysterygift') {
          this.handlers.event({
            type: 'subgift',
            actor,
            amount: Number(t['msg-param-mass-gift-count'] ?? '1'),
            detail: {},
          });
        } else if (kind === 'raid') {
          this.handlers.event({
            type: 'raid',
            actor,
            amount: Number(t['msg-param-viewerCount'] ?? '0'),
            detail: {},
          });
        }
        break;
      }
      case 'NOTICE': {
        if (/login authentication failed|improperly formatted/i.test(msg.trailing)) {
          log.error(`Twitch-Chat lehnt die Anmeldung ab: ${msg.trailing}`);
          this.closedByUs = true;
          this.handlers.state(false, msg.trailing);
          this.ws?.close();
        }
        break;
      }
      default:
        break;
    }
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* egal */
    }
    this.ws = null;
  }
}
