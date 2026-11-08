# Viewbot-Simulator und Erkennungstest

Im Admin-Bereich unter **Viewbot-Simulator**.

## Wozu das da ist

Die Auffälligkeiten-Erkennung soll merken, wenn eine Zuschauerkurve nicht
natürlich aussieht — etwa weil dir jemand Bots schickt. Eine Erkennung, die
niemand geprüft hat, ist aber nur eine Behauptung. Der Simulator erzeugt genau
die Muster, die beim Botting auftreten, schickt sie durch **denselben
Detektor**, der auch echte Streams prüft, und sagt dir hinterher, was
angeschlagen hat und was durchgerutscht ist.

Damit kannst du die Schwellen einstellen, statt zu raten, und du weißt vorher,
worauf du dich im Ernstfall verlassen kannst.

## Was simuliert wird und was nicht

Simulierte Zuschauerzahlen gehen in die **eigene** Statistik-Pipeline: Proben,
Detektor, Dashboard, Diagramme, Exporte. Sie werden in der Datenbank immer mit
`synthetic = true` und der Lauf-Kennung geführt, im Diagramm orange markiert
und in CSV und PDF gekennzeichnet. Ein Bericht an einen Partner bleibt dadurch
wahr: man sieht, welcher Punkt gemessen und welcher erzeugt wurde.

Der Simulator schickt **keinen Verkehr an Twitch, YouTube oder Kick**. Das
könnte er auch nicht: deren Zuschauerzahl ist ein Messwert ihrer eigenen
Wiedergabe-Infrastruktur, den keine Schnittstelle beschreiben kann. Das Tool
liest diese Zahl ab und legt im Live-Modus einen Aufschlag darauf — bei uns,
nicht dort.

## Betriebsarten

**Durchrechnen (offline).** Legt eine eigene Test-Sitzung an, erzeugt die
komplette Kurve für die gewählte Dauer, lässt den Detektor darüber laufen und
zeigt direkt das Ergebnis mit Kurve und Treffern. Geht jederzeit, auch ohne
laufenden Stream. Das ist der Weg zum Einstellen der Schwellen.

**Live aufschlagen.** Legt die simulierte Zahl auf die echte Zuschauerzahl des
gewählten Kontos und läuft minutenweise mit. Das Dashboard zeigt dann
„Simulierte Zuschauer aktiv", und die Karte der Plattform weist den Aufschlag
getrennt aus. Nur sinnvoll, während wirklich gestreamt wird. Der Lauf endet von
selbst, wenn die eingestellte Dauer vorbei ist, und lässt sich jederzeit
abbrechen.

## Szenarien

| Szenario | Was es nachbaut | Soll erkannt werden als |
|---|---|---|
| **Plötzlicher Sprung** | Zahl springt ohne Raid in einer Minute hoch, die Chatter bleiben auf organischem Niveau | `spike` |
| **Glatte Kurve** | Der künstliche Anteil ist absolut konstant, die Kurve wird dadurch unnatürlich ruhig | `flat_curve` |
| **Chatter-Lücke** | Viele Zuschauer, fast niemand schreibt | `low_chat_ratio` |
| **Schleichender Anstieg** | Gleichmäßiger Zulauf wie von einem Taktgeber, unter organischem Rauschen | `smooth_steps` |
| **Treppenmuster** | Immer derselbe Zuwachs pro Minute | `smooth_steps` |
| **Echter Raid (Gegenprobe)** | Sprung **mit** Raid-Ereignis, danach fließen die Zuschauer wieder ab und chatten mit | **nichts** — darf nicht anschlagen |

Die Gegenprobe ist genauso wichtig wie der Rest. Eine Erkennung, die bei jedem
echten Raid Alarm schlägt, ist unbrauchbar.

## Ergebnisse lesen

| Ergebnis | Bedeutung |
|---|---|
| **Erkannt** | Alle erwarteten Muster haben angeschlagen. |
| **Teilweise erkannt** | Ein Teil fehlt. Die betreffende Schwelle ist zu locker. |
| **Nicht erkannt** | Durchgerutscht. Schwellen deutlich zu locker. |
| **Richtig nicht gemeldet** | Die Gegenprobe blieb still, so soll es sein. |
| **Falscher Alarm** | Bei der Gegenprobe wurde etwas gemeldet. Schwellen zu streng. |

Dass bei einem Szenario **mehr** anschlägt als erwartet, ist meist richtig und
kein Fehler: ein künstlicher Sprung erzeugt danach zwangsläufig auch ein
flaches Plateau, und bei der Chatter-Lücke ist die Kurve ebenfalls auffällig
ruhig. Gewertet wird, ob das erwartete Muster dabei ist.

## Die Schwellen

Im Panel unter **Aktuelle Schwellen** einsehbar, gesetzt in
`server/src/stats/detector.ts` (`defaultDetectorConfig`):

| Schwelle | Vorgabe | Wirkung |
|---|---|---|
| `spikeMinAbsolute` | 25 | So viele Zuschauer müssen mindestens auf einmal dazukommen. |
| `spikeFactor` | 2,5 | Und die Zahl muss sich mindestens so vervielfachen. |
| `raidWindowSec` | 180 | Ein Raid in diesem Fenster erklärt den Sprung. |
| `flatMaxStdDev` | 1,2 | Streuung, unter der eine Kurve als unnatürlich ruhig gilt. |
| `flatMinViewers` | 30 | Erst ab so vielen Zuschauern geprüft. |
| `minChatRatio` | 0,005 | Weniger als 0,5 % Chatter gilt als Lücke. |
| `chatRatioMinViewers` | 50 | Erst ab so vielen Zuschauern geprüft. |
| `smoothMaxDiffStdDev` | 0,8 | Treppe: Streuung der Zuwächse. |
| `smoothMinR2` | 0,97 | Gerade: Güte der Linie durch das Fenster. |
| `dropFactor` | 0,4 | Einbruch auf diesen Anteil in einem Schritt. |

Zwei Dinge, die beim Entwickeln des Prüfstands herausgekommen sind und die man
wissen sollte:

1. **Ein gleichmäßiger Anstieg lässt sich nicht an den Zuwächsen allein
   erkennen.** Unter dem künstlichen Zulauf wackelt der organische Anteil
   weiter, und die Streuung der Zuwächse ist dann zu groß. Deshalb legt der
   Detektor zusätzlich eine Gerade durch das Fenster und bewertet, wie gut sie
   passt (`smoothMinR2`). Ein Bot-Zulauf liegt fast perfekt auf einer Linie,
   organisches Wachstum nicht.
2. **Nur steigende Verläufe werden gemeldet.** Eine gleichmäßig *fallende*
   Kurve ist das normale Abfließen nach einem Raid und sah im Test zunächst wie
   ein Muster aus. Ein künstlicher Zulauf geht nach oben, und ein künstliches
   Plateau fängt bereits `flat_curve` ab.

Nach einer Änderung an den Schwellen die Szenarien erneut durchrechnen, auch
die Gegenprobe.

## Für einen Vorfall, der dir wirklich passiert

Wenn jemand dir Bots schickt, brauchst du etwas Belegbares:

1. Im Reiter **Statistiken** den betroffenen Stream wählen.
2. Unter **Auffälligkeiten** stehen Zeitpunkt, Bewertung und die Rohwerte,
   auf denen der Hinweis beruht.
3. **PDF-Bericht** herunterladen. Er enthält die Kurve, die Marken an den
   auffälligen Stellen, die Rohwerte und die Kennzeichnung, was gemessen und
   was simuliert war.
4. Dazu passend die **CSV** für die Messpunkte im Minutentakt.

Das sind Hinweise, keine Urteile, und so sind sie auch formuliert. Genau in der
Form kann man sie bei der Plattform einreichen.

## Läufe aufräumen

Jeder Lauf steht in der Tabelle **Bisherige Läufe**. Löschen entfernt den Lauf
samt der synthetischen Test-Sitzung und ihren Proben, damit die Statistik
sauber bleibt. Live-Läufe schlagen nur auf, sie erzeugen keine eigene Sitzung.
