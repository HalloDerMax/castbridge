import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { audit, requireUser, type AuthedRequest } from '../lib/auth';
import { bus } from '../lib/bus';
import { getUserByOverlayToken, mergeSettings, rotateOverlayToken, updateSettings } from '../lib/users';
import { body, bool, int, oneOf, str } from '../lib/validate';
import { chatHub } from '../chat/hub';
import { defaultOverlaySettings, type OverlaySettings } from '../types';

function parseOverlay(raw: Record<string, unknown>): OverlaySettings {
  return {
    fontFamily: str(raw, 'fontFamily', { optional: true, max: 60 }) || defaultOverlaySettings.fontFamily,
    fontSize: int(raw, 'fontSize', { min: 10, max: 72, fallback: defaultOverlaySettings.fontSize }),
    messageLifetimeSec: int(raw, 'messageLifetimeSec', { min: 0, max: 600, fallback: 0 }),
    maxMessages: int(raw, 'maxMessages', { min: 1, max: 100, fallback: defaultOverlaySettings.maxMessages }),
    transparent: bool(raw, 'transparent', true),
    backgroundColor: str(raw, 'backgroundColor', { optional: true, max: 20 }) || defaultOverlaySettings.backgroundColor,
    backgroundOpacity: Math.min(1, Math.max(0, Number(raw.backgroundOpacity ?? defaultOverlaySettings.backgroundOpacity))),
    showPlatformIcons: bool(raw, 'showPlatformIcons', true),
    useAuthorColors: bool(raw, 'useAuthorColors', true),
    textColor: str(raw, 'textColor', { optional: true, max: 20 }) || defaultOverlaySettings.textColor,
    shadow: bool(raw, 'shadow', true),
    direction: oneOf(raw, 'direction', ['up', 'down'] as const, 'up'),
    animation: oneOf(raw, 'animation', ['none', 'fade', 'slide'] as const, 'fade'),
    hideBots: bool(raw, 'hideBots', false),
  };
}

export async function overlayRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/overlay/settings', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const settings = mergeSettings(user.settings);
    return {
      settings: settings.overlay,
      url: `${config.publicUrl}/overlay/${user.overlay_token}`,
      token: user.overlay_token,
      fonts: ['Inter', 'Roboto', 'Open Sans', 'Montserrat', 'Nunito', 'Fira Sans', 'system-ui'],
    };
  });

  app.post('/api/overlay/settings', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const overlay = parseOverlay(body(req.body));
    await updateSettings(user.id, { overlay });
    // Offene Overlays sofort mitziehen, ohne dass OBS neu laden muss.
    bus.publish(user.id, { type: 'overlay:settings', settings: overlay });
    return { settings: overlay };
  });

  app.post('/api/overlay/token/rotate', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const token = await rotateOverlayToken(user.id);
    await audit(user.id, 'overlay_token_rotated');
    return { token, url: `${config.publicUrl}/overlay/${token}` };
  });

  /** Öffentlich, aber nur mit gültigem Token: Startzustand für die Browserquelle. */
  app.get('/api/overlay/:token/config', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const user = await getUserByOverlayToken(token);
    if (!user || user.is_blocked) {
      reply.code(404);
      return { error: 'unknown_token' };
    }
    const settings = mergeSettings(user.settings);
    return {
      settings: settings.overlay,
      messages: chatHub.recent(user.id, Math.min(settings.overlay.maxMessages, 50), settings.overlay.hideBots),
    };
  });
}
