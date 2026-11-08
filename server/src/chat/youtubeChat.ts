import { logger } from '../lib/log';
import { liveChatMessages, quotaHint } from '../platforms/youtube';
import type { IncomingChat } from './twitchChat';

const log = logger('chat:youtube');

export interface YoutubeChatHandlers {
  message(msg: IncomingChat): void;
  deleteMessage(platformMsgId: string): void;
  event(e: { type: string; actor: string; amount: number; detail: Record<string, unknown> }): void;
  state(connected: boolean, error?: string): void;
  quotaExhausted(): void;
}

/**
 * YouTube hat keinen Push-Chat, es wird abgefragt. Das Tageskontingent der
 * API ist begrenzt, deshalb halten wir uns strikt an die von Google
 * vorgeschlagene Wartezeit (mindestens 5 Sekunden) und hören bei
 * "quotaExceeded" ganz auf, statt weiter zu hämmern.
 */
export class YoutubeChatClient {
  private timer: NodeJS.Timeout | null = null;
  private pageToken: string | null = null;
  private stopped = false;
  private failures = 0;
  private firstPass = true;

  constructor(
    private readonly liveChatId: string,
    private readonly getToken: () => Promise<string>,
    private readonly handlers: YoutubeChatHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    void this.poll();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, ms);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const token = await this.getToken();
      const page = await liveChatMessages(token, this.liveChatId, this.pageToken);
      this.pageToken = page.nextPageToken;
      this.failures = 0;
      this.handlers.state(true);

      for (const m of page.messages) {
        if (m.deletedId) {
          this.handlers.deleteMessage(m.deletedId);
          continue;
        }
        // Beim ersten Durchlauf kommt der Verlauf - den nicht als neu melden.
        if (!this.firstPass && m.text !== '') {
          this.handlers.message({
            platformMsgId: m.id,
            authorId: m.authorId,
            author: m.author,
            color: '',
            badges: m.isMember ? ['member'] : [],
            text: m.text,
            ranges: [],
            at: m.publishedAt,
          });
        }
        if (!this.firstPass && m.isSuper) {
          this.handlers.event({ type: 'superchat', actor: m.author, amount: m.amount, detail: { text: m.text } });
        }
        if (!this.firstPass && m.isMember) {
          this.handlers.event({ type: 'member', actor: m.author, amount: 1, detail: {} });
        }
      }
      this.firstPass = false;
      this.schedule(page.pollingIntervalMillis);
    } catch (err) {
      if (quotaHint(err)) {
        this.handlers.quotaExhausted();
        this.handlers.state(false, 'quota_exceeded');
        this.stopped = true;
        return;
      }
      this.failures += 1;
      this.handlers.state(false, err instanceof Error ? err.message : String(err));
      if (this.failures >= 6) {
        log.warn('YouTube-Chat gibt auf (zu viele Fehlversuche).');
        this.stopped = true;
        return;
      }
      this.schedule(Math.min(60_000, 5000 * this.failures));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
