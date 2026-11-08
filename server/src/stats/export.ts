import PDFDocument from 'pdfkit';
import type { PlatformId } from '../config';
import type { SeriesPoint, StatsReport } from './queries';

const PLATFORM_LABEL: Record<PlatformId, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
};

const PLATFORM_COLOR: Record<PlatformId, string> = {
  twitch: '#9146ff',
  youtube: '#ff0033',
  kick: '#53fc18',
};

const HINT_LABEL: Record<string, string> = {
  spike: 'Ungewöhnlicher Anstieg',
  drop: 'Ungewöhnlicher Einbruch',
  flat_curve: 'Auffällig glatte Kurve',
  low_chat_ratio: 'Wenige Chatter für diese Zuschauerzahl',
  smooth_steps: 'Gleichmäßiges Treppenmuster',
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('de-DE')} ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
}

function esc(v: unknown): string {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── CSV ──────────────────────────────────────────────────────

export function toCsv(report: StatsReport): string {
  const lines: string[] = [];
  lines.push('# Castbridge Statistik-Export');
  lines.push(`# Zeitraum;${fmtDate(report.from)};${fmtDate(report.to)}`);
  lines.push(`# Streamdauer (Min);${report.durationMin}`);
  lines.push(`# Zuschauer Peak (Summe);${report.totalPeak}`);
  lines.push(`# Zuschauer Durchschnitt (Summe);${report.totalAverage}`);
  lines.push(`# Chatnachrichten;${report.messages}`);
  lines.push(`# Chatter;${report.chatters}`);
  lines.push(`# Nachrichten pro Minute;${report.messagesPerMinute}`);
  if (report.hasSimulation) {
    lines.push('# HINWEIS;Dieser Zeitraum enthaelt simulierte Zuschauerdaten (Spalte synthetisch = ja).');
  }
  lines.push('');

  lines.push('Abschnitt;Plattform;Peak;Durchschnitt;Proben;davon synthetisch');
  for (const p of report.perPlatform) {
    lines.push(
      ['Plattform', PLATFORM_LABEL[p.platform] ?? p.platform, p.peak, p.average, p.samples, p.syntheticSamples]
        .map(esc)
        .join(';'),
    );
  }
  lines.push('');

  lines.push('Zeitpunkt;Plattform;Zuschauer;Chatter;synthetisch');
  for (const p of report.perPlatform) {
    for (const s of p.series) {
      lines.push(
        [fmtDate(s.at), PLATFORM_LABEL[p.platform] ?? p.platform, s.viewers, s.chatters, s.synthetic ? 'ja' : 'nein']
          .map(esc)
          .join(';'),
      );
    }
  }
  lines.push('');

  lines.push('Ereignis;Anzahl');
  lines.push(`Abos;${report.events.subs}`);
  lines.push(`Wiederholte Abos;${report.events.resubs}`);
  lines.push(`Geschenkte Abos;${report.events.giftSubs}`);
  lines.push(`Follows;${report.events.follows}`);
  lines.push(`Raids;${report.events.raids}`);
  lines.push(`YouTube-Mitgliedschaften;${report.events.members}`);
  lines.push(`Super Chats;${report.events.superChats}`);
  lines.push(`Super-Chat-Betrag;${report.events.superChatAmount}`);
  lines.push('');

  lines.push('Auffaelligkeit;Plattform;Zeitpunkt;Bewertung;Quelle;Details');
  for (const a of report.anomalies) {
    lines.push(
      [
        HINT_LABEL[a.type] ?? a.type,
        PLATFORM_LABEL[a.platform] ?? a.platform,
        fmtDate(a.at),
        a.score,
        a.fromSimulation ? 'Simulation' : 'Messung',
        JSON.stringify(a.detail),
      ]
        .map(esc)
        .join(';'),
    );
  }

  return '﻿' + lines.join('\r\n');
}

// ── PDF ──────────────────────────────────────────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawChart(doc: PDFKit.PDFDocument, box: Box, report: StatsReport): void {
  const all: SeriesPoint[] = [];
  for (const p of report.perPlatform) all.push(...p.series);
  if (all.length < 2) {
    doc.fontSize(9).fillColor('#777').text('Zu wenige Messpunkte für ein Diagramm.', box.x, box.y + 20);
    return;
  }

  const times = all.map((s) => new Date(s.at).getTime());
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const maxV = Math.max(10, ...all.map((s) => s.viewers));
  const spanT = Math.max(1, maxT - minT);

  // Raster
  doc.save().lineWidth(0.5).strokeColor('#e3e6ee');
  for (let i = 0; i <= 4; i++) {
    const y = box.y + (box.h / 4) * i;
    doc.moveTo(box.x, y).lineTo(box.x + box.w, y).stroke();
    const value = Math.round(maxV - (maxV / 4) * i);
    doc.fontSize(7).fillColor('#8a90a2').text(String(value), box.x - 32, y - 4, { width: 28, align: 'right' });
  }
  doc.restore();

  // Achsenbeschriftung
  doc.fontSize(7).fillColor('#8a90a2');
  doc.text(fmtDate(new Date(minT).toISOString()), box.x, box.y + box.h + 6, { width: 90 });
  doc.text(fmtDate(new Date(maxT).toISOString()), box.x + box.w - 90, box.y + box.h + 6, {
    width: 90,
    align: 'right',
  });

  for (const p of report.perPlatform) {
    if (p.series.length < 2) continue;
    const color = PLATFORM_COLOR[p.platform] ?? '#4a5568';
    doc.save().lineWidth(1.4).strokeColor(color);
    let started = false;
    for (const s of p.series) {
      const x = box.x + ((new Date(s.at).getTime() - minT) / spanT) * box.w;
      const y = box.y + box.h - (s.viewers / maxV) * box.h;
      if (!started) {
        doc.moveTo(x, y);
        started = true;
      } else {
        doc.lineTo(x, y);
      }
    }
    doc.stroke().restore();

    // Simulierte Punkte markieren
    for (const s of p.series) {
      if (!s.synthetic) continue;
      const x = box.x + ((new Date(s.at).getTime() - minT) / spanT) * box.w;
      const y = box.y + box.h - (s.viewers / maxV) * box.h;
      doc.save().circle(x, y, 1.8).fillColor('#f59e0b').fill().restore();
    }
  }

  // Auffälligkeiten als senkrechte Marken
  for (const a of report.anomalies) {
    const t = new Date(a.at).getTime();
    if (t < minT || t > maxT) continue;
    const x = box.x + ((t - minT) / spanT) * box.w;
    doc.save().lineWidth(0.8).dash(2, { space: 2 }).strokeColor('#f97316');
    doc.moveTo(x, box.y).lineTo(x, box.y + box.h).stroke();
    doc.restore();
  }

  // Legende
  let lx = box.x;
  const ly = box.y + box.h + 22;
  for (const p of report.perPlatform) {
    const color = PLATFORM_COLOR[p.platform] ?? '#4a5568';
    doc.save().rect(lx, ly, 8, 8).fillColor(color).fill().restore();
    doc.fontSize(8).fillColor('#3c4256').text(PLATFORM_LABEL[p.platform] ?? p.platform, lx + 12, ly);
    lx += 80;
  }
  if (report.hasSimulation) {
    doc.save().circle(lx + 4, ly + 4, 3).fillColor('#f59e0b').fill().restore();
    doc.fontSize(8).fillColor('#3c4256').text('simuliert', lx + 12, ly);
  }
}

function keyValueRow(doc: PDFKit.PDFDocument, label: string, value: string, y: number): void {
  doc.fontSize(9).fillColor('#6b7280').text(label, 50, y, { width: 200 });
  doc.fontSize(10).fillColor('#111827').text(value, 250, y - 1, { width: 290 });
}

export function toPdf(report: StatsReport, meta: { channel: string; generatedFor: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Castbridge Bericht – ${report.label}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Kopf
    doc.rect(0, 0, doc.page.width, 92).fillColor('#0b0f17').fill();
    doc.fillColor('#ffffff').fontSize(20).text('Castbridge', 50, 30);
    doc.fillColor('#9aa4bf').fontSize(10).text('Multistream-Bericht', 50, 56);
    doc.fillColor('#9aa4bf').fontSize(9).text(meta.channel, 50, 70);
    doc
      .fillColor('#6f7a94')
      .fontSize(8)
      .text(`Erstellt am ${new Date().toLocaleDateString('de-DE')}`, doc.page.width - 200, 70, {
        width: 150,
        align: 'right',
      });

    let y = 120;
    doc.fillColor('#111827').fontSize(14).text(report.label, 50, y);
    y += 24;
    doc.fontSize(9).fillColor('#6b7280').text(`${fmtDate(report.from)} bis ${fmtDate(report.to)}`, 50, y);
    y += 24;

    if (report.hasSimulation) {
      doc.rect(50, y, doc.page.width - 100, 34).fillColor('#fff7ed').fill();
      doc
        .fillColor('#9a3412')
        .fontSize(9)
        .text(
          'Dieser Bericht enthält simulierte Zuschauerdaten aus dem Erkennungstest. ' +
            'Simulierte Messpunkte sind im Diagramm orange markiert und in der CSV-Datei gekennzeichnet.',
          58,
          y + 8,
          { width: doc.page.width - 116 },
        );
      y += 46;
    }

    // Kennzahlen
    doc.fillColor('#111827').fontSize(12).text('Überblick', 50, y);
    y += 20;
    keyValueRow(doc, 'Streamdauer', `${Math.floor(report.durationMin / 60)} h ${report.durationMin % 60} min`, y);
    y += 18;
    keyValueRow(doc, 'Zuschauer-Peak (alle Plattformen)', String(report.totalPeak), y);
    y += 18;
    keyValueRow(doc, 'Zuschauer im Durchschnitt', String(report.totalAverage), y);
    y += 18;
    keyValueRow(doc, 'Chatnachrichten', String(report.messages), y);
    y += 18;
    keyValueRow(doc, 'Verschiedene Chatter', String(report.chatters), y);
    y += 18;
    keyValueRow(doc, 'Nachrichten pro Minute', String(report.messagesPerMinute), y);
    y += 32;

    // Diagramm
    doc.fillColor('#111827').fontSize(12).text('Zuschauer im Verlauf', 50, y);
    y += 20;
    drawChart(doc, { x: 82, y, w: doc.page.width - 140, h: 150 }, report);
    y += 200;

    // Plattformtabelle
    doc.fillColor('#111827').fontSize(12).text('Pro Plattform', 50, y);
    y += 20;
    doc.fontSize(9).fillColor('#6b7280');
    doc.text('Plattform', 50, y);
    doc.text('Peak', 200, y);
    doc.text('Durchschnitt', 270, y);
    doc.text('Messpunkte', 370, y);
    y += 14;
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
    y += 6;
    for (const p of report.perPlatform) {
      doc.fontSize(10).fillColor('#111827').text(PLATFORM_LABEL[p.platform] ?? p.platform, 50, y);
      doc.text(String(p.peak), 200, y);
      doc.text(String(p.average), 270, y);
      doc.text(p.syntheticSamples > 0 ? `${p.samples} (${p.syntheticSamples} sim.)` : String(p.samples), 370, y);
      y += 16;
    }
    y += 16;

    if (y > doc.page.height - 220) {
      doc.addPage();
      y = 60;
    }

    // Ereignisse
    doc.fillColor('#111827').fontSize(12).text('Ereignisse', 50, y);
    y += 20;
    const events: [string, number][] = [
      ['Abos', report.events.subs],
      ['Wiederholte Abos', report.events.resubs],
      ['Geschenkte Abos', report.events.giftSubs],
      ['Follows', report.events.follows],
      ['Raids', report.events.raids],
      ['YouTube-Mitgliedschaften', report.events.members],
      ['Super Chats', report.events.superChats],
    ];
    for (const [label, value] of events) {
      keyValueRow(doc, label, String(value), y);
      y += 16;
    }
    y += 20;

    if (y > doc.page.height - 200) {
      doc.addPage();
      y = 60;
    }

    // Auffälligkeiten
    doc.fillColor('#111827').fontSize(12).text('Auffälligkeiten', 50, y);
    y += 18;
    doc
      .fontSize(8)
      .fillColor('#6b7280')
      .text(
        'Hinweise, keine Urteile. Jeder Eintrag nennt Zeitpunkt und Rohwerte, damit er bei der Plattform belegbar ist.',
        50,
        y,
        { width: doc.page.width - 100 },
      );
    y += 24;

    if (report.anomalies.length === 0) {
      doc.fontSize(10).fillColor('#047857').text('Keine Auffälligkeiten gefunden.', 50, y);
      y += 20;
    } else {
      for (const a of report.anomalies) {
        if (y > doc.page.height - 90) {
          doc.addPage();
          y = 60;
        }
        const title = HINT_LABEL[a.type] ?? a.type;
        doc.fontSize(10).fillColor('#111827').text(`${title} – ${PLATFORM_LABEL[a.platform] ?? a.platform}`, 50, y);
        y += 14;
        doc
          .fontSize(8)
          .fillColor('#6b7280')
          .text(
            `${fmtDate(a.at)} · Bewertung ${a.score.toFixed(2)} · Quelle: ${a.fromSimulation ? 'Simulation' : 'Messung'} · ${JSON.stringify(a.detail)}`,
            50,
            y,
            { width: doc.page.width - 100 },
          );
        y += 22;
      }
    }

    doc
      .fontSize(7)
      .fillColor('#9ca3af')
      .text(
        `Bericht für ${meta.generatedFor}. Daten entstehen nur, wenn über Castbridge gestreamt wird.`,
        50,
        doc.page.height - 60,
        { width: doc.page.width - 100 },
      );

    doc.end();
  });
}
