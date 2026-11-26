"""The Art. 13 GDPR notice, one page for two groups (PLAN 13, 16): people who use apps and staff who use the dashboard.

Served at /datastore/privacy (German by default, English with ?lang=en or an English Accept-Language). The only variable
parts come from the configuration: the date ([privacy] updated) and the sentence about VM-level backups
([privacy] backup_retention_de / backup_retention_en), which the operator decides.
"""

from __future__ import annotations

from .service import AUDIT_RETENTION, DELETED_VAULT_TTL, EMPTY_VAULT_TTL
from .ui import Ctx, esc, render

PLACEHOLDER_UPDATED = ("wird festgelegt", "to be set")


def updated_text(cfg, de: bool) -> str:
    """The "Stand" line in the language of the page only: updated_de / updated_en, else [privacy] updated (a value of the form
    "German text / English text" is split), else the placeholder."""
    specific = cfg.privacy_updated_de if de else cfg.privacy_updated_en
    if specific:
        return specific
    value = cfg.privacy_updated
    if value:
        parts = [p.strip() for p in value.split(" / ")]
        if len(parts) == 2 and all(parts):
            return parts[0 if de else 1]
        return value
    return PLACEHOLDER_UPDATED[0 if de else 1]


def _window(sb, de: bool) -> str:
    """The per-IP counting window in words: "eine Stunde" / "30 Minuten"."""
    n, unit = (sb.create_window // 3600, ("eine Stunde", "Stunden") if de else ("one hour", "hours")) \
        if sb.create_window % 3600 == 0 else (sb.create_window // 60, ("eine Minute", "Minuten") if de else ("one minute", "minutes"))
    return unit[0] if n == 1 else f"{n} {unit[1]}"


def _toc_sandbox_de(cfg) -> list:
    return [("sandbox", "Testumgebung (Sandbox)")] if cfg.sandbox else []


def _toc_sandbox_en(cfg) -> list:
    return [("sandbox", "The sandbox")] if cfg.sandbox else []


def _sandbox_de(cfg) -> str:
    """Section 10, only on servers that run the public sandbox ([sandbox] in the configuration)."""
    sb = cfg.sandbox
    if sb is None:
        return ""
    return f"""
<h2 id="sandbox">10. Testumgebung (Sandbox)</h2>
<p>Neben den Apps der Fakultät gibt es eine öffentliche <strong>Testumgebung</strong>. Jede Person darf dort ohne Beitrittscode einen Tresor anlegen,
um Apps auszuprobieren; die Bibliothek nennt sie in jedem Dialog „Testumgebung“. <strong>Speichern Sie dort keine echten Daten.</strong></p>
<ul>
<li><strong>Löschung:</strong> Alle Tresore der Testumgebung werden jede Nacht gelöscht, gegen {esc(sb.wipe_time)} Uhr ({esc(sb.timezone)}) und bis etwa eine Stunde danach.
Tresore, die erst nach diesem Zeitpunkt angelegt wurden, bleiben bis zur folgenden Nacht. Ist die Testumgebung voll, entfernen wir die ältesten Tresore früher, die seit mindestens {sb.evict_min_age // 60} Minuten nicht geändert wurden.</li>
<li><strong>Keine Wiederherstellung:</strong> Für die Testumgebung gibt es kein Wiederherstellungsverfahren und keine Kontakt-E-Mail-Adresse. Technisch öffnet der
Wiederherstellungsschlüssel der Fakultät (Abschnitt 4) auch Tresore der Testumgebung; der Server lehnt Wiederherstellungsanfragen für sie ab, und es gibt dafür keinen eigenen Schlüsselsatz.
Bei Missbrauch schalten wir die Testumgebung ab oder leeren sie, wir öffnen keine Tresore.</li>
<li><strong>Schutz vor Missbrauch:</strong> Der Server zählt im Arbeitsspeicher, wie viele Tresore ein Netzbereich (IPv4-Adresse oder IPv6-/{sb.create_ipv6_prefix}-Präfix) anlegt
(höchstens {_window(sb, True)}, nicht gespeichert, Abschnitt 3), und wie viele Tresore die Testumgebung insgesamt in kurzer Zeit anlegt.</li>
<li><strong>Protokoll und Kennungen:</strong> Anlegen, vorzeitiges Entfernen und die nächtliche Löschung werden ohne IP-Adressen protokolliert (Abschnitt 7). Die zufällige Zugangskennung
eines gelöschten Tresors bleibt gespeichert, damit sie nie erneut vergeben wird (sie enthält keine Angaben zur Person); die Protokolleinträge folgen den Fristen aus Abschnitt 7.</li>
<li><strong>Wer die Testumgebung nutzt:</strong> Sie steht allen offen und braucht kein Konto. Die Verarbeitung dient wie in Abschnitt 2 der Lehre und Forschung der Universität; es werden dort keine Angaben zu Ihrer Person erhoben.</li>
</ul>"""


def _sandbox_en(cfg) -> str:
    sb = cfg.sandbox
    if sb is None:
        return ""
    return f"""
<h2 id="sandbox">10. The sandbox</h2>
<p>Besides the faculty's apps there is a public <strong>sandbox</strong>. Anybody may create a vault there without a join code, to try out apps;
the library calls it "Sandbox" in every dialog. <strong>Do not store real data there.</strong></p>
<ul>
<li><strong>Deletion:</strong> Every vault of the sandbox is deleted every night, around {esc(sb.wipe_time)} ({esc(sb.timezone)}) and up to about an hour after.
Vaults created after that time stay until the following night. When the sandbox is full, we remove the oldest vaults earlier that have not been changed for at least {sb.evict_min_age // 60} minutes.</li>
<li><strong>No recovery:</strong> There is no recovery procedure and no contact e-mail address in the sandbox. Technically the faculty's recovery key (section 4)
also opens sandbox vaults; the server refuses recovery requests for them, and there is no separate key set for it.
In case of abuse we switch the sandbox off or empty it; we do not open vaults.</li>
<li><strong>Protection against abuse:</strong> The server counts in memory how many vaults one network (IPv4 address or IPv6 /{sb.create_ipv6_prefix} prefix) creates
(for at most {_window(sb, False)}, not stored, section 3), and how many vaults the sandbox creates in total within a short time.</li>
<li><strong>Log and identifiers:</strong> Creation, early removal and the nightly deletion are logged without IP addresses (section 7). The random access ID of a deleted vault
stays stored so that it is never issued again (it says nothing about a person); the log entries follow the periods in section 7.</li>
<li><strong>Who uses the sandbox:</strong> It is open to everybody and needs no account. As in section 2, the processing serves the university's teaching and research; no data about you as a person is collected there.</li>
</ul>"""


def _de(cfg, updated: str, backup: str) -> tuple[str, str, str]:
    idle_h = cfg.session_idle // 3600 if cfg.session_idle % 3600 == 0 else round(cfg.session_idle / 3600, 1)
    abs_h = cfg.session_absolute // 3600 if cfg.session_absolute % 3600 == 0 else round(cfg.session_absolute / 3600, 1)
    purge = DELETED_VAULT_TTL // 86400
    empty = EMPTY_VAULT_TTL // 86400
    audit_days = AUDIT_RETENTION // 86400
    toc = [("verantwortlich", "Wer ist verantwortlich?"), ("zwecke", "Wofür und auf welcher Grundlage?"),
           ("apps", "Wenn Sie eine App nutzen"), ("treuhand", "Wiederherstellungsschlüssel der Fakultät"),
           ("dashboard", "Wenn Sie sich am Dashboard anmelden"), ("empfaenger", "Empfänger und Drittland"),
           ("dauer", "Speicherdauer"), ("rechte", "Ihre Rechte"), ("entwickler", "Hinweise für Entwicklerinnen und Entwickler")] + _toc_sandbox_de(cfg)
    body = f"""
<p>Der WIAI Datastore ist ein Speicherdienst für Web-Apps der Fakultät. Diese Seite erklärt nach Art. 13 DSGVO, welche
personenbezogenen Daten dabei verarbeitet werden. Sie gilt für zwei Gruppen: <strong>(a)</strong> Personen, die eine App
nutzen, die ihre Daten im Datastore ablegt, und <strong>(b)</strong> Personen, die sich am Dashboard anmelden (Beschäftigte der Universität und Personen, die eine App-Administratorin oder ein
App-Administrator als Mit-Administrator eingetragen hat). Die Nutzung ist freiwillig; es besteht keine Pflicht, Daten bereitzustellen.</p>
<ol class="toc">{"".join(f'<li><a href="#{i}">{esc(n)}</a></li>' for i, n in toc)}</ol>

<h2 id="verantwortlich">1. Wer ist verantwortlich?</h2>
<p><strong>Verantwortlicher:</strong> Otto-Friedrich-Universität Bamberg, vertreten durch ihren Präsidenten,
Kapuzinerstraße 16, 96047 Bamberg, E-Mail: <a href="mailto:praesident@uni-bamberg.de">praesident@uni-bamberg.de</a>,
Telefon: +49 951 863-1001.</p>
<p><strong>Betrieb des Dienstes:</strong> Lehrstuhl für Privatsphäre und Sicherheit in Informationssystemen,
An der Weberei 5, 96047 Bamberg, E-Mail: <a href="mailto:dh.psi@uni-bamberg.de">dh.psi@uni-bamberg.de</a>.</p>
<p><strong>Behördlicher Datenschutzbeauftragter:</strong> Kapuzinerstraße 25, 96047 Bamberg,
E-Mail: <a href="mailto:datenschutzbeauftragter@uni-bamberg.de">datenschutzbeauftragter@uni-bamberg.de</a>,
Telefon: +49 951 863-1030.</p>

<h2 id="zwecke">2. Wofür und auf welcher Grundlage?</h2>
<ul>
<li>Speichern der Daten von Web-Apps der Fakultät.</li>
<li>Das Dashboard, in dem Beschäftigte ihre Apps verwalten.</li>
<li>Sicherheit des Dienstes (Begrenzung von Anfragen).</li>
<li>Wiederherstellung, wenn Sie den Zugang zu Ihren Daten verloren haben.</li>
<li>Passwortprüfung: Schutz Ihrer Daten vor Passphrasen, die in bekannten Datenlecks stehen (Abschnitt 6).</li>
</ul>
<p>Rechtsgrundlage ist Art. 6 Abs. 1 Buchst. e und Abs. 3 DSGVO in Verbindung mit Art. 4 Abs. 1 BayDSG
(Wahrnehmung der Aufgaben der Universität in Lehre, Forschung und Verwaltung); das gilt auch für die Passwortprüfung. Für die freiwillige Kontakt-E-Mail-Adresse zur
Wiederherstellung ist es Ihre Einwilligung nach Art. 6 Abs. 1 Buchst. a DSGVO.</p>

<h2 id="apps">3. Wenn Sie eine App nutzen (Gruppe a)</h2>
<dl class="facts">
<dt>Inhalte</dt><dd>Die Inhalte Ihrer App-Daten liegen nur verschlüsselt auf dem Server. Ihre Passphrase und Ihre Schlüssel verlassen Ihr Gerät nicht.
Eine Ausnahme ist der Wiederherstellungsschlüssel der Fakultät (Abschnitt 4).</dd>
<dt>Metadaten</dt><dd>Die App (Scope), Kennungen von Tresor, Zugang und Datensatz, Größen, Zeitpunkte von Anlegen und Schreiben, Rollen und die Zahl der Mitglieder eines Tresors.
Der Server kennt weder Namen der Datensätze noch Personen hinter den Zugängen.</dd>
<dt>IP-Adresse</dt><dd>Nur im Arbeitsspeicher, um Anfragen zu begrenzen (höchstens eine Stunde). Sie wird nicht gespeichert.
Der vorgeschaltete Server (Reverse Proxy) schreibt für <code>/datastore/</code> kein Protokoll.</dd>
<dt>Kontakt-E-Mail (optional)</dt><dd>Wenn Sie beim Anlegen Ihres Tresors eine Adresse angeben, speichern wir sie im Klartext, damit wir Sie bei einer Wiederherstellung erreichen können.
Sie können sie weglassen.</dd>
<dt>Passwortprüfung</dt><dd>Siehe Abschnitt 6.</dd>
</dl>
<p>Wir können Tresore keiner Person zuordnen (Art. 11 DSGVO). Um Ihre Rechte auszuüben, nennen Sie uns deshalb Ihre Zugangskennung
(Access-ID); ohne sie können wir Ihre Daten nicht finden.</p>

<h2 id="treuhand">4. Wiederherstellungsschlüssel der Fakultät (Treuhandschlüssel)</h2>
<div class="box"><p><strong>Die Fakultät kann den Inhalt jedes Tresors entschlüsseln.</strong> Der Betreiber hält einen Wiederherstellungsschlüssel (auch Treuhand- oder Escrow-Schlüssel genannt),
der jeden Tresor öffnet. Wir benutzen ihn nur im dokumentierten Wiederherstellungsverfahren und nur auf Ihren Wunsch, wenn Sie Ihren Zugang verloren haben.
Vor der Wiederherstellung gilt eine Wartezeit von 72 Stunden (mit Ihrem Wiederherstellungscode) oder 7 Tagen (über die Kontakt-E-Mail-Adresse). In dieser Zeit
sehen Sie als Inhaber im Tresor einen Hinweis und können die Wiederherstellung abbrechen. Jeder Schritt wird protokolliert.</p></div>

<h2 id="dashboard">5. Wenn Sie sich am Dashboard anmelden (Gruppe b)</h2>
<p>Die Anmeldung läuft über login.psi mit Ihrer Uni-Kennung. Wir erhalten dabei Ihre Kennung, Ihren Namen und Ihre E-Mail-Adresse.
Eine Matrikelnummer wird nur zur Prüfung ausgewertet (Beschäftigte haben keine) und nicht gespeichert.</p>
<ul>
<li><strong>Sitzungsdaten:</strong> Kennung, Name, E-Mail-Adresse und eine zufällige Sitzungskennung im Cookie <code>__Host-wds_session</code>
(technisch notwendig, keine Einwilligung erforderlich). Die Sitzung endet bei der Abmeldung, nach {idle_h} Stunden ohne Aktivität oder spätestens nach {abs_h} Stunden.</li>
<li><strong>Anmeldecookie:</strong> Während der Anmeldung setzen wir zehn Minuten lang das Cookie <code>__Host-wds_login</code>, das die Anmeldung an Ihren Browser bindet
(technisch notwendig, keine Einwilligung erforderlich). Danach wird es gelöscht.</li>
<li><strong>Anzeigewunsch:</strong> Wenn Sie im Dashboard „Experteneinstellungen immer aufgeklappt zeigen“ wählen, setzen wir ein Jahr lang das Cookie <code>wds_expert</code> mit dem Wert 1
(von Ihnen ausdrücklich gewünscht, keine Einwilligung erforderlich; keine Angaben zu Ihrer Person). Mit „Experteneinstellungen wieder zuklappen“ wird es gelöscht.</li>
<li><strong>Angaben zu Ihren Apps:</strong> Name, Beschreibung, Kontakt-E-Mail-Adresse der App, Mit-Administratoren (Kennung oder E-Mail-Adresse), Einstellungen.</li>
<li><strong>Protokoll der Dashboard-Aktionen:</strong> Wer hat wann was geändert (zum Beispiel Einstellungen mit alter und neuer Kontakt-E-Mail-Adresse, Löschungen),
dazu Anmeldungen und abgewiesene Anmeldungsversuche (diese sieht nur der Betrieb). Ohne IP-Adressen.</li>
</ul>

<h2 id="empfaenger">6. Empfänger und Drittland</h2>
<p>Wir geben keine Daten an Stellen außerhalb der Universität weiter, mit einer Ausnahme (die Passwortprüfung, unten).</p>
<p><strong>Innerhalb der Universität</strong> sehen die Administratoren einer App einander (Kennung oder E-Mail-Adresse, Zeitpunkte) in der Administratorenliste und im Protokoll der App,
dazu die Verwaltungsdaten der Tresore dieser App (angelegt, letzte Änderung, Größe, Zahl der Mitglieder), nie deren Inhalte. Der Betrieb sieht alle Apps und das gesamte Protokoll.</p>
<p><strong>Die Ausnahme ist die Passwortprüfung:</strong> Wenn die App sie eingeschaltet hat, sendet Ihr Browser beim Festlegen einer Passphrase die
ersten 5 Hexadezimalzeichen des SHA-1-Hashwerts Ihrer Passphrase und – technisch bedingt – Ihre IP-Adresse direkt an den Dienst Have I Been Pwned
(<code>api.pwnedpasswords.com</code>, betrieben von Troy Hunt). Empfänger Ihrer Anfrage ist Cloudflare, Inc. (USA), über das der Dienst ausgeliefert wird. Ihre Passphrase selbst wird nie gesendet, und die Anfrage läuft nicht über unseren Server.
Die USA sind ein Drittland. Die Übermittlung stützt sich auf den Angemessenheitsbeschluss der EU-Kommission zum EU-US Data Privacy Framework (Art. 45 DSGVO), soweit Cloudflare, Inc. dort zertifiziert ist.
Zweck ist der Schutz Ihrer Daten vor bekannten, bereits veröffentlichten Passphrasen (Rechtsgrundlage wie in Abschnitt 2). Die Prüfung kann pro App abgeschaltet werden, und Apps müssen auf sie hinweisen.</p>

<h2 id="dauer">7. Speicherdauer</h2>
<ul>
<li>Tresordaten: bis Sie den Tresor löschen oder die App gelöscht wird. Gelöschte Tresore entfernen wir endgültig {purge} Tage nach dem Löschen,
Tresore ohne Daten {empty} Tage nach dem Anlegen.</li>
<li>Frühere Versionen eines Datensatzes: die letzten N Versionen, N legt die App fest (Standard 10).</li>
<li>Dashboard-Sitzungen: bis zur Abmeldung oder zum Ablauf (Abschnitt 5).</li>
<li>Protokoll der Dashboard-Aktionen: {audit_days // 365} Jahr, danach wird es gelöscht.</li>
<li>Angaben zu einer gelöschten App: Beschreibung und Kontakt werden sofort entfernt, der übrige Eintrag mit dem endgültigen Löschen der Tresore.</li>
<li>Sicherungen auf dem Server: 2 nächtliche Kopien.</li>
<li>{esc(backup)}</li>
</ul>

<h2 id="rechte">8. Ihre Rechte</h2>
<p>Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Widerspruch (Art. 21) und Datenübertragbarkeit (Art. 20, soweit die Verarbeitung auf Ihrer Einwilligung beruht).
Eine automatisierte Entscheidungsfindung einschließlich Profiling findet nicht statt. Eine erteilte Einwilligung können Sie jederzeit mit Wirkung für die Zukunft widerrufen. Wenden Sie sich dazu an die Stellen in Abschnitt 1. Bei Tresordaten
brauchen wir Ihre Zugangskennung (Abschnitt 3).</p>
<p>Sie können sich bei der Aufsichtsbehörde beschweren: Der Bayerische Landesbeauftragte für den Datenschutz (BayLfD), Postfach 22 12 19, 80502 München;
Wagmüllerstraße 18, 80538 München; E-Mail: <a href="mailto:poststelle@datenschutz-bayern.de">poststelle@datenschutz-bayern.de</a>;
Telefon: +49 89 212672-0; <a href="https://www.datenschutz-bayern.de" rel="noopener">www.datenschutz-bayern.de</a>.</p>

<h2 id="entwickler">9. Hinweise für Entwicklerinnen und Entwickler</h2>
<p>Wer eine App mit dem Datastore baut, braucht eine <strong>eigene Datenschutzerklärung für die Inhalte der App</strong> (was die App speichert, wozu, wie lange, wer Zugriff hat).
Diese Seite beschreibt nur den Speicherdienst. Verlinken Sie sie und sagen Sie Ihren Nutzenden außerdem:</p>
<ul>
<li>Die Fakultät hält einen Wiederherstellungsschlüssel und kann im Wiederherstellungsverfahren Inhalte entschlüsseln (Abschnitt 4).</li>
<li>Falls Sie die Passwortprüfung eingeschaltet lassen: Sie sendet Daten an Have I Been Pwned in den USA (Abschnitt 6).</li>
<li>Wer Zugangskennung und Wiederherstellungscode verliert, kann seine Daten nur mit Hilfe des Betreibers zurückbekommen. Wer eine Einladung weitergibt, gibt Zugriff auf die Inhalte.</li>
<li>Wie sich Nutzende an Sie wenden können (die Kontakt-E-Mail-Adresse im Dashboard).</li>
</ul>
{_sandbox_de(cfg)}
<p class="muted small">Stand: {esc(updated)}</p>"""
    return "Datenschutzhinweise (Art. 13 DSGVO)", "Datenschutz", body


def _en(cfg, updated: str, backup: str) -> tuple[str, str, str]:
    idle_h = cfg.session_idle // 3600 if cfg.session_idle % 3600 == 0 else round(cfg.session_idle / 3600, 1)
    abs_h = cfg.session_absolute // 3600 if cfg.session_absolute % 3600 == 0 else round(cfg.session_absolute / 3600, 1)
    purge = DELETED_VAULT_TTL // 86400
    empty = EMPTY_VAULT_TTL // 86400
    audit_days = AUDIT_RETENTION // 86400
    toc = [("controller", "Who is responsible?"), ("purposes", "Why and on what legal basis?"),
           ("apps", "If you use an app"), ("escrow", "The faculty's recovery key"),
           ("dashboard", "If you log in to the dashboard"), ("recipients", "Recipients and third countries"),
           ("retention", "Storage periods"), ("rights", "Your rights"), ("developers", "Notes for app developers")] + _toc_sandbox_en(cfg)
    body = f"""
<p>The WIAI Datastore is a storage service for web apps of the faculty. This page explains, as Art. 13 GDPR requires, which
personal data is processed. It covers two groups: <strong>(a)</strong> people who use an app that stores its data in the Datastore, and
<strong>(b)</strong> people who log in to the dashboard (university staff, and people whom an app administrator has listed as co-admin). Use is voluntary; you are under no obligation to provide data.
(The German version of this page is the original.)</p>
<ol class="toc">{"".join(f'<li><a href="#{i}">{esc(n)}</a></li>' for i, n in toc)}</ol>

<h2 id="controller">1. Who is responsible?</h2>
<p><strong>Controller:</strong> Otto-Friedrich-Universität Bamberg, represented by its President,
Kapuzinerstraße 16, 96047 Bamberg, Germany, e-mail: <a href="mailto:praesident@uni-bamberg.de">praesident@uni-bamberg.de</a>,
phone: +49 951 863-1001.</p>
<p><strong>Operation of the service:</strong> Chair of Privacy and Security in Information Systems (Lehrstuhl für Privatsphäre und Sicherheit in Informationssystemen),
An der Weberei 5, 96047 Bamberg, e-mail: <a href="mailto:dh.psi@uni-bamberg.de">dh.psi@uni-bamberg.de</a>.</p>
<p><strong>Data protection officer</strong> (behördlicher Datenschutzbeauftragter): Kapuzinerstraße 25, 96047 Bamberg,
e-mail: <a href="mailto:datenschutzbeauftragter@uni-bamberg.de">datenschutzbeauftragter@uni-bamberg.de</a>,
phone: +49 951 863-1030.</p>

<h2 id="purposes">2. Why and on what legal basis?</h2>
<ul>
<li>Storing the data of the faculty's web apps.</li>
<li>The dashboard, where staff manage their apps.</li>
<li>Security of the service (rate limiting).</li>
<li>Recovery if you have lost access to your data.</li>
<li>Password check: protecting your data against passphrases that appear in known data breaches (section 6).</li>
</ul>
<p>The legal basis is Art. 6(1)(e) and (3) GDPR in conjunction with Art. 4(1) BayDSG (performance of the university's tasks in teaching,
research and administration); this includes the password check. For the optional contact e-mail address used for recovery, it is your consent under Art. 6(1)(a) GDPR.</p>

<h2 id="apps">3. If you use an app (group a)</h2>
<dl class="facts">
<dt>Content</dt><dd>The content of your app data is stored on the server only in encrypted form. Your passphrase and keys never leave your device.
The exception is the faculty's recovery key (section 4).</dd>
<dt>Metadata</dt><dd>The app (scope), vault, access and record IDs, sizes, times of creation and writing, roles, and the number of members of a vault.
The server knows neither the names of records nor the people behind accesses.</dd>
<dt>IP address</dt><dd>Only in memory, to limit requests (at most one hour). It is not stored. The reverse proxy writes no log for <code>/datastore/</code>.</dd>
<dt>Contact e-mail (optional)</dt><dd>If you give an address when you create your vault, we store it in plain text so that we can reach you during a recovery. You can leave it out.</dd>
<dt>Password check</dt><dd>See section 6.</dd>
</dl>
<p>We cannot link vaults to people (Art. 11 GDPR). To exercise your rights, please give us your access ID; without it we cannot find your data.</p>

<h2 id="escrow">4. The faculty's recovery key (escrow key)</h2>
<div class="box"><p><strong>The faculty can decrypt the content of every vault.</strong> The operator holds a recovery key (also called an escrow key) that opens every vault.
We use it only in the documented recovery procedure and only at your request, when you have lost your access. Before a recovery there is a waiting period of
72 hours (with your recovery code) or 7 days (via the contact e-mail address). During this time you, as the owner, see a notice in the vault and can cancel the recovery.
Every step is logged.</p></div>

<h2 id="dashboard">5. If you log in to the dashboard (group b)</h2>
<p>Login runs through login.psi with your university ID. We receive your ID, your name and your e-mail address.
A matriculation number is only checked (staff have none) and is not stored.</p>
<ul>
<li><strong>Session data:</strong> ID, name, e-mail address and a random session ID in the cookie <code>__Host-wds_session</code>
(technically necessary, no consent needed). The session ends at logout, after {idle_h} hours without activity, or after {abs_h} hours at the latest.</li>
<li><strong>Login cookie:</strong> While you log in we set the cookie <code>__Host-wds_login</code> for ten minutes; it ties the login to your browser
(technically necessary, no consent needed). It is deleted afterwards.</li>
<li><strong>Display preference:</strong> If you choose "Always show the expert settings" in the dashboard we set the cookie <code>wds_expert</code> with the value 1 for one year
(requested by you, no consent needed; it holds no personal data). "Collapse the expert settings again" deletes it.</li>
<li><strong>Details of your apps:</strong> name, description, contact e-mail address of the app, co-admins (ID or e-mail address), settings.</li>
<li><strong>Log of dashboard actions:</strong> who changed what and when (for example settings with the old and new contact e-mail address, deletions),
plus logins and refused login attempts (only the operator sees these). No IP addresses.</li>
</ul>

<h2 id="recipients">6. Recipients and third countries</h2>
<p>We do not pass data to anyone outside the university, with one exception (the password check, below).</p>
<p><strong>Inside the university,</strong> the administrators of an app see each other (ID or e-mail address, times) in the admin list and the log of that app, and the management data of the
app's vaults (created, last write, size, number of members), never their contents. The operator sees all apps and the whole log.</p>
<p><strong>The exception is the password check:</strong> if the app has switched it on, your browser sends the first 5 hexadecimal characters of the SHA-1 hash of your passphrase
and, as a technical necessity, your IP address directly to the service Have I Been Pwned (<code>api.pwnedpasswords.com</code>, operated by Troy Hunt)
when you choose a passphrase. The recipient of your request is Cloudflare, Inc. (USA), which delivers the service. Your passphrase itself is never sent, and the request does not go through our server.
The USA is a third country. The transfer relies on the European Commission's adequacy decision for the EU-US Data Privacy Framework (Art. 45 GDPR), as far as Cloudflare, Inc. is certified under it.
The purpose is to protect your data against known, already published passphrases (legal basis as in section 2). The check can be switched off per app, and apps must mention it.</p>

<h2 id="retention">7. Storage periods</h2>
<ul>
<li>Vault data: until you delete the vault or the app is deleted. Deleted vaults are removed for good {purge} days after deletion;
vaults without data {empty} days after creation.</li>
<li>Earlier versions of a record: the last N versions, where the app sets N (default 10).</li>
<li>Dashboard sessions: until logout or expiry (section 5).</li>
<li>Log of dashboard actions: {audit_days // 365} year, then it is deleted.</li>
<li>Details of a deleted app: description and contact are removed at once, the rest of the entry when the vaults are removed for good.</li>
<li>Backups on the server: 2 nightly copies.</li>
<li>{esc(backup)}</li>
</ul>

<h2 id="rights">8. Your rights</h2>
<p>You have the right of access (Art. 15 GDPR), rectification (Art. 16), erasure (Art. 17), restriction of processing (Art. 18), objection (Art. 21) and data portability (Art. 20, as far as the processing is based on your consent).
No automated decision-making, including profiling, takes place. You can withdraw consent at any time with effect for the future. Contact the offices in section 1. For vault data we need your access ID (section 3).</p>
<p>You can lodge a complaint with the supervisory authority: Der Bayerische Landesbeauftragte für den Datenschutz (BayLfD), Postfach 22 12 19, 80502 München;
Wagmüllerstraße 18, 80538 München; e-mail: <a href="mailto:poststelle@datenschutz-bayern.de">poststelle@datenschutz-bayern.de</a>;
phone: +49 89 212672-0; <a href="https://www.datenschutz-bayern.de" rel="noopener">www.datenschutz-bayern.de</a>.</p>

<h2 id="developers">9. Notes for app developers</h2>
<p>Whoever builds an app on the Datastore needs <strong>their own privacy notice for the content of the app</strong> (what the app stores, why, for how long, who has access).
This page describes the storage service only. Link to it, and also tell your users:</p>
<ul>
<li>The faculty holds a recovery key and can decrypt content in the recovery procedure (section 4).</li>
<li>If you leave the password check on, it sends data to Have I Been Pwned in the USA (section 6).</li>
<li>Whoever loses the access ID and recovery code can only get the data back with the operator's help. Whoever passes on an invitation gives access to the content.</li>
<li>How users can reach you (the contact e-mail address in the dashboard).</li>
</ul>
{_sandbox_en(cfg)}
<p class="muted small">Last updated: {esc(updated)}</p>"""
    return "Privacy notice (Art. 13 GDPR)", "Privacy", body


def privacy_page(ctx: Ctx, cfg):
    de = ctx.lang == "de"
    updated = updated_text(cfg, de)
    title, short, body = (_de if de else _en)(cfg, updated, cfg.backup_retention_de if de else cfg.backup_retention_en)
    return render(ctx, short, f"<h1>{esc(title)} – WIAI Datastore</h1>{body}",
                  extra_headers={"Cache-Control": "no-cache"})
