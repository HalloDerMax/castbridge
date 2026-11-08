import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { fmtDateTime, fmtDuration, fmtNumber, fmtTime } from '../lib/format';
import {
  PLATFORM_COLOR,
  PLATFORM_NAME,
  type PlatformId,
  type SessionListItem,
  type StatsReport,
} from '../lib/types';
import { Chart, type ChartSeries } from '../components/Chart';

function isoDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function StatsPage(): JSX.Element {
  const { t, lang } = useI18n();

  const [scope, setScope] = useState<'session' | 'range'>('range');
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [from, setFrom] = useState(isoDay(-30));
  const [to, setTo] = useState(isoDay(0));
  const [report, setReport] = useState<StatsReport | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ sessions: SessionListItem[] }>('/api/stats/sessions');
      setSessions(res.sessions);
      if (res.sessions.length > 0) setSessionId(res.sessions[0].id);
    })();
  }, []);

  const query = useCallback((): string => {
    if (scope === 'session') return `session=${encodeURIComponent(sessionId)}`;
    const toEnd = new Date(`${to}T23:59:59`);
    return `from=${encodeURIComponent(new Date(`${from}T00:00:00`).toISOString())}&to=${encodeURIComponent(
      toEnd.toISOString(),
    )}`;
  }, [scope, sessionId, from, to]);

  const load = useCallback(async () => {
    if (scope === 'session' && sessionId === '') return;
    setLoading(true);
    try {
      const res = await api.get<{ report: StatsReport }>(`/api/stats/report?${query()}`);
      setReport(res.report);
    } catch {
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [query, scope, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const series: ChartSeries[] = (report?.perPlatform ?? []).map((p) => ({
    label: PLATFORM_NAME[p.platform],
    color: PLATFORM_COLOR[p.platform],
    points: p.series.map((s) => ({ at: s.at, value: s.viewers, synthetic: s.synthetic })),
  }));

  const markers = (report?.anomalies ?? []).map((a) => ({
    at: a.at,
    label: `${t(`anom.${a.type}`)} (${PLATFORM_NAME[a.platform]})`,
  }));

  return (
    <>
      <div className="page-head">
        <h1>{t('stats.title')}</h1>
        {report ? (
          <div className="row">
            <a className="btn" href={`/api/stats/export.csv?${query()}`}>
              {t('stats.exportCsv')}
            </a>
            <a className="btn primary" href={`/api/stats/export.pdf?${query()}`}>
              {t('stats.exportPdf')}
            </a>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="row">
          <button className={scope === 'range' ? 'primary' : ''} onClick={() => setScope('range')}>
            {t('stats.scopeRange')}
          </button>
          <button className={scope === 'session' ? 'primary' : ''} onClick={() => setScope('session')}>
            {t('stats.scopeSession')}
          </button>
          <span className="spacer" />
          <button onClick={() => void load()} disabled={loading}>
            {loading ? <span className="spin" /> : null}
            {t('common.refresh')}
          </button>
        </div>

        <div className="sep" />

        {scope === 'range' ? (
          <div className="grid cols-2">
            <label className="field" style={{ marginBottom: 0 }}>
              <span className="label">{t('stats.from')}</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span className="label">{t('stats.to')}</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        ) : (
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="label">{t('stats.sessions')}</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              {sessions.length === 0 ? <option value="">{t('common.none')}</option> : null}
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {fmtDateTime(s.startedAt, lang)} · {fmtDuration(s.durationMin)} · {s.peakViewers} ·{' '}
                  {s.platforms.map((p) => PLATFORM_NAME[p]).join(', ') || '—'}
                  {s.hasSimulation ? ' · SIM' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="hint">{t('stats.onlyWhenStreamedHere')}</div>
      </div>

      {!report || report.perPlatform.length === 0 ? (
        <div className="card">
          <p>{t('stats.noData')}</p>
        </div>
      ) : (
        <>
          {report.hasSimulation ? <div className="notice warn mb">{t('stats.containsSimulation')}</div> : null}

          <div className="grid cols-3">
            <div className="card">
              <div className="metric">
                {fmtDuration(report.durationMin)}
                <small>{t('stats.duration')}</small>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                {fmtNumber(report.totalPeak, lang)}
                <small>{t('stats.peak')}</small>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                {fmtNumber(report.totalAverage, lang)}
                <small>{t('stats.average')}</small>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                {fmtNumber(report.messages, lang)}
                <small>
                  {t('stats.messages')} · {report.messagesPerMinute} {t('stats.perMinute')}
                </small>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                {fmtNumber(report.chatters, lang)}
                <small>{t('stats.chatters')}</small>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                {fmtNumber(report.events.subs + report.events.resubs + report.events.giftSubs, lang)}
                <small>{t('stats.subs')}</small>
              </div>
            </div>
          </div>

          <div className="card mt">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{t('stats.viewersOverTime')}</h2>
              <span className="small muted">{report.label}</span>
            </div>
            <Chart series={series} markers={markers} lang={lang} emptyText={t('stats.noData')} height={240} />
          </div>

          <div className="card">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{t('stats.perPlatform')}</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('common.platform')}</th>
                    <th>{t('stats.peak')}</th>
                    <th>{t('stats.average')}</th>
                    <th>{t('stats.samples')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.perPlatform.map((p) => (
                    <tr key={p.platform}>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          <i
                            style={{
                              width: 9,
                              height: 9,
                              borderRadius: 3,
                              background: PLATFORM_COLOR[p.platform],
                              display: 'inline-block',
                            }}
                          />
                          {PLATFORM_NAME[p.platform]}
                        </span>
                      </td>
                      <td>{fmtNumber(p.peak, lang)}</td>
                      <td>{fmtNumber(p.average, lang)}</td>
                      <td>
                        {p.samples}
                        {p.syntheticSamples > 0 ? (
                          <span className="muted small"> ({p.syntheticSamples} sim.)</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h2>{t('stats.events')}</h2>
              <dl className="kv">
                <dt>{t('stats.subs')}</dt>
                <dd>{report.events.subs}</dd>
                <dt>{t('stats.resubs')}</dt>
                <dd>{report.events.resubs}</dd>
                <dt>{t('stats.giftSubs')}</dt>
                <dd>{report.events.giftSubs}</dd>
                <dt>{t('stats.follows')}</dt>
                <dd>{report.events.follows}</dd>
                <dt>{t('stats.raids')}</dt>
                <dd>{report.events.raids}</dd>
                <dt>{t('stats.members')}</dt>
                <dd>{report.events.members}</dd>
                <dt>{t('stats.superChats')}</dt>
                <dd>
                  {report.events.superChats}
                  {report.events.superChatAmount > 0 ? ` (${report.events.superChatAmount})` : ''}
                </dd>
              </dl>
            </div>

            <div className="card">
              <div className="card-head">
                <h2 style={{ margin: 0 }}>{t('anom.title')}</h2>
              </div>
              <p className="small">{t('anom.explain')}</p>
              {report.anomalies.length === 0 ? (
                <div className="notice ok small">{t('anom.none')}</div>
              ) : (
                report.anomalies.map((a) => (
                  <div key={a.id} className="notice warn small" style={{ marginBottom: 7 }}>
                    <div className="row between">
                      <strong>{t(`anom.${a.type}`)}</strong>
                      <span className="pill">
                        {a.fromSimulation ? t('anom.fromSimulation') : t('anom.fromMeasurement')}
                      </span>
                    </div>
                    <div className="muted">
                      {fmtTime(a.at, lang)} · {PLATFORM_NAME[a.platform as PlatformId]} · {t('anom.score')}{' '}
                      {a.score.toFixed(2)}
                    </div>
                    <div className="mono small muted" style={{ marginTop: 4, wordBreak: 'break-all' }}>
                      {Object.entries(a.detail)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(' · ')}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
