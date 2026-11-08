# Castbridge

Eigenes Multistream-Tool als Alternative zu Restream.io. OBS sendet **einmal**
an den Server, der verteilt den Stream **in Originalqualität** (ohne
Neukodierung) an Twitch, YouTube und Kick. Alle drei Chats laufen gebündelt im
Dashboard und als OBS-Overlay zusammen.

> Der Name ist ein Arbeitstitel und steckt nur in `web/src/i18n` und im
> Seitentitel. Umbenennen heißt: dort suchen und ersetzen.

---

## Was drin ist

| Bereich | Stand |
|---|---|
| Ingest RTMP + SRT mit Key-Prüfung pro Nutzer | fertig |
| Weiterleitung ohne Neukodierung (`-c copy`), einzeln start-/stoppbar | fertig |
| Umschalter OBS ↔ Ersatzbild **ohne Verbindungsabbruch** bei den Plattformen | fertig, mit ffmpeg getestet |
| 3 automatische Neuverbindungen + Toast mit „Erneut versuchen" | fertig |
| Vorschaubild alle 10 s mit Hinweis und Zeitstempel | fertig |
| Warnungen: Bitrate zu hoch, Codec, FPS, Auflösung, fehlender Ton | fertig |
| OAuth für Twitch, YouTube, Kick + manueller Key als Ausweichweg | fertig |
| Titel gemeinsam und pro Plattform, Vorlagen „zuletzt verwendet" + Favoriten | fertig |
| Kategorie über API (Twitch/Kick voll, YouTube nur Rubrik „Gaming") | fertig |
| Chat-Hub Twitch (IRC) / Kick (Webhooks) / YouTube (Abfrage) | fertig |
| Emotes: Plattform + 7TV + BTTV + FFZ | fertig |
| Gelöschte Nachrichten, Timeouts und Bans verschwinden auch im Overlay | fertig |
| Bots ausblenden mit Liste und eigenen Namen | fertig |
| Chat-Overlay mit Editor und Live-Vorschau | fertig |
| Speedtest zum eigenen Server + abgeleitete OBS-Werte | fertig |
| Einrichtungsassistent in 4 Schritten | fertig |
| Statistiken, Auffälligkeiten, CSV- und PDF-Bericht | fertig |
| Admin: Nutzer, Einladungen, laufende Streams, Serverlast, Limit | fertig |
| Viewbot-Simulator und Erkennungstest | fertig, alle Szenarien geprüft |
| Zweisprachig DE/EN, handytauglich | fertig |

Bewusst **nicht** enthalten (wie im Konzept festgelegt): Neukodierung pro
Plattform, Chat schreiben oder moderieren, offene Registrierung, YouTube-/VOD-
Links als Ersatzbild.

---

## Aufbau

```
                     ┌──────────────── Hetzner-Server (Coolify) ──────────────┐
OBS ──RTMP/SRT──►  1935 / 8890 ─► MediaMTX  (Ingest, Key-Prüfung über die App) │
                     │               │                                        │
                     │               ├─► ffmpeg (OBS-Quelle)   ─┐              │
                     │               │                          ├─► FLV-      │
                     │               └─► ffmpeg (Ersatzbild)   ─┘   Splicer    │
                     │                                              │         │
                     │                         ┌────────────────────┼───────┐ │
                     │                         ├─ ffmpeg -c copy ─► Twitch  │ │
                     │                         ├─ ffmpeg -c copy ─► YouTube │ │
                     │                         └─ ffmpeg -c copy ─► Kick    │ │
                     │                                       (RTMPS)        │ │
                     │  Web-App (Dashboard, Login, Overlay, Statistik, Admin) │
                     │  Chat-Hub · Statistik-Sammler · PostgreSQL · Redis      │
                     └────────────────────────────────────────────────────────┘
```

### Der Umschalter, also der kniffligste Teil

Ein ffmpeg, das seine Quelle verliert, beendet sich — und damit bricht die
RTMP-Verbindung zur Plattform ab. Genau das soll beim Ersatzbild nicht
passieren.

Deshalb liegt zwischen Quelle und Plattform ein eigener **FLV-Splicer**
(`server/src/relay/flv.ts`):

1. Die OBS-Quelle und das Ersatzmedium laufen als je ein ffmpeg, das einen
   FLV-Strom auf die Standardausgabe schreibt.
2. Der Splicer zerlegt diesen Strom in Tags, hält Kopf und Sequenz-Köpfe fest
   und schreibt einen **durchgehenden** Strom an beliebig viele Ausgänge.
3. Pro Plattform liest ein `ffmpeg -f flv -i pipe:0 -c copy` aus diesem Strom.
   Dieses ffmpeg sieht **nie** ein Dateiende, auch wenn die Quelle getauscht
   wird.
4. Gewechselt wird nur auf einem Keyframe, und die Zeitstempel laufen
   lückenlos weiter.

Damit die Plattformen den Tausch mitmachen, wird das Ersatzmedium beim ersten
Ausfall einmalig **genau auf die Parameter des OBS-Signals** umkodiert: gleiche
Auflösung, FPS, GOP-Länge, Profil, Pixelformat, Bitrate und Audioformat
(`server/src/relay/standby.ts`). Nur in dieser Zeit kodiert der Server
überhaupt.

Geprüft mit zwei echten ffmpeg-Quellen und einem Wechsel mitten im Strom:
durchgehender Strom, **0 Zeitstempel-Rückschritte pro Spur**, h264 + aac
erhalten, ffmpeg dekodiert das Ergebnis ohne Fehler.

---

## Schnellstart für die Entwicklung

Nötig: Node 20 oder neuer, ffmpeg im Pfad, eine PostgreSQL-Datenbank.

```bash
cp .env.example .env
```

Geheimnisse erzeugen und in die `.env` eintragen:

```bash
node -e "console.log('SECRET_KEY='+require('crypto').randomBytes(32).toString('base64'))"
```

```bash
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('base64'))"
```

Dann Server und Oberfläche:

```bash
npm --prefix server install
```

```bash
npm --prefix server run build
```

```bash
npm --prefix server start
```

```bash
npm --prefix web install
```

```bash
npm --prefix web run dev
```

Die Oberfläche läuft auf `http://localhost:5173` und leitet `/api` und `/ws`
an den Server auf Port 3000 weiter. Beim ersten Start wird das Schema
angelegt und aus `ADMIN_EMAIL` / `ADMIN_PASSWORD` das Admin-Konto erzeugt.

Für den Ingest zusätzlich MediaMTX starten, mit `mediamtx/mediamtx.yml` als
Konfiguration. Ohne MediaMTX funktioniert alles außer Signal, Relay und
Vorschaubild.

---

## Lokal testen

Der ganze Kern lässt sich ohne Server prüfen. Sofort und ohne Datenbank:

```bash
npm --prefix server install
```

```bash
npm --prefix server run verify
```

37 Prüfungen in etwa einer Minute: Umschalter gegen echtes ffmpeg,
Ersatzmedium samt Profil-Zuordnung, alle sechs Viewbot-Szenarien und die
HTTP-Schicht. Wie es weitergeht bis zum echten Streamen vom eigenen PC steht
in **[docs/LOKAL.md](docs/LOKAL.md)**.

---

## Betrieb

**[docs/DEPLOY.md](docs/DEPLOY.md)** — GitHub und Coolify einrichten, und wie
eine Änderung danach von `git push` bis zum laufenden Server kommt: CI als
Türsteher, Auto-Deploy, Migrationen, Zurückrollen.

**[docs/SETUP.md](docs/SETUP.md)** — Subdomain und Hetzner-Firewall (1935/TCP
und 8890/UDP, **nicht** über den Coolify-Proxy), die Entwickler-Apps bei Twitch,
Google und Kick Schritt für Schritt, und was beim ersten Stream zu prüfen ist.

Und **[docs/VIEWBOT-SIMULATOR.md](docs/VIEWBOT-SIMULATOR.md)** für den
Erkennungstest und das Einstellen der Schwellen.

---

## Verzeichnisse

```
server/
  migrations/            SQL, wird beim Start automatisch angewendet
  src/
    config.ts            Konfiguration aus der Umgebung
    index.ts             Start, Fastify, Routen, Herunterfahren
    lib/                 Datenbank, Krypto, Zugang, Einladungen, Ereignisbus
    ingest/mediamtx.ts   MediaMTX-API, Überwachung, Bitrate aus Bytes
    relay/
      flv.ts             FLV-Parser und Splicer (der Umschalter)
      session.ts         eine Sitzung pro Nutzer, Relays, Neuverbindung
      standby.ts         Ersatzmedium passend aufbereiten
      thumbnail.ts       Vorschaubild alle 10 s
      manager.ts         Registry, Limit gleichzeitiger Streams
    platforms/           Twitch, YouTube, Kick + Konten und Tokens
    chat/                Hub, IRC, YouTube-Abfrage, Emotes, Bot-Liste
    stats/               Sammler, Detektor, Simulator, Abfragen, Export
    routes/              HTTP und WebSocket
web/
  src/
    i18n/                alle Texte, DE und EN
    lib/                 API, Sitzung, Live-Verbindung, Formate
    components/          Karten, Diagramm, Chat, Overlay, Simulator
    pages/               Login, Einladung, Assistent, Dashboard, Chat,
                         Overlay-Editor, Overlay, Statistik, Einstellungen, Admin
mediamtx/mediamtx.yml
docker-compose.yml
```

---

## Was geprüft ist und was nicht

**Geprüft** — `npm test` im Ordner `server`, 37 Prüfungen in 4 Dateien:

- Server und Oberfläche übersetzen ohne Typfehler, die Oberfläche baut durch.
- **Umschalter** gegen echtes ffmpeg: Quellenwechsel mitten im Strom, keine
  Zeitstempel-Rückschritte pro Spur, und der Pfad, den das Relay wirklich nimmt
  (`-c copy -f flv`), bleibt fehlerfrei.
- **Ersatzmedium:** Aufbereitung trifft Auflösung, Codec, Tonformat sowie
  Profil und Level des OBS-Signals, geprüft für Baseline, Main und High.
- **Erkennung** gegen alle sechs Simulator-Szenarien: fünf erkannt, der echte
  Raid als Gegenprobe korrekt nicht gemeldet.
- **HTTP-Schicht:** 13 Prüfungen über `fastify.inject()` (Zugangsschutz,
  MediaMTX-Hook, Webhook-Signaturpflicht, Body-Parser, Ausliefern der
  Oberfläche).

Beim Aufbau dieser Tests kamen drei echte Fehler heraus, die behoben sind: ein
schleichender Anstieg war an den Zuwächsen allein nicht erkennbar, ein
abfließender Raid löste falschen Alarm aus, und das Ersatzbild war fest auf
Profil High kodiert, obwohl OBS auch Baseline oder Main senden kann.

**Noch nicht geprüft, weil dafür Zugänge und ein Server nötig sind:**

- Die echten Plattform-Schnittstellen. Die Aufrufe folgen der jeweiligen
  Dokumentation, aber ob jeder Endpunkt genau so antwortet, zeigt erst der
  erste Lauf mit echten Entwickler-Apps. Betroffen sind vor allem:
  - **Kick:** ob der Stream-Key über die API herausgegeben wird. Der Code
    probiert drei Endpunkte und fällt sonst sauber auf den manuellen Weg
    zurück, mit Anleitung in der Oberfläche.
  - **YouTube:** Tageskontingent im Dauerbetrieb. Der Chat hält sich an die
    von Google vorgeschlagene Wartezeit, mindestens 5 Sekunden, und stellt bei
    `quotaExceeded` ab, statt weiter zu hämmern.
- Ein Durchlauf gegen echtes Postgres und MediaMTX.
- Dass Twitch, YouTube und Kick den Splice tatsächlich schlucken. Die
  Parameter sind dafür gebaut, bewiesen ist es erst mit dem ersten Test.
  `docs/SETUP.md` beschreibt, wie man das in 15 Minuten prüft.
