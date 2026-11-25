# Eine App mit WIAI Datastore nutzen

Apps der Universität Bamberg, die auf diesen Speicher hinweisen, legen Ihre Daten auf einem Server der Fakultät ab. Die Daten
werden **auf Ihrem Gerät verschlüsselt, bevor sie gesendet werden**. Diese Seite erklärt, was Sie brauchen, was Sie sicher aufbewahren
müssen und wer was sehen kann. [English version]({{base}}/docs/users.en)

## Was Sie brauchen

1. **Einen Beitrittscode** von der Person, die die App betreibt. Sie brauchen ihn einmal, um Ihren Tresor anzulegen.
2. **Eine eigene Passphrase** mit mindestens 12 Zeichen. Vier oder mehr unzusammenhängende Wörter eignen sich gut
   („lila Elefant marschiert langsam“). Die App weist sehr verbreitete Passphrasen (auch deutsche wie „ichliebedich123“) und solche aus bekannten Datenlecks zurück. Ist die Prüfung auf Datenlecks nicht erreichbar oder für die App abgeschaltet, verlangt sie eine stärkere Passphrase.
   Für diese Prüfung gehen nur die ersten fünf Zeichen eines Hashwerts Ihrer Passphrase an den Dienst Pwned Passwords in den USA,
   nie die Passphrase selbst.
3. **Ihr Zugangsblatt.** Nach dem Anlegen des Tresors zeigt die App es an: Ihre **Zugangskennung** (fünf Gruppen zu vier Zeichen) und
   Ihren **Wiederherstellungscode**. Drucken oder speichern Sie das Blatt und bewahren Sie es getrennt von Ihrem Rechner auf.

**Niemand kann Ihre Passphrase zurücksetzen.** Der Server kennt sie nicht. Wenn Sie sie verlieren, hilft nur das
Wiederherstellungsverfahren weiter unten.

## Zugangskennung, Schlüsseldatei, Wiederherstellungscode

| Was | Wofür | Geheim? |
|---|---|---|
| Zugangskennung | Benennt Ihren Tresor. Sie geben sie auf einem neuen Gerät zusammen mit der Passphrase ein. | Nein, bewahren Sie sie beim Zugangsblatt auf. |
| Schlüsseldatei | Kleine Datei mit der App und Ihrer Zugangskennung. Ziehen Sie sie auf einem neuen Gerät in die App, statt die Kennung abzutippen. | Nein. Sie enthält keine Passphrase. |
| Passphrase | Öffnet Ihre Daten. Nur im Kopf oder in Ihrem Passwortmanager. | Ja |
| Wiederherstellungscode | Erlaubt der Fakultät, Ihren Zugang wiederherzustellen, wenn Sie die Passphrase verlieren. | Ja. Getrennt vom Rechner aufbewahren. |

## Auf einem neuen Gerät oder nach dem Löschen des Browserspeichers

Öffnen Sie die App, geben Sie Ihre Zugangskennung ein (oder ziehen Sie die Schlüsseldatei hinein) und Ihre Passphrase. Die App meldet:
„Dieses Gerät ist neu für Ihren Tresor.“ Das ist normal.

## Teilen

Eigentümerinnen und Eigentümer teilen ihren ganzen Tresor: Wählen Sie in der App **Teilen**, eine Rolle und erzeugen Sie einen Einladungscode.

- **Darf bearbeiten**: darf lesen und ändern. **Nur lesen**: darf nur lesen.
- Schicken Sie den Code über einen anderen Weg als die App selbst (persönlich, Chat). Er läuft nach der gewählten Zeit ab.
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
4. Der alte Zugang wird nicht automatisch entfernt. Öffnen Sie **Teilen** und entziehen Sie ihn.

Ohne Wiederherstellungscode geht es nur, wenn Sie beim Anlegen eine E-Mail-Adresse als Wiederherstellungskontakt hinterlegt haben. Die Wartezeit
beträgt dann 7 Tage. Fehlt beides, lassen sich Ihre Daten nicht wiederherstellen.

## Wenn ein Dialog „Testumgebung“ sagt

Beginnt ein Dialog mit **Testumgebung** (oder weist eine Leiste am oberen Rand der Seite darauf hin), sind Sie in einer **Testkopie** einer App. Geben Sie keine echten Daten ein. Alles in der Testumgebung wird **jede Nacht gelöscht**,
es gibt keinen Wiederherstellungscode, und niemand kann einen Tresor der Testumgebung wiederherstellen. Entwicklerinnen und Entwickler probieren dort ihre Apps aus; es ist kein Ort, um etwas aufzubewahren.

## Ihre Daten, Ihr Export

Nutzen Sie die Export-Schaltfläche der App (meist **Export**) oder öffnen Sie [{{base}}/export/]({{base}}/export/) in einem beliebigen Browser, geben Sie App-ID und
Zugangskennung (oder Schlüsseldatei) sowie Ihre Passphrase ein und laden Sie alles entschlüsselt als ZIP-Datei herunter. Die Dateien sind nicht
verschlüsselt: Bewahren Sie sie sorgfältig auf.

**Dateien, die Sie aus einer App herunterladen, sind nicht verschlüsselt**, gleich was es ist: eine CSV-Tabelle, ein Anhang, eine PDF-Datei, das Export-ZIP. Sobald eine Datei auf Ihrem Rechner liegt, schützt sie nur das, was Ihren Rechner schützt.
