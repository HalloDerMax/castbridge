/** Bekannte Chat-Bots. Wird im Tool als Liste angezeigt, damit klar ist,
 *  wen der Haken "Bots ausblenden" trifft. */
export const KNOWN_BOTS = [
  'nightbot',
  'streamelements',
  'streamlabs',
  'moobot',
  'fossabot',
  'wizebot',
  'botisimo',
  'phantombot',
  'deepbot',
  'ankhbot',
  'coebot',
  'scorpbot',
  'sery_bot',
  'commanderroot',
  'soundalerts',
  'own3d',
  'kofistreambot',
  'tipeeebot',
  'botrixoficial',
  'botrix',
  'kickbot',
] as const;

const KNOWN = new Set<string>(KNOWN_BOTS);

export function isBot(author: string, custom: string[] = []): boolean {
  const name = author.trim().toLowerCase();
  if (name === '') return false;
  if (KNOWN.has(name)) return true;
  for (const c of custom) {
    if (c.trim().toLowerCase() === name) return true;
  }
  return false;
}
