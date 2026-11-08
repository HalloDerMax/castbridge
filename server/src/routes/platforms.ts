import type { FastifyInstance } from 'fastify';
import { PLATFORMS, isPlatformId, oauthConfigured, type PlatformId } from '../config';
import { audit, requireUser, type AuthedRequest } from '../lib/auth';
import { randomToken } from '../lib/crypto';
import { logger } from '../lib/log';
import { BadRequest, body, str } from '../lib/validate';
import { capabilities, kick, twitch, youtube } from '../platforms';
import { accessToken, deleteAccount, getAccount, listAccounts, patchExtra, upsertAccount } from '../platforms/accounts';
import { chatHub } from '../chat/hub';
import { getUserById } from '../lib/users';

const log = logger('routes:platforms');

interface PendingAuth {
  userId: string;
  platform: PlatformId;
  verifier?: string;
  createdAt: number;
}

const pending = new Map<string, PendingAuth>();

function cleanPending(): void {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [k, v] of Array.from(pending.entries())) {
    if (v.createdAt < cutoff) pending.delete(k);
  }
}

/** Wo der Nutzer den Key selbst findet - wird in der Oberfläche angezeigt. */
export const MANUAL_HINTS: Record<PlatformId, { url: string; steps: string[]; ingestUrl: string }> = {
  twitch: {
    url: 'https://dashboard.twitch.tv/settings/stream',
    steps: [
      'Twitch-Creator-Dashboard öffnen',
      'Einstellungen → Stream',
      'Bei "Primärer Stream-Schlüssel" auf Kopieren',
    ],
    ingestUrl: 'rtmp://live.twitch.tv/app',
  },
  youtube: {
    url: 'https://studio.youtube.com/channel/livestreaming',
    steps: [
      'YouTube Studio öffnen',
      'Livestreaming → Streamen',
      'Unter "Stream-Einstellungen" den Stream-Schlüssel kopieren',
    ],
    ingestUrl: 'rtmp://a.rtmp.youtube.com/live2',
  },
  kick: {
    url: 'https://kick.com/dashboard/settings/stream',
    steps: [
      'Kick-Dashboard öffnen',
      'Settings → Stream',
      'Stream-URL und Stream-Key kopieren (Kick verlangt RTMPS)',
    ],
    ingestUrl: kick.DEFAULT_INGEST,
  },
};

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/platforms', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const accounts = await listAccounts(user.id);
    return {
      platforms: PLATFORMS.map((platform) => {
        const acc = accounts.find((a) => a.platform === platform) ?? null;
        return {
          platform,
          capabilities: capabilities(platform),
          oauthAvailable: oauthConfigured(platform),
          connected: acc !== null,
          connectedVia: acc?.connected_via ?? null,
          channelName: acc ? (acc.display_name === '' ? acc.channel_login : acc.display_name) : '',
          lastError: acc?.last_error ?? null,
          hasStreamKey: acc?.stream_key_enc !== null && acc?.stream_key_enc !== undefined,
          manual: MANUAL_HINTS[platform],
        };
      }),
    };
  });

  app.get('/api/platforms/:platform/connect', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const platform = (req.params as { platform: string }).platform;
    if (!isPlatformId(platform)) throw new BadRequest('invalid_platform');
    if (!oauthConfigured(platform)) throw new BadRequest('oauth_not_configured');

    cleanPending();
    const state = randomToken(18);

    if (platform === 'kick') {
      const pkce = kick.createPkce();
      pending.set(state, { userId: user.id, platform, verifier: pkce.verifier, createdAt: Date.now() });
      return { url: kick.authUrl(state, pkce.challenge) };
    }

    pending.set(state, { userId: user.id, platform, createdAt: Date.now() });
    return { url: platform === 'twitch' ? twitch.authUrl(state) : youtube.authUrl(state) };
  });

  app.get('/api/platforms/:platform/callback', async (req, reply) => {
    const platform = (req.params as { platform: string }).platform;
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };

    const fail = (code: string): void => {
      reply.redirect(`/einstellungen?connect=${encodeURIComponent(platform)}&error=${encodeURIComponent(code)}`);
    };

    if (!isPlatformId(platform)) return fail('invalid_platform');
    if (q.error) {
      log.warn(`OAuth abgelehnt (${platform}): ${q.error} ${q.error_description ?? ''}`);
      return fail(q.error);
    }
    if (!q.code || !q.state) return fail('missing_code');

    cleanPending();
    const entry = pending.get(q.state);
    if (!entry || entry.platform !== platform) return fail('state_invalid');
    pending.delete(q.state);

    const user = await getUserById(entry.userId);
    if (!user) return fail('user_gone');

    try {
      if (platform === 'twitch') {
        const tokens = await twitch.exchangeCode(q.code);
        const info = await twitch.me(tokens.accessToken);
        const key = await twitch.getStreamKey(tokens.accessToken, info.id);
        const ingest = await twitch.ingestUrl();
        await upsertAccount({
          userId: user.id,
          platform,
          displayName: info.displayName,
          channelId: info.id,
          channelLogin: info.login,
          connectedVia: 'oauth',
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null,
          scopes: tokens.scopes,
          streamKey: key,
          ingestUrl: ingest,
        });
      } else if (platform === 'youtube') {
        const tokens = await youtube.exchangeCode(q.code);
        const info = await youtube.me(tokens.accessToken);
        await upsertAccount({
          userId: user.id,
          platform,
          displayName: info.displayName,
          channelId: info.id,
          channelLogin: info.login,
          connectedVia: 'oauth',
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null,
          scopes: tokens.scopes,
        });
      } else {
        if (!entry.verifier) return fail('pkce_missing');
        const tokens = await kick.exchangeCode(q.code, entry.verifier);
        const info = await kick.me(tokens.accessToken);
        const channel = await kick.getChannel(tokens.accessToken).catch(() => null);
        const key = await kick.getStreamKey(tokens.accessToken);
        const acc = await upsertAccount({
          userId: user.id,
          platform,
          displayName: channel?.slug ?? info.displayName,
          channelId: channel?.broadcasterUserId ?? info.id,
          channelLogin: channel?.slug ?? info.login,
          connectedVia: 'oauth',
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null,
          scopes: tokens.scopes,
          streamKey: key?.key ?? null,
          ingestUrl: key?.url ?? kick.DEFAULT_INGEST,
          extra: { chatroomId: channel?.chatroomId ?? null, streamKeyViaApi: key !== null },
        });
        const sub = await kick.subscribeEvents(tokens.accessToken);
        await patchExtra(acc.id, { eventsSubscribed: sub.ok > 0 });
      }

      await audit(user.id, 'platform_connected', { platform });
      void chatHub.ensureForUser(user.id);
      reply.redirect(`/einstellungen?connect=${encodeURIComponent(platform)}&ok=1`);
      return;
    } catch (err) {
      log.error(`OAuth fehlgeschlagen (${platform})`, err);
      return fail('exchange_failed');
    }
  });

  app.post('/api/platforms/:platform/manual', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const platform = (req.params as { platform: string }).platform;
    if (!isPlatformId(platform)) throw new BadRequest('invalid_platform');

    const b = body(req.body);
    const streamKey = str(b, 'streamKey', { min: 4, max: 400 });
    const ingestUrl = str(b, 'ingestUrl', { optional: true, max: 400 }) || MANUAL_HINTS[platform].ingestUrl;
    const channelName = str(b, 'channelName', { optional: true, max: 100 });

    if (platform === 'kick' && !ingestUrl.startsWith('rtmps://')) {
      throw new BadRequest('kick_requires_rtmps');
    }
    if (!/^rtmps?:\/\//.test(ingestUrl)) throw new BadRequest('invalid_ingest_url');

    await upsertAccount({
      userId: user.id,
      platform,
      displayName: channelName,
      connectedVia: 'manual',
      streamKey,
      ingestUrl,
    });
    await audit(user.id, 'platform_connected_manual', { platform });
    return { ok: true };
  });

  app.delete('/api/platforms/:platform', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const platform = (req.params as { platform: string }).platform;
    if (!isPlatformId(platform)) throw new BadRequest('invalid_platform');

    if (platform === 'kick') {
      const acc = await getAccount(user.id, platform);
      if (acc && acc.connected_via === 'oauth') {
        const plain = accessToken(acc);
        if (plain) await kick.unsubscribeEvents(plain).catch(() => undefined);
      }
    }

    await relayStopIfRunning(user.id, platform);
    await deleteAccount(user.id, platform);
    await audit(user.id, 'platform_disconnected', { platform });
    return { ok: true };
  });

  // ── Kick-Webhooks (öffentlich, mit Signaturprüfung) ─────────
  app.post('/api/platforms/kick/webhook', async (req, reply) => {
    const messageId = String(req.headers['kick-event-message-id'] ?? '');
    const timestamp = String(req.headers['kick-event-message-timestamp'] ?? '');
    const signature = String(req.headers['kick-event-signature'] ?? '');
    const eventType = String(req.headers['kick-event-type'] ?? '');
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});

    if (messageId === '' || timestamp === '' || signature === '') {
      reply.code(400);
      return { error: 'missing_signature_headers' };
    }

    const valid = await kick.verifyWebhook({ messageId, timestamp, signature, rawBody: raw });
    if (!valid) {
      log.warn('Kick-Webhook mit ungültiger Signatur verworfen.');
      reply.code(401);
      return { error: 'invalid_signature' };
    }

    const payload = (req.body ?? {}) as Record<string, unknown>;
    const broadcaster = (payload.broadcaster ?? {}) as { user_id?: number; channel_slug?: string };
    const broadcasterId = broadcaster.user_id !== undefined ? String(broadcaster.user_id) : '';

    const { one } = await import('../lib/db');
    const row = broadcasterId === ''
      ? null
      : await one<{ user_id: string }>(
          "SELECT user_id FROM platform_accounts WHERE platform = 'kick' AND channel_id = $1",
          [broadcasterId],
        );
    if (!row) {
      reply.code(202);
      return { ok: true, note: 'unknown_channel' };
    }

    const userId = row.user_id;

    if (eventType === 'chat.message.sent') {
      const sender = (payload.sender ?? {}) as {
        user_id?: number;
        username?: string;
        identity?: { username_color?: string; badges?: { type?: string }[] };
      };
      await chatHub.handleKickChat(userId, {
        messageId: String(payload.message_id ?? messageId),
        senderId: sender.user_id !== undefined ? String(sender.user_id) : '',
        senderName: sender.username ?? '',
        color: sender.identity?.username_color ?? '',
        content: String(payload.content ?? ''),
        badges: (sender.identity?.badges ?? []).map((b) => b.type ?? '').filter((b) => b !== ''),
      });
    } else if (eventType === 'channel.followed') {
      const follower = (payload.follower ?? {}) as { username?: string };
      await chatHub.handleKickEvent(userId, {
        type: 'follow',
        actor: follower.username ?? '',
        amount: 1,
        detail: {},
      });
    } else if (eventType.startsWith('channel.subscription')) {
      const subscriber = (payload.subscriber ?? payload.gifter ?? {}) as { username?: string };
      const count = Number((payload.giftees as unknown[] | undefined)?.length ?? 1);
      await chatHub.handleKickEvent(userId, {
        type: eventType.includes('gift') ? 'subgift' : 'sub',
        actor: subscriber.username ?? '',
        amount: Number.isFinite(count) ? count : 1,
        detail: {},
      });
    }

    reply.code(200);
    return { ok: true };
  });
}

async function relayStopIfRunning(userId: string, platform: PlatformId): Promise<void> {
  const { relayManager } = await import('../relay/manager');
  await relayManager.stopPlatform(userId, platform).catch(() => undefined);
}
