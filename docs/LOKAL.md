# Lokal testen, ohne Server

Du brauchst Coolify **nicht**, um das Tool auszuprobieren. Es läuft komplett
auf deinem PC, inklusive echtem Streamen nach Twitch, YouTube und Kick. Der
Server wird erst gebraucht, wenn Freunde mitnutzen sollen oder du nicht deinen
eigenen Upload dafür hergeben willst.

Es gibt drei Stufen. Stufe 1 geht sofort, Stufe 2 und 3 brauchen je eine
Installation.

---

## Stufe 1: Tests laufen lassen — geht sofort

Braucht nur Node und ffmpeg, beides ist bei dir vorhanden. Keine Datenbank.

```bash
cd server && npm install && npm run build && npm test
```

Das prüft in etwa einer Minute:

- **Der Umschalter.** Zwei echte ffmpeg-Quellen werden mitten im Strom
  getauscht. Geprüft wird, dass der Strom durchläuft, die Zeitstempel pro Spur
  weiterlaufen und der Pfad, den das Relay nimmt (`-c copy -f flv`), fehlerfrei
  bleibt.
- **Das Ersatzmedium.** Standardbild erzeugen, auf Auflösung, Profil und Level
  eines OBS-Signals aufbereiten, Profil-Zuordnung für Baseline, Main und High.
- **Die Viewbot-Erkennung.** Alle sechs Szenarien durch den echten Detektor,
  einschließlich der Gegenprobe mit einem echten Raid.
- **Die HTTP-Schicht.** Zugangsschutz, MediaMTX-Hook, Webhook-Signaturpflicht,
  Body-Parser, Ausliefern der Oberfläche.

Das ist der schnellste Weg zu der Frage „trägt der Kern?". Die Antwort kommt
ohne Datenbank, ohne MediaMTX und ohne Plattform-Zugänge.

---

## Stufe 2: Die Oberfläche im Browser — braucht Postgres

Danach kannst du dich anmelden, durch den Einrichtungsassistenten gehen,
Plattformen verbinden, den Overlay-Editor benutzen und den
Viewbot-Simulator im Admin-Bereich durchrechnen lassen. Nur Signal, Relay und
Vorschaubild fehlen noch, dafür ist Stufe 3 nötig.

### Postgres ohne Installation

Die Zip-Variante braucht keine Administratorrechte. Von
<https://www.enterprisedb.com/download-postgresql-binaries> die
`postgresql-16-windows-x64-binaries.zip` holen und auspacken, zum Beispiel
nach `B:\tools\pgsql`. Dann einmalig:

```bash
"B:/tools/pgsql/bin/initdb.exe" -D "B:/tools/pgdata" -U postgres -A trust -E UTF8
```

Starten (bleibt im Vordergrund, einfach laufen lassen):

```bash
"B:/tools/pgsql/bin/pg_ctl.exe" -D "B:/tools/pgdata" -l "B:/tools/pgdata/log.txt" start
```

Datenbank anlegen:

```bash
"B:/tools/pgsql/bin/createdb.exe" -U postgres castbridge
```

Wer den normalen Installer bevorzugt, nimmt den von
<https://www.postgresql.org/download/windows/> und legt dort eine Datenbank
`castbridge` an. Beides geht.

### `.env` für den lokalen Betrieb

Im Projektverzeichnis `.env` anlegen:

```
PUBLIC_URL=http://localhost:3000
INGEST_HOST=localhost
DATABASE_URL=postgres://postgres@localhost:5432/castbridge
MEDIAMTX_API_URL=http://127.0.0.1:9997
MEDIAMTX_RTMP_URL=rtmp://127.0.0.1:1935
DATA_DIR=./data
ADMIN_EMAIL=du@example.de
ADMIN_PASSWORD=lokal-nur-zum-testen
LOG_LEVEL=debug
```

Die beiden Geheimnisse erzeugen und anhängen:

```bash
node -e "console.log('SECRET_KEY='+require('crypto').randomBytes(32).toString('base64'))"
```

```bash
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('base64'))"
```

`REDIS_URL` bleibt leer. Ohne Redis läuft alles prozessintern, für einen
Rechner ist das genau richtig.

### Starten

Oberfläche einmal bauen, dann den Server starten:

```bash
cd web && npm install && npm run build
```

```bash
cd server && npm start
```

Jetzt <http://localhost:3000> öffnen und mit `ADMIN_EMAIL` und
`ADMIN_PASSWORD` anmelden. Das Schema wird beim ersten Start automatisch
angelegt.

Wer am Frontend arbeitet, nimmt statt des gebauten Stands den
Entwicklungsserver mit Neuladen bei jeder Änderung:

```bash
cd web && npm run dev
```

Der läuft dann auf <http://localhost:5173> und leitet `/api` und `/ws` an
Port 3000 weiter.

### Was auf dieser Stufe schon geht

- Anmelden, Einladungslinks erzeugen und einlösen, Sprache umstellen
- Einrichtungsassistent inklusive Speedtest (der messt dann deine Leitung zu
  dir selbst, also sehr schnell — das ist erwartbar)
- Plattformen verbinden, auch der manuelle Weg mit Stream-Key
- Titel und Kategorie setzen, Titelvorlagen
- Chat lesen, sobald eine Plattform über Anmeldung verbunden ist
- Overlay-Editor mit Live-Vorschau, Overlay-URL in OBS einsetzen
- **Viewbot-Simulator** im Admin-Bereich: Szenarien durchrechnen, Kurven
  ansehen, Schwellen einstellen. Dafür braucht es keinen laufenden Stream.
- Statistiken, CSV- und PDF-Bericht

---

## Stufe 3: Echtes Streamen vom eigenen PC — braucht MediaMTX

Damit testest du den eigentlichen Kern: OBS sendet an deinen Rechner, der
verteilt an die Plattformen.

### MediaMTX holen

Eine einzelne Datei, keine Installation. Von
<https://github.com/bluenviron/mediamtx/releases> das Paket
`mediamtx_vX.Y.Z_windows_amd64.zip` holen, auspacken, und mit der
mitgelieferten lokalen Konfiguration starten:

```bash
"B:/tools/mediamtx/mediamtx.exe" "B:/Max Projekte/Max Tes/restream-tool/mediamtx/mediamtx.local.yml"
```

Diese Fassung fragt die Zugangsprüfung bei `127.0.0.1:3000` ab statt beim
Docker-Dienst. Die Server-Fassung `mediamtx.yml` würde lokal nicht
funktionieren.

Reihenfolge: erst Postgres, dann `npm start` im `server`-Ordner, dann
MediaMTX. Startet MediaMTX zuerst, lehnt es Publishes ab, weil die App noch
nicht antwortet.

### OBS einstellen

Im Dashboard oder im Assistenten stehen Server und Schlüssel. Lokal sind das:

- Server: `rtmp://localhost:1935/live`
- Stream-Schlüssel: dein Ingest-Key aus dem Assistenten

In OBS unter Einstellungen → Stream den Dienst *Benutzerdefiniert* wählen und
beides eintragen. Encoder: CBR, Keyframe-Abstand 2 s, H.264.

### Prüfen, ohne eine Plattform anzufassen

Du musst nicht gleich live gehen. Starte den Stream in OBS und sieh im
Dashboard nach:

- **„OBS-Signal empfangen"** mit Auflösung, FPS, Bitrate und Codec. Die
  Bitrate wird aus den tatsächlich ankommenden Bytes berechnet, nicht aus dem,
  was OBS behauptet.
- Nach wenigen Sekunden erscheint das **Vorschaubild** mit dem Hinweis, dass es
  alle 10 Sekunden aktualisiert wird.
- Stell in OBS absichtlich eine zu hohe Bitrate ein: die **Warnung** muss
  kommen.
- Noch ist nichts live, genau so soll es sein.

### Den Umschalter prüfen, das Wichtigste

1. In den Einstellungen ein Ersatzbild hochladen.
2. Mindestens eine Plattform live schalten. Dafür reicht ein **manuell
   eingetragener Stream-Key**, du brauchst keine Entwickler-App. Für einen
   ruhigen Test eignet sich ein Twitch-Konto mit auf „nur Follower" gestellter
   Sichtbarkeit, oder YouTube mit Sichtbarkeit *Privat*.
3. In OBS auf *Stream beenden*.
4. Im Dashboard muss **„Ersatzbild überbrückt gerade"** erscheinen, und bei der
   Plattform muss der Stream **weiterlaufen**, jetzt mit dem Ersatzbild.
5. In OBS wieder starten. Das Tool schaltet von selbst zurück.

Bricht die Plattform dabei doch ab, steht im Server-Log, warum. Der Hinweis
„Profil oder Level der neuen Quelle weichen ab" heißt: das aufbereitete
Ersatzbild passt noch nicht zum OBS-Signal. Dann in OBS Auflösung und FPS
festnageln, also keine automatische Skalierung, und das Ersatzbild neu
hochladen.

---

## Was lokal anders ist als auf dem Server

| Punkt | Lokal | Auf dem Server |
|---|---|---|
| Upload | dein Hausanschluss trägt alle drei Ausgänge gleichzeitig | der Server hat die Last, du sendest nur einmal hin |
| Speedtest | misst zu dir selbst, also unrealistisch schnell | misst die Strecke, die zählt |
| OAuth-Rücksprung | Twitch und Google erlauben `http://localhost:3000/...` als Redirect-URI, Kick nicht immer | normale Subdomain mit TLS |
| Kick-Webhooks | kommen nicht an, weil dein PC von außen nicht erreichbar ist. Twitch-Chat geht lokal, der Kick-Chat nicht | funktioniert |
| Freunde | können nicht mitnutzen | dafür ist er da |

**Das ist der eigentliche Grund für den Server:** nicht dass es lokal nicht
läuft, sondern dass dein Upload sonst dreimal dasselbe Video hochschickt. Genau
das soll das Tool ja abstellen.

Für OAuth lokal: in der Twitch-App und bei Google eine zweite Redirect-URI mit
`http://localhost:3000/api/platforms/.../callback` hinterlegen, dann geht das
Verbinden auch lokal. Beide erlauben `localhost` ausdrücklich. Für Kick und für
den Kick-Chat brauchst du die öffentliche Adresse.

---

## Wenn etwas klemmt

| Symptom | Ursache |
|---|---|
| `npm start` hängt bei „Warte auf Datenbank" | Postgres läuft nicht, oder `DATABASE_URL` stimmt nicht. |
| Anmeldung schlägt fehl, obwohl die Zugangsdaten stimmen | `ADMIN_EMAIL`/`ADMIN_PASSWORD` werden nur beim **ersten** Start angelegt. Nach einer Änderung Passwort in der Oberfläche ändern oder die Zeile in `users` löschen. |
| Oberfläche zeigt nur JSON statt der Seite | `web` wurde nicht gebaut. `cd web && npm run build`. |
| Dashboard bleibt bei „Warte auf OBS-Signal" | MediaMTX läuft nicht, oder es wurde mit `mediamtx.yml` statt `mediamtx.local.yml` gestartet. |
| MediaMTX schreibt „authentication failed" | Die App läuft nicht oder antwortet nicht auf `127.0.0.1:3000`. Reihenfolge beachten. |
| Port 1935 belegt | Ein anderes Programm hält ihn, oft ein zweites OBS oder ein alter MediaMTX-Prozess. |
