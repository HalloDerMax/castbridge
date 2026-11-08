export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  scopes: string;
}

export interface ChannelInfo {
  id: string;
  login: string;
  displayName: string;
}

export interface CategoryHit {
  id: string;
  name: string;
  image?: string;
}

/** Was eine Plattform im Tool wirklich kann - ehrlich, nicht gewünscht. */
export interface Capability {
  oauth: boolean;
  streamKeyViaApi: boolean;
  setTitle: boolean;
  setCategory: boolean;
  categoryMode: 'full' | 'gaming_only' | 'none';
  chat: boolean;
  viewers: boolean;
  events: boolean;
}
