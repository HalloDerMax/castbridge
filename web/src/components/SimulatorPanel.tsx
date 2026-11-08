import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { PLATFORMS, PLATFORM_NAME, type PlatformId, type SimResult, type SimRun, type SimScenario } from '../lib/types';
import { Chart } from './Chart';

interface ScenarioResponse {
  scenarios: SimScenario[];
  defaults: { baseViewers: number; magnitude: number; durationMin: number; chatterRatio: number };
  thresholds: Record<string, number>;
  note: string;
}

interface AdminUser {
  id: string;
  email: string;
}

const VERDICT_CLASS: Record<string, string> = {
  detected: 'ok',
  clean: 'ok',
  partial: 'warn',
  missed: 'err',
  false_positive: 'err',
};

export function SimulatorPanel({ users }: { users: AdminUser[] }): JSX.Element {
  const { t, lang } = useI18n();

  const [meta, setMeta] = useState<ScenarioResponse | null>(null);
  const [runs, setRuns] = useState<SimRun[]>([]);
  const [result, setResult] = useState<SimResult | null>(null);
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showThresholds, setShowThresholds] = useState(false);

  const [scenario, setScenario] = useState('sudden_spike');
  const [userId, setUserId] = useState('');
  const [platform, setPlatform] = useState<PlatformId>('twitch');
  const [mode, setMode] = useState<'offline' | 'live'>('offline');
  const [baseViewers, setBaseViewers] = useState(40);
  const [magnitude, setMagnitude] = useState(300);
  const [durationMin, setDurationMin] = useState(45);
  const [chatterRatio, setChatterRatio] = useState(0.06);
  const [seed, setSeed] = useState('');

  const loadRuns = useCallback(async () => {
    const res = await api.get<{ runs: SimRun[] }>('/api/admin/sim/runs');
    setRuns(res.runs);
    const live = res.runs.find((r) => r.mode === 'live' && r.state === 'running');
    setLiveRunId(live ? live.id : null);
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await api.get<ScenarioResponse>('/api/admin/sim/scenarios');
      setMeta(res);
      setBaseViewers(res.defaults.baseViewers);
      setMagnitude(res.defaults.magnitude);
      setDurationMin(res.defaults.durationMin);
      setChatterRatio(res.defaults.chatterRatio);
      await loadRuns();
    })();
  }, [loadRuns]);

  useEffect(() => {
    if (users.length > 0 && userId === '') setUserId(users[0].id);
  }, [users, userId]);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ mode: string; result?: SimResult; runId?: string }>('/api/admin/sim/run', {
        userId,
        scenario,
        platform,
        mode,
        baseViewers,
        magnitude,
        durationMin,
        chatterRatio,
        seed: seed === '' ? undefined : Number(seed),
      });
      if (res.result) setResult(res.result);
      if (res.runId) setLiveRunId(res.runId);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const stopLive = async (): Promise<void> => {
    if (!liveRunId) return;
    await api.post(`/api/admin/sim/${liveRunId}/stop`);
    setLiveRunId(null);
    await loadRuns();
  };

  const openRun = async (id: string): Promise<void> => {
    const res = await api.get<{
      run: SimRun;
      samples: { at: string; viewers: number; chatters: number }[];
      hints: { type: string; at: string; score: number; detail: Record<string, unknown> }[];
    }>(`/api/admin/sim/${id}`);
    setResult({
      runId: res.run.id,
      sessionId: res.run.sessionId,
      scenario: res.run.scenario,
      expected: res.run.expected,
      detected: res.run.detected,
      verdict: res.run.verdict,
      hints: res.hints,
      samples: res.samples,
    });
  };

  const deleteRun = async (id: string): Promise<void> => {
    await api.del(`/api/admin/sim/${id}`);
    if (result?.runId === id) setResult(null);
    await loadRuns();
  };

  const current = meta?.scenarios.find((s) => s.id === scenario) ?? null;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2 style={{ margin: 0 }}>{t('sim.title')}</h2>
          {liveRunId ? <span className="pill sim">{t('sim.running')}</span> : null}
        </div>
        <p>{t('sim.explain')}</p>
        <div className="notice info small mb">{t('sim.dataNote')}</div>

        <div className="grid cols-2">
          <label className="field">
            <span className="label">{t('sim.scenario')}</span>
            <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {(meta?.scenarios ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {t(`sim.scenario.${s.id}`)}
                </option>
              ))}
            </select>
            {current ? (
              <div className="hint">
                {current.description}
                <br />
                <strong>{t('sim.expected')}:</strong>{' '}
                {current.expected.length === 0
                  ? t('anom.none')
                  : current.expected.map((e) => t(`anom.${e}`)).join(', ')}
              </div>
            ) : null}
          </label>

          <label className="field">
            <span className="label">{t('sim.user')}</span>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="label">{t('common.platform')}</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value as PlatformId)}>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_NAME[p]}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="label">{t('sim.mode')}</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'offline' | 'live')}>
              <option value="offline">{t('sim.modeOffline')}</option>
              <option value="live">{t('sim.modeLive')}</option>
            </select>
            {mode === 'live' ? <div className="hint">{t('sim.modeLiveHint')}</div> : null}
          </label>

          <label className="field">
            <span className="label">
              {t('sim.baseViewers')}: {baseViewers}
            </span>
            <input
              type="range"
              min={0}
              max={2000}
              step={5}
              value={baseViewers}
              onChange={(e) => setBaseViewers(Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span className="label">
              {t('sim.magnitude')}: {magnitude}
            </span>
            <input
              type="range"
              min={5}
              max={20000}
              step={5}
              value={magnitude}
              onChange={(e) => setMagnitude(Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span className="label">
              {t('sim.duration')}: {durationMin}
            </span>
            <input
              type="range"
              min={5}
              max={360}
              step={5}
              value={durationMin}
              onChange={(e) => setDurationMin(Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span className="label">
              {t('sim.chatterRatio')}: {(chatterRatio * 100).toFixed(1)} %
            </span>
            <input
              type="range"
              min={0}
              max={0.3}
              step={0.005}
              value={chatterRatio}
              onChange={(e) => setChatterRatio(Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span className="label">
              {t('sim.seed')} <span className="muted small">({t('common.optional')})</span>
            </span>
            <input type="number" value={seed} min={1} onChange={(e) => setSeed(e.target.value)} />
          </label>
        </div>

        {error ? <div className="notice err small mb">{error}</div> : null}

        <div className="row">
          <button className="primary" onClick={() => void run()} disabled={busy || userId === ''}>
            {busy ? <span className="spin" /> : null}
            {t('sim.run')}
          </button>
          {liveRunId ? (
            <button className="danger" onClick={() => void stopLive()}>
              {t('sim.stop')}
            </button>
          ) : null}
          <span className="spacer" />
          <button className="ghost sm" onClick={() => setShowThresholds((v) => !v)}>
            {t('sim.thresholds')} {showThresholds ? '−' : '+'}
          </button>
        </div>

        {showThresholds && meta ? (
          <div className="table-wrap mt">
            <table>
              <tbody>
                {Object.entries(meta.thresholds).map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono small">{k}</td>
                    <td className="mono small">{String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {result ? (
        <div className="card">
          <div className="card-head">
            <h2 style={{ margin: 0 }}>
              {t('sim.verdict')}: {t(`sim.verdict.${result.verdict}`)}
            </h2>
            <span className={`pill ${VERDICT_CLASS[result.verdict] ?? ''}`}>
              {t(`sim.scenario.${result.scenario}`)}
            </span>
          </div>

          <div className={`notice ${VERDICT_CLASS[result.verdict] ?? 'info'} mb`}>
            {t(`sim.verdictHint.${result.verdict}`)}
          </div>

          <div className="grid cols-2 mb">
            <div>
              <div className="small muted">{t('sim.expected')}</div>
              <div>
                {result.expected.length === 0
                  ? t('anom.none')
                  : result.expected.map((e) => t(`anom.${e}`)).join(', ')}
              </div>
            </div>
            <div>
              <div className="small muted">{t('sim.detected')}</div>
              <div>
                {result.detected.length === 0
                  ? t('anom.none')
                  : result.detected.map((e) => t(`anom.${e}`)).join(', ')}
              </div>
            </div>
          </div>

          <h3>{t('sim.curve')}</h3>
          <Chart
            lang={lang}
            height={200}
            series={[
              {
                label: t('dash.viewersTotal'),
                color: '#6d5efc',
                points: result.samples.map((s) => ({ at: s.at, value: s.viewers, synthetic: true })),
              },
              {
                label: t('stats.chatters'),
                color: '#22c55e',
                points: result.samples.map((s) => ({ at: s.at, value: s.chatters })),
              },
            ]}
            markers={result.hints.map((h) => ({ at: h.at, label: t(`anom.${h.type}`) }))}
            emptyText={t('stats.noData')}
          />

          {result.hints.length > 0 ? (
            <div className="mt">
              {result.hints.map((h, i) => (
                <div key={i} className="notice warn small" style={{ marginBottom: 6 }}>
                  <strong>{t(`anom.${h.type}`)}</strong>{' '}
                  <span className="muted">
                    {fmtDateTime(h.at, lang)} · {t('anom.score')} {h.score.toFixed(2)}
                  </span>
                  <div className="mono small muted" style={{ wordBreak: 'break-all' }}>
                    {Object.entries(h.detail)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2 style={{ margin: 0 }}>{t('sim.runs')}</h2>
          <button className="ghost sm" onClick={() => void loadRuns()}>
            {t('common.refresh')}
          </button>
        </div>
        {runs.length === 0 ? (
          <p className="small">{t('sim.noRuns')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('sim.scenario')}</th>
                  <th>{t('sim.user')}</th>
                  <th>{t('sim.mode')}</th>
                  <th>{t('sim.verdict')}</th>
                  <th>{t('stats.from')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{t(`sim.scenario.${r.scenario}`)}</td>
                    <td className="small">{r.email}</td>
                    <td className="small">{r.mode === 'live' ? t('sim.modeLive') : t('sim.modeOffline')}</td>
                    <td>
                      <span className={`pill ${VERDICT_CLASS[r.verdict] ?? ''}`}>
                        {r.verdict === '' ? r.state : t(`sim.verdict.${r.verdict}`)}
                      </span>
                    </td>
                    <td className="small">{fmtDateTime(r.startedAt, lang)}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <button className="ghost sm" onClick={() => void openRun(r.id)}>
                          {t('common.show')}
                        </button>
                        <button
                          className="ghost sm"
                          title={t('sim.deleteRun')}
                          onClick={() => void deleteRun(r.id)}
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
