import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { PLATFORM_NAME, type PlatformId, type PlatformStatus } from '../lib/types';
import { PlatformIcon, Star } from './icons';

interface Suggestion {
  title: string;
  pinned: boolean;
  lastUsedAt: string;
}

interface CategoryHit {
  id: string;
  name: string;
  image?: string;
}

interface ApplyResult {
  platform: PlatformId;
  ok: boolean;
  code?: string;
  detail?: string;
}

interface Props {
  platforms: PlatformStatus[];
  initialShared: string;
  initialPer: Partial<Record<PlatformId, string>>;
  initialCategory: string;
}

export function TitleEditor({ platforms, initialShared, initialPer, initialCategory }: Props): JSX.Element {
  const { t } = useI18n();
  const connected = platforms.filter((p) => p.connected);

  const [shared, setShared] = useState(initialShared);
  const [applyToAll, setApplyToAll] = useState(true);
  const [per, setPer] = useState<Partial<Record<PlatformId, string>>>(initialPer);
  const [open, setOpen] = useState<Partial<Record<PlatformId, boolean>>>({});

  const [category, setCategory] = useState(initialCategory);
  const [categoryIds, setCategoryIds] = useState<Partial<Record<PlatformId, string>>>({});
  const [catHits, setCatHits] = useState<CategoryHit[]>([]);
  const [catOpen, setCatOpen] = useState(false);

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [sugOpen, setSugOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ApplyResult[] | null>(null);

  const sugBox = useRef<HTMLDivElement | null>(null);
  const catBox = useRef<HTMLDivElement | null>(null);

  const loadSuggestions = useCallback(async (q: string) => {
    try {
      const res = await api.get<{ suggestions: Suggestion[] }>(
        `/api/stream/titles/suggestions?q=${encodeURIComponent(q)}`,
      );
      setSuggestions(res.suggestions);
    } catch {
      setSuggestions([]);
    }
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (sugBox.current && !sugBox.current.contains(e.target as Node)) setSugOpen(false);
      if (catBox.current && !catBox.current.contains(e.target as Node)) setCatOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const searchCategory = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setCatHits([]);
        return;
      }
      const source = connected.find((p) => p.platform === 'twitch' && p.connectedVia === 'oauth')
        ? 'twitch'
        : connected.find((p) => p.platform === 'kick' && p.connectedVia === 'oauth')
          ? 'kick'
          : null;
      if (!source) {
        setCatHits([]);
        return;
      }
      try {
        const res = await api.get<{ results: CategoryHit[] }>(
          `/api/stream/categories?platform=${source}&q=${encodeURIComponent(q)}`,
        );
        setCatHits(res.results);
        setCatOpen(res.results.length > 0);
      } catch {
        setCatHits([]);
      }
    },
    [connected],
  );

  /** Ein gewähltes Spiel auf alle Plattformen übertragen, die das können. */
  const pickCategory = async (hit: CategoryHit): Promise<void> => {
    setCategory(hit.name);
    setCatOpen(false);
    const ids: Partial<Record<PlatformId, string>> = {};

    for (const p of connected) {
      if (p.connectedVia !== 'oauth') continue;
      if (p.capabilities.categoryMode === 'gaming_only') {
        ids[p.platform] = 'gaming';
        continue;
      }
      if (p.capabilities.categoryMode !== 'full') continue;
      try {
        const res = await api.get<{ results: CategoryHit[] }>(
          `/api/stream/categories?platform=${p.platform}&q=${encodeURIComponent(hit.name)}`,
        );
        const match =
          res.results.find((r) => r.name.toLowerCase() === hit.name.toLowerCase()) ?? res.results[0];
        if (match) ids[p.platform] = match.id;
      } catch {
        /* diese Plattform überspringen */
      }
    }
    setCategoryIds(ids);
  };

  const apply = async (): Promise<void> => {
    setBusy(true);
    setResults(null);
    try {
      const res = await api.post<{ results: ApplyResult[] }>('/api/stream/titles', {
        shared,
        applyToAll,
        perPlatform: per,
        categoryIds,
        category,
      });
      setResults(res.results);
      void loadSuggestions('');
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (s: Suggestion): Promise<void> => {
    await api.post('/api/stream/titles/pin', { title: s.title, pinned: !s.pinned });
    void loadSuggestions('');
  };

  const youtubeConnected = connected.some((p) => p.platform === 'youtube');

  return (
    <div className="card">
      <div className="card-head">
        <h2 style={{ margin: 0 }}>{t('title.title')}</h2>
      </div>

      <div className="suggest-wrap" ref={sugBox}>
        <label className="field" style={{ marginBottom: 0 }}>
          <span className="label">{t('title.shared')}</span>
          <input
            type="text"
            value={shared}
            placeholder={t('title.sharedPlaceholder')}
            maxLength={200}
            onChange={(e) => {
              setShared(e.target.value);
              void loadSuggestions(e.target.value);
              setSugOpen(true);
            }}
            onFocus={() => {
              void loadSuggestions(shared);
              setSugOpen(true);
            }}
          />
        </label>
        {sugOpen && suggestions.length > 0 ? (
          <div className="suggest">
            <div className="small muted" style={{ padding: '6px 10px' }}>
              {t('title.suggestions')}
            </div>
            {suggestions.map((s) => (
              <div
                key={s.title}
                className="suggest-item"
                onClick={() => {
                  setShared(s.title);
                  setSugOpen(false);
                }}
              >
                <button
                  type="button"
                  className={`star${s.pinned ? ' on' : ''}`}
                  title={s.pinned ? t('title.unpin') : t('title.pin')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void togglePin(s);
                  }}
                >
                  <Star filled={s.pinned} />
                </button>
                <span style={{ flex: 1 }}>{s.title}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <label className="check mt">
        <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
        <div>
          <span className="label">{t('title.shared')}</span>
          <div className="hint">{t('title.perPlatform')}</div>
        </div>
      </label>

      {connected.map((p) => (
        <div key={p.platform} style={{ marginBottom: 8 }}>
          <button
            className="ghost"
            onClick={() => setOpen((o) => ({ ...o, [p.platform]: !o[p.platform] }))}
            style={{ width: '100%', justifyContent: 'flex-start' }}
          >
            <PlatformIcon platform={p.platform} size={15} />
            {PLATFORM_NAME[p.platform]}
            <span className="spacer" />
            <span className="small muted">{open[p.platform] ? '−' : '+'}</span>
          </button>
          {open[p.platform] ? (
            <label className="field" style={{ marginTop: 6 }}>
              <input
                type="text"
                value={per[p.platform] ?? ''}
                placeholder={shared}
                maxLength={200}
                onChange={(e) => setPer((v) => ({ ...v, [p.platform]: e.target.value }))}
              />
              {!p.capabilities.setTitle ? <div className="hint">{t('err.not_connected_oauth')}</div> : null}
            </label>
          ) : null}
        </div>
      ))}

      <div className="sep" />

      <div className="suggest-wrap" ref={catBox}>
        <label className="field" style={{ marginBottom: 0 }}>
          <span className="label">{t('title.category')}</span>
          <input
            type="text"
            value={category}
            placeholder={t('title.categorySearch')}
            onChange={(e) => {
              setCategory(e.target.value);
              void searchCategory(e.target.value);
            }}
          />
        </label>
        {catOpen && catHits.length > 0 ? (
          <div className="suggest">
            {catHits.map((hit) => (
              <div key={hit.id} className="suggest-item" onClick={() => void pickCategory(hit)}>
                {hit.image ? (
                  <img src={hit.image} alt="" width={22} height={30} style={{ borderRadius: 3 }} />
                ) : null}
                <span>{hit.name}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {youtubeConnected ? <div className="notice info small mt">{t('title.youtubeCategoryNote')}</div> : null}

      <button className="primary mt" onClick={() => void apply()} disabled={busy}>
        {busy ? <span className="spin" /> : null}
        {t('title.apply')}
      </button>

      {results !== null ? (
        <div className="mt">
          {results.length === 0 ? (
            <div className="notice err small">{t('common.error')}</div>
          ) : (
            results.map((r) => (
              <div key={r.platform} className={`notice small ${r.ok ? 'ok' : 'warn'}`} style={{ marginBottom: 6 }}>
                {r.ok
                  ? t('title.resultOk', { name: PLATFORM_NAME[r.platform] })
                  : t('title.resultFail', {
                      name: PLATFORM_NAME[r.platform],
                      code: t(`err.${r.code ?? 'api_error'}`),
                    })}
                {r.ok && r.code === 'youtube_category_gaming_only' ? (
                  <div className="hint">{t('title.youtubeCategoryNote')}</div>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
