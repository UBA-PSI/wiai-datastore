# Eine App mit WIAI Datastore nutzen

Apps der Universität Bamberg, die auf diesen Speicher hinweisen, legen Ihre Daten auf einem Server der Fakultät ab. Die Daten
werden **auf Ihrem Gerät verschlüsselt, bevor sie gesendet werden**. Diese Seite erklärt, was Sie brauchen, was Sie sicher aufbewahren
müssen und wer was sehen kann. [English version]({{base}}/docs/users.en)

## Was Sie brauchen

1. **Einen Beitrittscode** von der Person, die die App betreibt. Sie brauchen ihn einmal, um Ihren Tresor anzulegen.
2. **Eine eigene Passphrase** mit mindestens 12 Zeichen. Vier oder mehr unzusammenhängende Wörter eignen sich gut
   („lila Elefant marschiert langsam“). Die App weist sehr verbreitete Passphrasen (auch deutsche wie „ichliebedich123“) und solche aus bekannten Datenlecks zurück. Ist die Prüfung auf Datenlecks nicht erreichbar oder für die App abgeschaltet, verlangt sie eine stärkere Passphrase. Wenn Sie eine Passphrase wählen, prüft Ihr Browser sie beim Dienst Pwned Passwords (USA) auf bekannte Datenlecks; der Dienst erhält Ihre IP-Adresse und die ersten fünf Zeichen einer Prüfsumme der Passphrase, nie die Passphrase selbst.
3. **Ihr Zugangsblatt.** Nach dem Anlegen des Tresors zeigt die App es an: Ihre **Zugangskennung** (fünf Gruppen zu vier Zeichen) und
   Ihren **Wiederherstellungscode**. Drucken oder speichern Sie das Blatt und bewahren Sie es getrennt von Ihrem Rechner auf.

**Niemand kann Ihre Passphrase zurücksetzen.** Der Server kennt sie nicht. Wenn Sie sie verlieren, hilft nur das
Wiederherstellungsverfahren weiter unten.

## Zugangskennung, Schlüsseldatei, Wiederherstellungscode

| Was | Wofür | Geheim? |
|---|---|---|
| Zugangskennung | Benennt Ihren Tresor. Sie geben sie auf einem neuen Gerät zusammen mit der Passphrase ein. | Nein, bewahren Sie sie beim Zugangsblatt auf. |
| Schlüsseldatei | Kleine Datei mit der App und Ihrer Zugangskennung. Wählen Sie sie auf einem neuen Gerät in der App aus, statt die Kennung abzutippen. | Nein. Sie enthält keine Passphrase. |
| Passphrase | Öffnet Ihre Daten. Nur im Kopf oder in Ihrem Passwortmanager. | Ja |
| Wiederherstellungscode | Erlaubt der Fakultät, Ihren Zugang wiederherzustellen, wenn Sie die Passphrase verlieren. | Ja. Getrennt vom Rechner aufbewahren. |

## Auf einem neuen Gerät oder nach dem Löschen des Browserspeichers

Öffnen Sie die App, geben Sie Ihre Zugangskennung ein (oder wählen Sie die Schlüsseldatei aus) und Ihre Passphrase. Die App meldet:
„Dieses Gerät ist neu für Ihren Tresor.“ Das ist normal.

## Teilen

Eigentümerinnen und Eigentümer teilen ihren ganzen Tresor: Wählen Sie in der App **Tresor**, eine Rolle und erzeugen Sie einen Einladungscode.

- **Darf bearbeiten**: darf lesen und ändern. **Nur lesen**: darf nur lesen.
- Schicken Sie den Code über einen anderen Weg als die App selbst (persönlich, Chat). Er läuft nach 2 Tagen ab.
- Die andere Person gibt den Code in der App ein und wählt eine **eigene Passphrase**. Bei Ihnen erscheint „Eine Einladung wurde eingelöst.“
- **Entziehen** beendet den Zugang sofort. Danach verschlüsselt die App alle Daten mit neuen Schlüsseln neu. Bei großen Tresoren dauert das
  eine Weile und setzt sich von selbst fort, wenn Sie die Seite schließen.
- Wem der Zugang entzogen wurde, behält, was schon heruntergeladen war.

## Wenn zwei Personen dasselbe ändern

Die App fragt nach, bevor sie etwas überschreibt. Der Standarddialog meldet „Ein anderes Gerät oder eine andere Person hat eine neuere Version
gespeichert“ und bietet **Andere behalten**, **Meine behalten** und **Beide herunterladen** an. Apps dürfen einen eigenen Dialog zeigen, der
dieselbe Wahl anders beschriftet (zum Beispiel **Neuere Fassung behalten** und **Meine Fassung behalten**). Wenn Sie Ihre Version behalten, bleibt die
andere im Verlauf und lässt sich wiederherstellen. Viele Apps zeigen einen Verlauf früherer Versionen.

## Was die Fakultät sehen kann

Kurz gesagt: **Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel.** Die Einzelheiten:

- Der Server speichert nur verschlüsselte Daten. Er sieht, welche App Sie nutzen, wie viele Einträge Sie haben, wie groß sie sind, wann sie
  sich geändert haben und wie viele Personen Zugang haben (als anonyme Einträge). Namen, Texte und Dateien sieht er nicht.
- Die Zugriffsprotokolle des Webservers sind für diesen Dienst abgeschaltet. IP-Adressen dienen nur der Begrenzung von Anfragen und werden nur im
  Arbeitsspeicher gehalten.
- **Die Ausnahme:** Die Fakultät verwahrt einen Wiederherstellungsschlüssel (Treuhandschlüssel), offline beim Betreiber. Wer diesen Schlüssel besitzt, kann jeden
  Tresor entschlüsseln. Er wird nur im Wiederherstellungsverfahren unten verwendet, jede Nutzung wird protokolliert.
- Die App selbst sieht Ihre Daten, solange sie läuft. Nutzen Sie nur Apps, denen Sie vertrauen.
- Es gibt verschlüsselte Sicherungen des Servers. Nachdem Sie Daten gelöscht haben oder jemand den Zugang verliert, bleiben alte Kopien für die
  in den [Datenschutzhinweisen]({{base}}/privacy) genannte Zeit in Sicherungen.

## Wiederherstellung bei vergessener Passphrase

1. Wenden Sie sich an die Person, die die App betreibt. Sie gibt Ihre Anfrage an den Betreiber des Dienstes weiter. Halten Sie Ihre
   **Zugangskennung** und den **Wiederherstellungscode** bereit.
2. Der Betreiber startet die Wiederherstellung. Mit dem Wiederherstellungscode beginnt eine **Wartezeit von 72 Stunden**. In dieser Zeit
   zeigt jedes Entsperren Ihres Tresors „Für diesen Tresor wurde eine Wiederherstellung beantragt“ mit der Schaltfläche **Antrag abbrechen**. Wenn Sie sie
   nicht beantragt haben, brechen Sie ab und informieren Sie den Betreiber.
3. Nach der Wartezeit fügt der Betreiber Ihrem Tresor einen neuen Zugang als Eigentümerin oder Eigentümer hinzu und gibt Ihnen einen Einladungscode. Sie lösen ihn
   ein und wählen eine neue Passphrase. Die App meldet „Die Fakultät hat einen Eigentümer-Zugang hinzugefügt“ und bittet um Bestätigung.
4. Der alte Zugang wird nicht automatisch entfernt. Öffnen Sie **Tresor** und entziehen Sie ihn.

Ohne Wiederherstellungscode geht es nur, wenn Sie beim Anlegen eine E-Mail-Adresse als Wiederherstellungskontakt hinterlegt haben. Die Wartezeit
beträgt dann 7 Tage. Fehlt beides, lassen sich Ihre Daten nicht wiederherstellen.

## Daten aus einer früheren Version der App

Gab es die App vorher als Version, die ihre Daten nur in Ihrem Browser gespeichert hat, fragt die neue Version beim Öffnen nach: „In diesem Browser liegen … Einträge aus einer früheren Version dieser App … Sollen sie in Ihren Tresor kopiert werden?“

- Die App kopiert die Einträge in Ihren Tresor und löscht noch nichts. Sehen Sie sich die Einträge in der App an. Beim **nächsten Start** fragt die App, ob alles da ist, und löscht nach Ihrer Bestätigung die alte Kopie im Browser („Später“ behält sie und fragt wieder). Enthält Ihr Tresor schon eine andere Version eines Eintrags, entscheiden Sie, welche bleibt; die alte Kopie wird nach Ihrer Bestätigung mit den übrigen gelöscht, laden Sie also vorher eine Kopie herunter, wenn Sie die alte Version behalten möchten.
- **Laden Sie vorher eine Kopie herunter** (ein Link in der Frage), wenn Sie eine möchten: eine ZIP-Datei mit allen alten Einträgen und ihren Dateien. Sie ist **nicht verschlüsselt**; bewahren Sie sie sicher auf oder löschen Sie sie, nachdem Sie hineingeschaut haben.
- „Später“ ändert nichts; die alten Daten bleiben unverschlüsselt in diesem Browser, und die App fragt beim nächsten Mal wieder.
- Das kann nur die Eigentümerin oder der Eigentümer eines Tresors. Wurden Sie in den Tresor einer anderen Person eingeladen, lässt die App die alten Daten in Ruhe und zeigt nichts an; übernehmen Sie sie in einem eigenen Tresor.
- Öffnen Sie die neue Version so, wie Sie die alte geöffnet haben (dieselbe Datei am selben Ort oder dieselbe Webadresse): Ein Browser verwahrt die Daten jeder Adresse getrennt.

## Ihre Daten, Ihr Export

Wählen Sie in der App **Tresor** und dann **Alles exportieren** oder öffnen Sie [{{base}}/export/]({{base}}/export/) in einem beliebigen Browser, geben Sie App-ID und
Zugangskennung (oder Schlüsseldatei) sowie Ihre Passphrase ein und laden Sie alles entschlüsselt als ZIP-Datei herunter. Die Dateien sind nicht
verschlüsselt: Bewahren Sie sie sorgfältig auf.

**Dateien, die Sie aus einer App herunterladen, sind nicht verschlüsselt**, gleich was es ist: eine CSV-Tabelle, ein Anhang, eine PDF-Datei, das Export-ZIP. Sobald eine Datei auf Ihrem Rechner liegt, schützt sie nur das, was Ihren Rechner schützt.
