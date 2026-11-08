import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { fmtBytes, fmtDateTime, fmtNumber, fmtSeconds } from '../lib/format';
import { PLATFORM_NAME, type AdminOverview, type PlatformId } from '../lib/types';
import { SimulatorPanel } from '../components/SimulatorPanel';
import { CopyField } from '../components/CopyField';

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  isBlocked: boolean;
  language: string;
  wizardDone: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  live: boolean;
}

interface Invite {
  id: string;
  note: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  createdBy: string | null;
  createdAt: string;
}

type Tab = 'overview' | 'users' | 'invites' | 'sim' | 'audit';

export function AdminPage(): JSX.Element {
  const { t, lang } = useI18n();
  const { user } = useSession();

  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [audit, setAudit] = useState<{ id: number; action: string; email: string | null; at: string }[]>([]);

  const [newInviteUrl, setNewInviteUrl] = useState<string | null>(null);
  const [inviteNote, setInviteNote] = useState('');
  const [inviteDays, setInviteDays] = useState(7);
  const [limit, setLimit] = useState(3);
  const [busy, setBusy] = useState(false);

  const loadOverview = useCallback(async () => {
    const res = await api.get<AdminOverview>('/api/admin/overview');
    setOverview(res);
    setLimit(res.limits.maxConcurrentStreams);
  }, []);

  const loadUsers = useCallback(async () => {
    const res = await api.get<{ users: AdminUser[] }>('/api/admin/users');
    setUsers(res.users);
  }, []);

  const loadInvites = useCallback(async () => {
    const res = await api.get<{ invites: Invite[] }>('/api/admin/invites');
    setInvites(res.invites);
  }, []);

  useEffect(() => {
    void loadOverview();
    void loadUsers();
  }, [loadOverview, loadUsers]);

  useEffect(() => {
    if (tab === 'overview') {
      const timer = window.setInterval(() => void loadOverview(), 10_000);
      return () => window.clearInterval(timer);
    }
    if (tab === 'invites') void loadInvites();
    if (tab === 'audit') {
      void api
        .get<{ entries: { id: number; action: string; email: string | null; at: string }[] }>('/api/admin/audit')
        .then((res) => setAudit(res.entries));
    }
    return undefined;
  }, [tab, loadOverview, loadInvites]);

  const createInvite = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.post<{ url: string }>('/api/admin/invites', {
        note: inviteNote,
        validDays: inviteDays,
      });
      setNewInviteUrl(res.url);
      setInviteNote('');
      await loadInvites();
    } finally {
      setBusy(false);
    }
  };

  const saveLimit = async (): Promise<void> => {
    await api.post('/api/admin/limits', { maxConcurrentStreams: limit });
    await loadOverview();
  };

  const toggleBlock = async (u: AdminUser): Promise<void> => {
    await api.post(`/api/admin/users/${u.id}/block`, { blocked: !u.isBlocked });
    await loadUsers();
  };

  const removeUser = async (u: AdminUser): Promise<void> => {
    if (!window.confirm(t('admin.userDeleteConfirm', { email: u.email }))) return;
    await api.del(`/api/admin/users/${u.id}`);
    await loadUsers();
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: t('admin.overview') },
    { id: 'users', label: t('admin.users') },
    { id: 'invites', label: t('admin.invites') },
    { id: 'sim', label: t('admin.sim') },
    { id: 'audit', label: t('admin.audit') },
  ];

  return (
    <>
      <div className="page-head">
        <h1>{t('admin.title')}</h1>
        <div className="row">
          {TABS.map((x) => (
            <button key={x.id} className={tab === x.id ? 'primary' : ''} onClick={() => setTab(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && overview ? (
        <>
          <div className="grid cols-3">
            <div className="card">
              <div className="metric">
                {overview.limits.currentlyLive} / {overview.limits.maxConcurrentStreams}
                <small>{t('admin.liveNow')}</small>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                {overview.users.total}
                <small>
                  {t('admin.users')}
                  {overview.users.blocked > 0 ? ` · ${overview.users.blocked} ${t('admin.blocked')}` : ''}
                </small>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                {overview.server.trafficThisMonthGb} GB
                <small>
                  {t('admin.traffic')} · {t('admin.trafficNote')}
                </small>
              </div>
            </div>
          </div>

          <div className="card mt">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{t('admin.liveNow')}</h2>
              <button className="ghost sm" onClick={() => void loadOverview()}>
                {t('common.refresh')}
              </button>
            </div>
            {overview.live.length === 0 ? (
              <p className="small">{t('admin.nobodyLive')}</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('login.email')}</th>
                      <th>{t('dash.bitrate')}</th>
                      <th>{t('dash.resolution')}</th>
                      <th>{t('platforms.title')}</th>
                      <th>{t('dash.diagSource')}</th>
                      <th>{t('dash.messagesPerMin')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.live.map((l) => (
                      <tr key={l.userId}>
                        <td>
                          {l.email}
                          {l.simulationActive ? <span className="pill sim" style={{ marginLeft: 6 }}>SIM</span> : null}
                        </td>
                        <td>{l.signal.bitrateKbps !== null ? `${l.signal.bitrateKbps} kbps` : '–'}</td>
                        <td>{l.signal.width ? `${l.signal.width}×${l.signal.height}` : '–'}</td>
                        <td>
                          {l.platforms.length === 0
                            ? '–'
                            : l.platforms
                                .map((p) => `${PLATFORM_NAME[p.platform as PlatformId]} (${t(`state.${p.state}`)})`)
                                .join(', ')}
                        </td>
                        <td>{l.diagnostics?.source ?? '–'}</td>
                        <td>{l.chat.messagesPerMinute}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="dash mt">
            <div className="card">
              <h2>{t('admin.server')}</h2>
              <dl className="kv">
                <dt>{t('admin.cpu')}</dt>
                <dd>
                  {overview.server.loadAverage.map((n) => n.toFixed(2)).join(' / ')} ({overview.server.cpus} Kerne)
                </dd>
                <dt>{t('admin.memory')}</dt>
                <dd>
                  {fmtBytes(overview.server.memory.total - overview.server.memory.free)} /{' '}
                  {fmtBytes(overview.server.memory.total)}
                </dd>
                <dt>{t('admin.disk')}</dt>
                <dd>
                  {overview.server.disk
                    ? `${fmtBytes(overview.server.disk.total - overview.server.disk.free)} / ${fmtBytes(
                        overview.server.disk.total,
                      )}`
                    : '–'}
                </dd>
                <dt>{t('admin.uptime')}</dt>
                <dd>{fmtSeconds(overview.server.processUptimeSec)}</dd>
                {overview.server.network ? (
                  <>
                    <dt>Netz rx / tx</dt>
                    <dd>
                      {fmtBytes(overview.server.network.rx)} / {fmtBytes(overview.server.network.tx)}
                    </dd>
                  </>
                ) : null}
              </dl>
            </div>

            <div className="card">
              <h2>{t('admin.limit')}</h2>
              <label className="field">
                <span className="label">
                  {t('admin.limit')}: {limit}
                </span>
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
                <div className="hint">{t('admin.limitHint')}</div>
              </label>
              <button className="primary" onClick={() => void saveLimit()}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {tab === 'users' ? (
        <div className="card">
          <div className="card-head">
            <h2 style={{ margin: 0 }}>{t('admin.users')}</h2>
            <button className="ghost sm" onClick={() => void loadUsers()}>
              {t('common.refresh')}
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('login.email')}</th>
                  <th>{t('invite.displayName')}</th>
                  <th>{t('admin.lastLogin')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.email}
                      {u.isAdmin ? <span className="pill" style={{ marginLeft: 6 }}>{t('admin.admin')}</span> : null}
                      {u.isBlocked ? (
                        <span className="pill err" style={{ marginLeft: 6 }}>
                          {t('admin.blocked')}
                        </span>
                      ) : null}
                      {u.live ? (
                        <span className="pill ok" style={{ marginLeft: 6 }}>
                          {t('state.live')}
                        </span>
                      ) : null}
                    </td>
                    <td>{u.displayName}</td>
                    <td className="small">{fmtDateTime(u.lastLoginAt, lang)}</td>
                    <td>
                      {u.id === user?.id ? (
                        <span className="muted small">–</span>
                      ) : (
                        <div className="row" style={{ gap: 4 }}>
                          <button className="sm" onClick={() => void toggleBlock(u)}>
                            {u.isBlocked ? t('admin.userUnblock') : t('admin.userBlock')}
                          </button>
                          <button className="sm danger" onClick={() => void removeUser(u)}>
                            {t('admin.userDelete')}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === 'invites' ? (
        <div className="dash">
          <div className="card">
            <h2>{t('admin.inviteCreate')}</h2>
            <label className="field">
              <span className="label">{t('admin.inviteNote')}</span>
              <input type="text" value={inviteNote} maxLength={200} onChange={(e) => setInviteNote(e.target.value)} />
              <div className="hint">{t('admin.inviteNoteHint')}</div>
            </label>
            <label className="field">
              <span className="label">
                {t('admin.inviteValidDays')}: {inviteDays}
              </span>
              <input
                type="range"
                min={1}
                max={90}
                value={inviteDays}
                onChange={(e) => setInviteDays(Number(e.target.value))}
              />
            </label>
            <button className="primary" onClick={() => void createInvite()} disabled={busy}>
              {busy ? <span className="spin" /> : null}
              {t('admin.inviteCreate')}
            </button>

            {newInviteUrl ? (
              <div className="mt">
                <div className="notice ok small mb">{t('admin.inviteCreated')}</div>
                <CopyField label={t('admin.inviteCreate')} value={newInviteUrl} />
              </div>
            ) : null}
          </div>

          <div className="card">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{t('admin.invites')}</h2>
              <button className="ghost sm" onClick={() => void loadInvites()}>
                {t('common.refresh')}
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('admin.inviteNote')}</th>
                    <th>{t('invite.expiresAt', { date: '' })}</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {invites.map((i) => {
                    const expired = new Date(i.expiresAt).getTime() < Date.now();
                    return (
                      <tr key={i.id}>
                        <td>{i.note || '–'}</td>
                        <td className="small">{fmtDateTime(i.expiresAt, lang)}</td>
                        <td>
                          {i.usedAt ? (
                            <span className="pill ok">{t('admin.inviteUsed', { email: i.usedBy ?? '?' })}</span>
                          ) : expired ? (
                            <span className="pill err">{t('admin.inviteExpired')}</span>
                          ) : (
                            <span className="pill">{t('admin.inviteOpen')}</span>
                          )}
                        </td>
                        <td>
                          {!i.usedAt ? (
                            <button
                              className="ghost sm"
                              onClick={() => {
                                void api.del(`/api/admin/invites/${i.id}`).then(() => loadInvites());
                              }}
                            >
                              {t('common.delete')}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'sim' ? <SimulatorPanel users={users.map((u) => ({ id: u.id, email: u.email }))} /> : null}

      {tab === 'audit' ? (
        <div className="card">
          <h2>{t('admin.audit')}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('stats.from')}</th>
                  <th>{t('login.email')}</th>
                  <th>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="small">{fmtDateTime(a.at, lang)}</td>
                    <td className="small">{a.email ?? '–'}</td>
                    <td className="mono small">{a.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint">{fmtNumber(audit.length, lang)}</div>
        </div>
      ) : null}
    </>
  );
}
