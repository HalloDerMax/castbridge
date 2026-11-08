import type { PlatformId } from '../lib/types';

export function BrandMark(): JSX.Element {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#6d5efc" />
      <path
        d="M9 20V12l7 4 7-4v8"
        stroke="#fff"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Twitch({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#9146ff"
        d="M4.3 2 2.5 6.4v14.3h4.9V24h3.3l3.2-3.3h4.1l5.5-5.5V2H4.3zm15.9 12.1-3.1 3.1h-4.9l-2.7 2.7v-2.7H6.1V4.2h14.1v9.9zM16.9 7v5.4h-1.8V7h1.8zm-4.9 0v5.4h-1.8V7H12z"
      />
    </svg>
  );
}

function YouTube({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#ff0033"
        d="M23 7.5s-.2-1.6-.9-2.3c-.9-.9-1.9-.9-2.4-1C17.9 4 12 4 12 4h0s-5.9 0-7.7.2c-.5.1-1.5.1-2.4 1C1.2 5.9 1 7.5 1 7.5S.8 9.4.8 11.3v1.3c0 1.9.2 3.8.2 3.8s.2 1.6.9 2.3c.9.9 2 .9 2.5 1 1.8.2 7.6.2 7.6.2s5.9 0 7.7-.2c.5-.1 1.5-.1 2.4-1 .7-.7.9-2.3.9-2.3s.2-1.9.2-3.8v-1.3c0-1.9-.2-3.8-.2-3.8zM9.8 15.2V8.6l6.3 3.3-6.3 3.3z"
      />
    </svg>
  );
}

function Kick({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#53fc18" d="M3 3h5.4v4.5h2.7V4.8h2.7V3H19v6.3h-2.7v2.7H19V21h-5.2v-1.8h-2.7v-2.7H8.4V21H3V3z" />
    </svg>
  );
}

export function PlatformIcon({ platform, size = 18 }: { platform: PlatformId; size?: number }): JSX.Element {
  if (platform === 'twitch') return <Twitch size={size} />;
  if (platform === 'youtube') return <YouTube size={size} />;
  return <Kick size={size} />;
}

export function Gear({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function Star({ filled, size = 15 }: { filled: boolean; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m12 3.5 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17.3l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8L12 3.5z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Check({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 13 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function Cross({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}

export function Info({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 11v5.5M12 7.8v.3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}
