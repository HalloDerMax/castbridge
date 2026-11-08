import type { FastifyInstance } from 'fastify';
import { requireUser, type AuthedRequest } from '../lib/auth';
import { BadRequest } from '../lib/validate';
import { listSessions, rangeReport, sessionReport, type StatsReport } from '../stats/queries';
import { toCsv, toPdf } from '../stats/export';

function parseRange(q: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequest('invalid_range');
  if (from > to) throw new BadRequest('range_reversed');
  return { from, to };
}

async function reportFor(userId: string, q: { session?: string; from?: string; to?: string }): Promise<StatsReport> {
  if (q.session) {
    const report = await sessionReport(userId, q.session);
    if (!report) throw new BadRequest('session_not_found');
    return report;
  }
  const { from, to } = parseRange(q);
  return rangeReport(userId, from, to);
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats/sessions', async (req: AuthedRequest) => {
    const user = requireUser(req);
    return { sessions: await listSessions(user.id) };
  });

  app.get('/api/stats/report', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const report = await reportFor(user.id, req.query as { session?: string; from?: string; to?: string });
    return { report };
  });

  app.get('/api/stats/export.csv', async (req: AuthedRequest, reply) => {
    const user = requireUser(req);
    const report = await reportFor(user.id, req.query as { session?: string; from?: string; to?: string });
    const name = `castbridge-${report.scope}-${report.from.slice(0, 10)}.csv`;
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return toCsv(report);
  });

  app.get('/api/stats/export.pdf', async (req: AuthedRequest, reply) => {
    const user = requireUser(req);
    const report = await reportFor(user.id, req.query as { session?: string; from?: string; to?: string });
    const pdf = await toPdf(report, {
      channel: user.display_name === '' ? user.email : user.display_name,
      generatedFor: user.email,
    });
    const name = `castbridge-bericht-${report.from.slice(0, 10)}.pdf`;
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return pdf;
  });

  app.get('/api/stats/live', async (req: AuthedRequest) => {
    const user = requireUser(req);
    const { relayManager } = await import('../relay/manager');
    const { chatHub } = await import('../chat/hub');
    const session = relayManager.session(user.id);
    return {
      sessionId: session?.sessionId ?? null,
      chat: chatHub.rates(user.id),
      diagnostics: session?.diagnostics() ?? null,
    };
  });
}
