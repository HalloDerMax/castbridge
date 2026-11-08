# Einrichtung und Betrieb

Alles, was einmalig von Hand passieren muss. Reihenfolge einhalten, dann geht
nichts schief.

---

## 1. Subdomain

Einen A-Record auf die IP des Hetzner-Servers zeigen lassen, zum Beispiel
`stream.deinedomain.de`. Diese Adresse kommt später in `PUBLIC_URL` und
`INGEST_HOST`.

---

## 2. Hetzner-Firewall

Zwei Ports müssen offen sein, die **nicht** über den Coolify-Proxy laufen:

| Port | Protokoll | Wofür |
|---|---|---|
| 1935 | TCP | RTMP aus OBS |
| 8890 | UDP | SRT aus OBS (nur bei wackeliger Leitung nötig) |
| 443 | TCP | die Web-App über Coolify |

In der Hetzner-Cloud-Konsole: Firewall → Regeln → eingehend. Ohne diese
Freigabe kommt das OBS-Signal nicht an, und das Dashboard bleibt bei „Warte
auf OBS-Signal" stehen.

---

## 3. Entwickler-Apps anlegen

Das macht **nur der Admin einmalig**. Nutzer müssen nie in Developer-Tools.

Überall gebraucht wird die Rücksprung-Adresse (Redirect URI). Sie lautet:

```
https://DEINE-SUBDOMAIN/api/platforms/twitch/callback
https://DEINE-SUBDOMAIN/api/platforms/youtube/callback
https://DEINE-SUBDOMAIN/api/platforms/kick/callback
```

### 3.1 Twitch

1. <https://dev.twitch.tv/console/apps> öffnen, mit dem Twitch-Konto anmelden.
2. **Register Your Application**.
3. Name frei wählen, zum Beispiel `Castbridge`.
4. **OAuth Redirect URLs**: die Twitch-Adresse von oben eintragen.
5. Category: *Broadcasting Suite*.
6. Client Type: *Confidential*.
7. Anlegen, dann **Client ID** kopieren und **New Secret** erzeugen.
8. In die `.env`:
   ```
   TWITCH_CLIENT_ID=...
   TWITCH_CLIENT_SECRET=...
   ```

Die App fragt diese Rechte an: Stream-Key lesen, Kanal verwalten (Titel und
Kategorie), Abos und Follower lesen, Chat lesen. Schreiben im Chat ist nicht
dabei.

### 3.2 YouTube (Google Cloud)

1. <https://console.cloud.google.com/> öffnen, Projekt anlegen.
2. **APIs & Dienste → Bibliothek** → *YouTube Data API v3* suchen und
   aktivieren.
3. **APIs & Dienste → OAuth-Zustimmungsbildschirm**:
   - Nutzertyp *Extern*.
   - App-Name, Support-Mail, Entwickler-Mail ausfüllen.
   - Bereiche (Scopes) hinzufügen:
     `https://www.googleapis.com/auth/youtube` und
     `https://www.googleapis.com/auth/youtube.readonly`.
   - Unter **Testnutzer** jede Google-Adresse eintragen, die das Tool nutzen
     soll. Ohne diesen Eintrag lehnt Google die Anmeldung ab.
4. **Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID**:
   - Typ *Webanwendung*.
   - Autorisierte Weiterleitungs-URI: die YouTube-Adresse von oben.
5. Client-ID und Secret in die `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

**Zum Warnbildschirm:** Solange die App nicht von Google geprüft ist, erscheint
beim Verbinden „Google hat diese App nicht überprüft". Dort auf **Erweitert**
und dann **Weiter zu … (unsicher)**. Für einen kleinen Kreis ist das in
Ordnung. Die offizielle Prüfung kann man später beantragen, sie ist erst nötig,
wenn der Nutzerkreis wächst. Das Tool zeigt diesen Hinweis auch in der
Oberfläche an.

**Zum Tageskontingent:** Die YouTube Data API hat ein Tagesbudget. Der Chat
wird nur im Takt abgefragt, den Google selbst vorschlägt, mindestens aber alle
5 Sekunden, und bei `quotaExceeded` stellt der Chat ab und meldet das im
Dashboard, statt weiter zu laufen. Reicht es dauerhaft nicht, lässt sich bei
Google eine Erhöhung beantragen.

### 3.3 Kick

1. <https://kick.com/settings/developer> öffnen (Kick-Konto nötig).
2. Neue App anlegen.
3. Redirect URI: die Kick-Adresse von oben.
4. Webhook-URL eintragen:
   ```
   https://DEINE-SUBDOMAIN/api/platforms/kick/webhook
   ```
   Darüber kommen Chat und Ereignisse herein. Jede Nachricht wird gegen Kicks
   öffentlichen Schlüssel geprüft, ungültig signierte Aufrufe werden verworfen.
5. Client-ID und Secret in die `.env`:
   ```
   KICK_CLIENT_ID=...
   KICK_CLIENT_SECRET=...
   ```

**Zum Stream-Key:** Ob Kick ihn über die Schnittstelle herausgibt, hängt an den
Rechten der App. Das Tool probiert beim Verbinden drei Endpunkte. Klappt keiner,
bleibt alles funktionsfähig: in den Einstellungen steht dann „Key manuell
eintragen" samt Anleitung, wo man ihn im Kick-Dashboard findet. Kick verlangt
**RTMPS**, das ist eingebaut und wird beim manuellen Eintragen auch geprüft.

---

## 4. Vor dem ersten Stream: Exklusivität prüfen

Wenn ein Twitch-Vertrag besteht (Affiliate oder Partner), die Bedingungen zum
gleichzeitigen Streamen auf anderen Plattformen lesen. Twitch hat das 2024
gelockert, aber die Regeln unterscheiden sich je nach Vertrag. Das ist eine
Vertragsfrage, keine technische.

---

## 5. Deployment in Coolify

Das Deployment läuft über GitHub: du pushst, Coolify baut und tauscht den
Container. Schritt für Schritt steht das in **[DEPLOY.md](DEPLOY.md)**, vom
Anlegen des Repositorys bis zum automatischen Aktualisieren bei jeder Änderung.

Die Kurzfassung:

1. `restream-tool` als eigenes, privates Repository auf GitHub.
2. In Coolify eine Ressource vom Typ **Docker Compose** aus diesem Repository,
   Branch `main`, Compose-Datei `docker-compose.yml`.
3. Die Werte als **Umgebungsvariablen der Ressource** eintragen, nicht als
   Datei im Repository. Pflicht sind `PUBLIC_URL`, `INGEST_HOST`, `SECRET_KEY`,
   `SESSION_SECRET` und `POSTGRES_PASSWORD`; `DATABASE_URL` baut die
   Compose-Datei daraus selbst.
4. Die Subdomain auf den Dienst `app`, Port **3000**, zeigen lassen.
5. **Wichtig:** Die Ports 1935/TCP und 8890/UDP sind direkt am
   MediaMTX-Container gemappt. Coolify darf sie nicht durch seinen Proxy
   schicken, der spricht nur HTTP. Nichts daran ändern.
6. Deployen. Beim ersten Start legt die App das Schema an und erzeugt aus
   `ADMIN_EMAIL` und `ADMIN_PASSWORD` das Admin-Konto.

Nach dem Deploy anmelden, Passwort ändern, und im Admin-Bereich den ersten
Einladungslink erzeugen.

---

## 6. Der erste Durchlauf, zum Prüfen

Das dauert etwa 15 Minuten und klärt die offenen Punkte.

1. **Einrichtungsassistent** durchklicken: Speedtest, mindestens eine Plattform
   verbinden, OBS-Werte übernehmen, Overlay-URL kopieren.
2. In OBS: Einstellungen → Stream → Dienst *Benutzerdefiniert*, Server und
   Schlüssel aus dem Assistenten. Encoder-Einstellungen: CBR, Bitrate wie
   empfohlen, Keyframe-Abstand 2 s, H.264.
3. Stream in OBS starten. Im Dashboard muss **„OBS-Signal empfangen"** mit
   Auflösung, FPS, Bitrate und Codec erscheinen, und noch darf nichts live sein.
4. **Eine** Plattform live schalten und dort nachsehen, ob der Stream ankommt.
5. Dann die anderen dazu. Jede einzeln stoppen und wieder starten, die anderen
   dürfen davon nichts merken.
6. **Umschalter prüfen** — das ist der wichtigste Test:
   - In den Einstellungen ein Ersatzbild hochladen.
   - Bei laufendem Stream in OBS auf *Stream beenden*.
   - Im Dashboard muss „Ersatzbild überbrückt gerade" erscheinen, und bei den
     Plattformen muss der Stream **weiterlaufen**, jetzt mit dem Ersatzbild.
   - In OBS wieder starten. Das Tool muss von selbst zurückschalten.
   - Falls eine Plattform dabei doch abbricht: Logs des Dienstes `app` ansehen.
     Steht dort „Codec-Parameter der neuen Quelle weichen ab", passt das
     aufbereitete Ersatzmedium noch nicht exakt zum OBS-Signal. Dann in OBS die
     Auflösung und FPS festnageln (keine automatische Skalierung) und das
     Ersatzbild neu hochladen.
7. Chat in allen drei Chats testen, auch mit Emotes, und eine Nachricht von
   einem Mod löschen lassen: sie muss auch im Overlay verschwinden.
8. Overlay-URL in OBS als Browserquelle einsetzen, Breite 420, Höhe 700.

---

## 7. Laufender Betrieb

- **Traffic:** pro Streamstunde und Nutzer etwa 8 GB bei 3 Plattformen und
  6 Mbit/s. Zwei Nutzer, 4 Stunden, 20 Tage ≈ 1,3 TB im Monat. Bei Hetzner sind
  in der Regel 20 TB dabei. Im Admin-Bereich steht eine Schätzung aus Laufzeit
  und Bitrate.
- **CPU:** im Normalbetrieb kaum belastet, weil nicht neu kodiert wird. Last
  entsteht nur beim Aufbereiten des Ersatzmediums und für die Vorschaubilder.
- **Limit gleichzeitiger Streams:** im Admin-Bereich einstellbar. Darüber hinaus
  werden neue Sender abgewiesen, damit der Server nicht umkippt.
- **Datensparsamkeit:** Chatverlauf lässt sich über
  `POST /api/chat/history/clear` mit `olderThanDays` kürzen.
- **Schlüssel wechseln:** Ingest-Key und Overlay-URL kann jeder Nutzer selbst
  neu erzeugen. Beim Ingest-Key wird ein laufender Stream dabei getrennt.

---

## 8. Wenn etwas nicht geht

| Symptom | Ursache und Abhilfe |
|---|---|
| Dashboard bleibt bei „Warte auf OBS-Signal" | Port 1935 nicht offen, oder Stream-Key falsch. Der Key ist der Ingest-Key aus dem Assistenten, nicht der von Twitch. |
| MediaMTX lehnt den Publish ab | In den Logs von `app` steht „Publish mit unbekanntem Ingest-Key abgelehnt". Key neu kopieren. |
| Plattform bricht nach Sekunden ab | Bitrate zu hoch (Twitch nimmt bei H.264 etwa 6000 kbps), oder Codec ist nicht H.264. Das Dashboard warnt vorher. |
| Kick nimmt nichts an | Kick verlangt RTMPS. Die Server-URL muss mit `rtmps://` beginnen. |
| YouTube-Chat bleibt leer | Die Chat-ID entsteht erst, wenn die Sendung läuft. Das Tool versucht es alle 30 Sekunden erneut. |
| „App nicht überprüft" bei Google | Erwartet, siehe 3.2. Erweitert → Trotzdem fortfahren. |
| Overlay bleibt schwarz | Overlay-URL neu erzeugt? Dann in OBS die Browserquelle aktualisieren. |
