# GitHub + Coolify: einrichten und automatisch aktualisieren

Ziel: Du änderst etwas, machst einen `git push`, und ein paar Minuten später
läuft es auf dem Server. Ohne Dateien hochzuladen, ohne SSH.

So sieht der Ablauf danach aus:

```
git push → GitHub → CI prüft (Typen, Build, 37 Tests, Docker-Abbild)
                         └── grün → Coolify baut neu → Container tauschen
                                      └── Migrationen laufen beim Start selbst
```

---

## 1. Repository anlegen

Das Projekt wird sein **eigenes** Repository, mit `restream-tool` als Wurzel.
Nicht den Ordner darüber mitnehmen: dort liegt das Unity-Projekt, das hat damit
nichts zu tun.

```bash
cd "B:/Max Projekte/Max Tes/restream-tool"
```

```bash
git init -b main
```

Jetzt **vor** dem ersten Commit nachsehen, dass keine Geheimnisse mitkommen:

```bash
git status --short
```

In der Liste darf **keine `.env`** auftauchen und kein `node_modules`, `dist`
oder `data`. Die `.gitignore` sorgt dafür; wenn doch etwas dabei ist, erst das
klären.

Dagegen **müssen** `server/package-lock.json` und `web/package-lock.json` dabei
sein. Der Docker-Build nutzt `npm ci`, und das verlangt diese Dateien.

```bash
git add . && git commit -m "Castbridge: erster Stand"
```

Dann das Repository auf GitHub. Mit der GitHub-CLI in einem Schritt:

```bash
gh repo create castbridge --private --source . --push
```

Ohne CLI: auf github.com ein **privates** Repository `castbridge` anlegen, ohne
README und ohne .gitignore, und dann:

```bash
git remote add origin git@github.com:DEIN-NAME/castbridge.git && git push -u origin main
```

**Privat, nicht öffentlich.** Es stecken keine Geheimnisse im Code, aber es gibt
auch keinen Grund, die Angriffsfläche öffentlich auszulegen.

---

## 2. Werte vorbereiten

Die beiden Zufallsgeheimnisse jetzt erzeugen und wegspeichern, du brauchst sie
im nächsten Schritt:

```bash
node -e "console.log('SECRET_KEY='+require('crypto').randomBytes(32).toString('base64'))"
```

```bash
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('base64'))"
```

```bash
node -e "console.log('POSTGRES_PASSWORD='+require('crypto').randomBytes(18).toString('base64url'))"
```

**SECRET_KEY nie wieder ändern.** Damit sind die Stream-Keys und Tokens in der
Datenbank verschlüsselt. Ein neuer Schlüssel macht alle gespeicherten Keys
unlesbar, und alle Plattformen müssen neu verbunden werden.

Diese fünf sind Pflicht. Fehlt eine davon, bricht der Start ab, statt leise mit
einem leeren Wert weiterzulaufen:

| Variable | Beispiel | Wofür |
|---|---|---|
| `PUBLIC_URL` | `https://stream.deinedomain.de` | Öffentliche Adresse, ohne Schrägstrich am Ende. Steckt in den OAuth-Rücksprüngen und in der Overlay-URL. |
| `INGEST_HOST` | `stream.deinedomain.de` | Adresse, die OBS angezeigt bekommt. |
| `SECRET_KEY` | aus dem Befehl oben | Verschlüsselung der Stream-Keys. |
| `SESSION_SECRET` | aus dem Befehl oben | Signatur der Anmelde-Cookies. |
| `POSTGRES_PASSWORD` | aus dem Befehl oben | Datenbank. `DATABASE_URL` wird daraus gebaut, die musst du nicht selbst setzen. |

Dazu beim ersten Start, damit es überhaupt ein Konto gibt:

| Variable | Hinweis |
|---|---|
| `ADMIN_EMAIL` | Deine Adresse. |
| `ADMIN_PASSWORD` | Nur für die erste Anmeldung. Danach in der Oberfläche ändern und die Variable in Coolify leeren. |

Die Plattform-Zugänge (`TWITCH_CLIENT_ID` und so weiter) kommen später dazu,
siehe [SETUP.md](SETUP.md) Abschnitt 3. Ohne sie läuft alles, nur das Verbinden
per Anmeldung fehlt und es bleibt der manuelle Weg mit Stream-Key.

---

## 3. Ressource in Coolify anlegen

1. Im Coolify-Projekt **New Resource**.
2. Als Quelle das GitHub-Repository wählen:
   - **GitHub App** ist der bequeme Weg. Coolify installiert eine App in deinem
     GitHub-Konto, sieht private Repositories und richtet den Webhook selbst
     ein. Dafür einmal in Coolify unter *Sources* eine GitHub-App anlegen und
     autorisieren.
   - **Deploy Key** ist der Weg ohne App: Coolify zeigt dir einen öffentlichen
     Schlüssel, den du im Repository unter *Settings → Deploy keys* hinterlegst.
     Den Webhook richtest du dann in Schritt 6 selbst ein.
3. **Build Pack: Docker Compose**.
4. Einstellen:
   - **Branch**: `main`
   - **Base Directory**: `/`
   - **Docker Compose Location**: `docker-compose.yml`
5. Speichern, aber **noch nicht deployen**.

---

## 4. Variablen, Domain und Ports

### Variablen

Im Reiter **Environment Variables** der Ressource alle Werte aus Schritt 2
eintragen. Coolify legt daraus beim Deployment eine `.env` neben der
Compose-Datei an, und `docker compose` setzt sie ein.

Es gibt im Repository **keine** eingecheckte `.env`, und das soll so bleiben.
Die Compose-Datei holt jeden Wert über `${...}` aus den Coolify-Variablen.

### Domain

Die Subdomain muss auf den Dienst `app`, Port **3000** zeigen. Zwei Wege, je
nachdem was deine Coolify-Fassung anbietet:

- Im Formular beim Dienst `app` gibt es ein Feld **Domains**. Dort
  `https://stream.deinedomain.de` eintragen.
- Oder die Variable **`SERVICE_FQDN_APP_3000`** auf `https://stream.deinedomain.de`
  setzen. Die Compose-Datei gibt sie an Coolify weiter, und Coolify baut daraus
  die Proxy-Regeln samt TLS.

Vorher den A-Record der Subdomain auf die Server-IP zeigen lassen, sonst kann
Coolify kein Zertifikat holen.

### Die zwei Ports, die nicht über den Proxy gehen

`1935/TCP` (RTMP) und `8890/UDP` (SRT) sind in der Compose-Datei **direkt** am
MediaMTX-Container gemappt. Das muss so bleiben: der Coolify-Proxy spricht HTTP,
er kann RTMP nicht weiterleiten.

In der Hetzner-Cloud-Konsole unter *Firewall → eingehend* freigeben:

| Port | Protokoll |
|---|---|
| 443 | TCP (die Web-App über Coolify) |
| 1935 | TCP (OBS) |
| 8890 | UDP (OBS über SRT, optional) |

Ohne diese Freigabe bleibt das Dashboard bei „Warte auf OBS-Signal" stehen.

---

## 5. Erstes Deployment

**Deploy** drücken und die Logs mitlesen. Der erste Build dauert ein paar
Minuten, weil Frontend und Server gebaut werden und ffmpeg ins Abbild kommt.

Wenn es läuft, sollte im Log des Dienstes `app` stehen:

```
INFO  [db] Migration anwenden: 001_init.sql
INFO  [db] Schema aktuell (3 Migrationen).
INFO  [users] Admin-Konto angelegt: du@example.de
INFO  [server] Bereit auf Port 3000.
```

Dann prüfen:

1. `https://stream.deinedomain.de/api/health` gibt `{"ok":true,...}` zurück.
2. Die Oberfläche lädt, Anmeldung mit `ADMIN_EMAIL` und `ADMIN_PASSWORD`.
3. Passwort in den Einstellungen ändern, danach `ADMIN_PASSWORD` in Coolify
   leeren und einmal neu deployen.

---

## 6. Auto-Deploy einschalten

Zwei Wege. Nimm **B**, wenn du nicht willst, dass ein kaputter Commit auf dem
Server landet.

### Weg A: Coolify hört direkt auf GitHub

Einfacher, aber es wird jeder Push deployt, auch ein versehentlich kaputter.

1. In der Ressource **Auto Deploy** einschalten.
2. Mit GitHub-App ist der Webhook schon da. Mit Deploy Key: in Coolify im Reiter
   **Webhooks** die Adresse und das Secret kopieren, dann im Repository unter
   *Settings → Webhooks → Add webhook*:
   - Payload URL: die Adresse aus Coolify
   - Content type: `application/json`
   - Secret: das Secret aus Coolify
   - Nur **Just the push event**

Testen: eine Kleinigkeit ändern, pushen, in Coolify muss ein Deployment
auftauchen.

### Weg B: nur geprüfte Commits deployen (empfohlen)

Hier stößt GitHub Actions das Deployment an, und zwar erst wenn die CI grün ist.
Die Dateien dafür liegen schon im Repository:
`.github/workflows/ci.yml` prüft, `.github/workflows/deploy.yml` löst aus.

1. In der Ressource **Auto Deploy** wieder **aus**schalten (sonst deployt
   Coolify zusätzlich bei jedem Push).
2. In Coolify im Reiter **Webhooks** die **Deploy-Webhook-URL** der Ressource
   kopieren, und unter *Keys & Tokens → API tokens* ein Token mit
   Deploy-Berechtigung anlegen.
3. In GitHub unter *Settings → Secrets and variables → Actions* zwei Secrets
   anlegen:
   - `COOLIFY_WEBHOOK` = die Deploy-Webhook-URL
   - `COOLIFY_TOKEN` = das API-Token
4. Fertig. Ab jetzt: Push auf `main` → CI läuft → nur bei grün wird deployt.

Fehlen die beiden Secrets, meldet der Deploy-Workflow das und endet
erfolgreich, ohne etwas zu tun. Du kannst also erst Weg A nehmen und später
wechseln.

Was die CI prüft, bevor irgendetwas deployt wird:

- Typen von Server und Frontend
- Frontend-Build
- `npm test`: die 37 Prüfungen, darunter der Umschalter gegen echtes ffmpeg und
  alle sechs Viewbot-Szenarien
- Der Docker-Build selbst, damit Fehler im Dockerfile nicht erst auf dem Server
  auffallen

---

## 7. Der Alltag: etwas ändern

Für Kleinigkeiten direkt auf `main`:

```bash
git add -A && git commit -m "Bitrate-Warnung früher anzeigen" && git push
```

Für alles, was schiefgehen kann, über einen Branch, damit die CI vor dem
Zusammenführen läuft:

```bash
git switch -c bitrate-warnung
```

```bash
git push -u origin bitrate-warnung
```

Dann auf GitHub einen Pull Request aufmachen. Die CI läuft am PR, und erst das
Zusammenführen nach `main` löst das Deployment aus.

Vorher lokal prüfen kostet eine Minute und erspart einen roten Build:

```bash
cd server && npm run build && npm test
```

### Was ein Deployment mit laufenden Streams macht

**Es beendet sie.** Der Container wird getauscht, und damit fallen die
ffmpeg-Prozesse weg, die gerade an Twitch, YouTube und Kick senden. Auch das
Ersatzbild hilft hier nicht: es überbrückt einen Ausfall von OBS, nicht einen
Neustart des Servers.

Daraus folgt die einzige Betriebsregel, die du dir merken musst: **nicht
deployen, während jemand streamt.** Im Admin-Bereich steht unter „Läuft gerade",
wer gerade sendet. Bei Weg B kannst du einen fertigen, grünen Commit auch
liegen lassen und das Deployment später über *Deploy* in Coolify oder über
*Actions → Deploy → Run workflow* auslösen.

---

## 8. Änderungen an der Datenbank

Das Schema wird beim Start selbst nachgezogen: alle `.sql`-Dateien in
`server/migrations` werden in Namensreihenfolge angewendet, und jede nur einmal
(festgehalten in der Tabelle `schema_migrations`).

Eine Änderung kommt also als **neue Datei** dazu, zum Beispiel
`server/migrations/004_was_auch_immer.sql`. Bestehende Dateien nie nachträglich
ändern: sie sind auf dem Server schon angewendet und werden nicht erneut
ausgeführt.

Nur hinzufügende Schritte schreiben, also `ADD COLUMN ... DEFAULT`,
`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX`. Dann läuft die alte Fassung
während des Deployments noch sauber weiter, und ein Rollback tut nicht weh.

---

## 9. Zurückrollen

In Coolify hat jedes Deployment seinen Eintrag. Beim vorigen auf **Redeploy**,
dann läuft wieder der alte Stand. Dauert so lange wie ein normaler Build.

Alternativ über Git, wenn ein Commit der Übeltäter ist:

```bash
git revert HEAD && git push
```

Das baut einen neuen Commit, der die Änderung zurücknimmt, und löst denselben
Weg aus wie jede andere Änderung. Besser als `git reset --force`, weil die
Historie heil bleibt.

Was ein Rollback **nicht** rückgängig macht: schon angewendete Migrationen. Noch
ein Grund, nur hinzufügende Schritte zu schreiben.

---

## 10. Was nie ins Repository gehört

| Nicht einchecken | Warum |
|---|---|
| `.env` | Darin stehen alle Geheimnisse. Steht in `.gitignore`. |
| `data/` | Uploads, aufbereitete Ersatzmedien, Vorschaubilder. Liegt auf dem Server im Volume `appdata`. |
| `node_modules/`, `dist/` | Wird gebaut. |
| Stream-Keys, Tokens | Liegen verschlüsselt in der Datenbank, nirgends im Code. |

Wenn doch einmal ein Geheimnis in einen Commit gerutscht ist: **nicht nur den
nächsten Commit aufräumen.** Es steht dann dauerhaft in der Historie. Das
betroffene Geheimnis bei der Plattform neu erzeugen und ersetzen, das ist
schneller und sicherer als die Historie umzuschreiben.

---

## 11. Wenn etwas klemmt

| Symptom | Ursache |
|---|---|
| Build bricht ab mit `npm ci can only install with an existing package-lock.json` | Die Lockfiles fehlen im Repository. `git add server/package-lock.json web/package-lock.json`. |
| Start bricht ab mit `SECRET_KEY fehlt` | Variable in Coolify nicht gesetzt. Die Compose-Datei bricht absichtlich ab, statt mit einem leeren Wert zu starten. |
| `Datenbank nicht erreichbar` in den Logs | Postgres ist noch nicht hochgefahren. Die App wartet bis zu 60 Sekunden; dauert es länger, im Log von `postgres` nachsehen. |
| Subdomain zeigt 502 | Die Domain zeigt nicht auf Port 3000 des Dienstes `app`, oder der Container ist noch im Health-Check. |
| Dashboard bleibt bei „Warte auf OBS-Signal" | Port 1935 in der Hetzner-Firewall zu, oder in OBS steht der falsche Stream-Key. |
| OAuth schlägt mit `redirect_mismatch` fehl | `PUBLIC_URL` und die Redirect-URI in der Entwickler-App stimmen nicht überein, oft ein Schrägstrich am Ende. |
| Push löst kein Deployment aus | Weg A: Auto Deploy aus oder Webhook fehlt. Weg B: die beiden GitHub-Secrets fehlen, dann steht das im Log des Deploy-Workflows. |
| Deployment läuft, aber alte Fassung bleibt | Coolify hat aus dem Cache gebaut. In der Ressource *Deploy without cache* benutzen. |
