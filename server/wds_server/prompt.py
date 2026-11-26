"""The text a staff member pastes into a conversation with Claude, and the section for the app's own CLAUDE.md / AGENTS.md.

Plain text (the dashboard escapes it when it puts it into a page). The prompt follows the dashboard language; the snippet is
always English, because it lives in the app's repository next to code and English documentation.

Every value that can change later (enrollment, breach check, limits) carries the date it was read: wds-verify prints the
current ones from the public scope document, and the snippet says so instead of copying numbers into a repository.
"""

from __future__ import annotations

HIBP = "https://api.pwnedpasswords.com"

# The official privacy sentence, in both languages. docs/site/integration.md, llms.txt and users.*.md carry the same words (server/tests/test_docs.py checks).
PRIVACY_EN = "Data is end-to-end encrypted; the faculty holds a recovery key for emergencies."
PRIVACY_DE = "Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel."

# The official breach-check sentence: an app whose scope has the breach check on adds it to its privacy text, right after the official
# sentence above (the browser sends the user's IP address to a service in the USA). The docs carry the same words.
HIBP_EN = ("When you choose a passphrase, your browser checks it against known data breaches with the Pwned Passwords service (USA); "
           "the service receives your IP address and the first five characters of a checksum of the passphrase, never the passphrase itself.")
HIBP_DE = ("Wenn Sie eine Passphrase wählen, prüft Ihr Browser sie beim Dienst Pwned Passwords (USA) auf bekannte Datenlecks; "
           "der Dienst erhält Ihre IP-Adresse und die ersten fünf Zeichen einer Prüfsumme der Passphrase, nie die Passphrase selbst.")

JOIN_CODE_FILE = "~/.wds/join-code"


def claude_md(*, sid: str, base: str, repo_url: str, sandbox_id: str | None, enrollment: str = "join_code") -> str:
    lines = [
        "## Data storage: WIAI Datastore",
        "",
        f"This app keeps all user data in the WIAI Datastore (University of Bamberg), app ID (scope) {sid}.",
        "",
        "- Privacy texts of this app (README, start page, dialogs) say, word for word and in the language of the text; a longer text may follow:",
        f'  en: "{PRIVACY_EN}"',
        f'  de: "{PRIVACY_DE}"',
        "- Before changing storage, the data model, the library script tag or the Content-Security-Policy, read "
        f"{base}/llms.txt and follow it. For an app that already exists, read {base}/docs/porting.md; data the old version left in the browser "
        "is taken over once with store.migrateLocal (the app never reads indexedDB or localStorage itself).",
        "- Keep the library script tag as it is; to update the library, take the new tag from llms.txt.",
        "- All user data goes through the store from WDS.connect(). No own cryptography, no fetch to the datastore, no user data in "
        "localStorage, sessionStorage, IndexedDB or cookies, no third-party scripts. Never add hosts to script-src or connect-src.",
    ]
    if sandbox_id:
        lines.append(f"- Never write the sandbox scope ID {sandbox_id} into this app; test with wds-verify --target sandbox.")
    lines.append("- Current scope settings (enrollment, breach check, limits): run wds-verify, it prints them. When it says the breach check is on, "
                 "the privacy texts also carry the breach-check sentence of integration.md.")
    if enrollment == "join_code":  # an open or a closed scope has no code to protect
        lines.append("- The join code of this scope is a secret of the staff. Never write it into the app, the README, tests, scripts, CLAUDE.md or AGENTS.md. "
                     f"To test against a test vault in the real scope, the person puts the code into the file {JOIN_CODE_FILE} themselves "
                     "(commands: porting.md, \"The join code for tests\"). Never read, print or copy that file and never ask for the code in the chat.")
    lines.append(f"- After every change run wds-verify ({repo_url}) and update the report in README.md (wds-verify --heading-level 3 writes it for a \"## Verification\" heading).")
    return "\n".join(lines)


def prompt(lang: str, *, sid: str, date: str, base: str, tag: str, repo_url: str, sandbox_id: str | None, enrollment: str,
           hibp: bool, max_vaults: int, max_value: str, vault_bytes: str, history_versions: int, snippet: str) -> str:
    if lang == "en":
        why = "the deletion path of a migration" + (": the sandbox never deletes old data" if sandbox_id else "")
        late = ": the sandbox never deletes old data" if sandbox_id else ""
        optional = (" This test is optional: wds-verify --target sandbox with --migration-delete covers the deletion path." if sandbox_id else "")
        test_vault = {
            "join_code": f"To test against a test vault in this scope ({why}), I put the join code into the file {JOIN_CODE_FILE} myself. "
                         "When you need it, give me the commands from porting.md (\"The join code for tests\") and wait until I say it is there. "
                         "Never read, print or copy that file and never ask me for the code in the chat. Never write the code into the app, "
                         "the README, a test script, a command line, CLAUDE.md or AGENTS.md. "
                         "End the test by deleting the test vault yourself (deleteVault of tools/lib/drive-library.mjs, porting.md, \"The test vault, afterwards\") and tell me its ID and the time, so that I can check that it is gone." + optional,
            "open": f"To test against a test vault in this scope ({why}), create one yourself: this scope needs no join code. Tell me when you ran the test "
                    "(the time and the ID of the test vault). End the test by deleting the test vault yourself (deleteVault of tools/lib/drive-library.mjs, porting.md, \"The test vault, afterwards\") and tell me its ID.",
            "closed": f"This scope accepts no new vaults, so no test vault can be created in it. Tell me before you test the deletion path of a migration{late}.",
        }[enrollment]
        enroll = {
            "join_code": "join code: users type a join code when they create their vault; never put it into the app",
            "open": f"open: anybody with the app can create a vault (limit {max_vaults})",
            "closed": "closed: no new vaults",
        }[enrollment]
        breach = (f"on (keep {HIBP} in connect-src)" if hibp else f"off (remove {HIBP} from connect-src)")
        out = [
            "I am building or porting a single-file web app that stores its data in the WIAI Datastore of the University of Bamberg.",
            "Wherever the app describes its privacy, say exactly this sentence, in the language of the text (a longer text may follow it):",
            f"- English: {PRIVACY_EN}",
            f"- German: {PRIVACY_DE}",
        ]
        if hibp:
            out += ["The breach check is on, so add this sentence to the privacy text, right after the official sentence, in the language of the text:",
                    f"- English: {HIBP_EN}",
                    f"- German: {HIBP_DE}"]
        out += [
            "",
            f"Scope settings (as of {date}; wds-verify prints the current ones):",
            f"- App ID (scope): {sid}",
            f"- Enrollment: {enroll}",
            f"- Breach check: {breach}",
            f"- Limits: {max_value} per record, {vault_bytes} per vault including history, {history_versions} versions per record, "
            f"{max_vaults} vaults",
            "",
            f"First read {base}/llms.txt and follow the documents it links to. Include the library with exactly this tag (do not change the checksum):",
            tag,
            "",
            f'Connect with WDS.connect({{ scope: "{sid}" }}). No own cryptography, no own fetch to the datastore, no user data in '
            "localStorage, sessionStorage, IndexedDB or cookies, no scripts from CDNs.",
            f"If the app already exists, read {base}/docs/porting.md first; data the old version left in the browser is taken over with store.migrateLocal.",
            test_vault,
        ]
        if sandbox_id:
            out += ["For end-to-end test runs use wds-verify --target sandbox (or --sandbox-copy). Never write the sandbox scope ID "
                    f"{sandbox_id} into the app file: data there is deleted every night."]
        out += [
            f'When you are done, run wds-verify ({repo_url}, integration.md section "wds-verify") and put its report into the README (--heading-level 3 fits it under a "## Verification" heading).',
            "Add the following section to CLAUDE.md and to AGENTS.md in the app's folder (create them if missing; keep existing content):",
            "",
            snippet,
        ]
        return "\n".join(out)
    why = "der Löschweg einer Migration" + (": die Testumgebung löscht alte Daten nie" if sandbox_id else "")
    late = ": Die Testumgebung löscht alte Daten nie" if sandbox_id else ""
    optional = (" Dieser Test ist freiwillig: wds-verify --target sandbox mit --migration-delete deckt den Löschweg ab." if sandbox_id else "")
    test_vault = {
        "join_code": f"Für einen Test mit einem Test-Tresor in diesem Scope ({why}) lege ich den Beitrittscode selbst in die Datei {JOIN_CODE_FILE}. "
                     "Wenn du ihn brauchst, gib mir die Befehle aus porting.md (\"The join code for tests\") und warte, bis ich sage, dass er dort liegt. "
                     "Lies, zeige oder kopiere diese Datei nie und frag mich nie im Chat nach dem Code. Schreibe den Code nie in die App, "
                     "die README, ein Testskript, eine Kommandozeile, CLAUDE.md oder AGENTS.md. "
                     "Beende den Test, indem du den Test-Tresor selbst löschst (deleteVault in tools/lib/drive-library.mjs, porting.md, \"The test vault, afterwards\"), und nenne mir seine Kennung und die Uhrzeit, damit ich prüfen kann, dass er weg ist." + optional,
        "open": f"Für einen Test mit einem Test-Tresor in diesem Scope ({why}) leg selbst einen an: Dieser Scope braucht keinen Beitrittscode. Sag mir, wann du den Test gemacht hast "
                "(die Uhrzeit und die Kennung des Test-Tresors). Beende den Test, indem du den Test-Tresor selbst löschst (deleteVault in tools/lib/drive-library.mjs, porting.md, \"The test vault, afterwards\"), und nenne mir seine Kennung.",
        "closed": f"In diesem Scope können keine neuen Tresore angelegt werden, also gibt es keinen Test-Tresor. Sag mir Bescheid, bevor du den Löschweg einer Migration testest{late}.",
    }[enrollment]
    enroll = {
        "join_code": "Beitrittscode: Nutzende geben beim Anlegen ihres Tresors einen Beitrittscode ein; trage ihn nie in die App ein",
        "open": f"offen: jede Person mit der App kann einen Tresor anlegen (Höchstzahl {max_vaults})",
        "closed": "geschlossen: keine neuen Tresore",
    }[enrollment]
    breach = (f"an ({HIBP} bleibt in connect-src)" if hibp else f"aus ({HIBP} aus connect-src entfernen)")
    out = [
        "Ich baue oder portiere eine Web-App in einer einzigen HTML-Datei, die ihre Daten im WIAI Datastore der Universität Bamberg speichert.",
        "Überall, wo die App ihren Datenschutz beschreibt, sag genau diesen Satz, in der Sprache des Textes (ein längerer Text darf folgen):",
        f"- Deutsch: {PRIVACY_DE}",
        f"- Englisch: {PRIVACY_EN}",
    ]
    if hibp:
        out += ["Die Prüfung auf Datenlecks ist an, also ergänze im Datenschutztext direkt nach dem offiziellen Satz diesen Satz, in der Sprache des Textes:",
                f"- Deutsch: {HIBP_DE}",
                f"- Englisch: {HIBP_EN}"]
    out += [
        "",
        f"Einstellungen des Scopes (Stand {date}; wds-verify gibt die aktuellen aus):",
        f"- App-ID (Scope): {sid}",
        f"- Anlegen von Tresoren: {enroll}",
        f"- Prüfung auf Datenlecks: {breach}",
        f"- Grenzen: {max_value} je Datensatz, {vault_bytes} je Tresor einschließlich Verlauf, {history_versions} Versionen je Datensatz, "
        f"{max_vaults} Tresore",
        "",
        f"Lies zuerst {base}/llms.txt und folge den dort verlinkten Dokumenten. Binde die Bibliothek mit genau diesem Tag ein (Prüfsumme nicht ändern):",
        tag,
        "",
        f'Verbinde mit WDS.connect({{ scope: "{sid}" }}). Keine eigene Kryptografie, kein eigenes fetch an den Datastore, keine Nutzerdaten in '
        "localStorage, sessionStorage, IndexedDB oder Cookies, keine Skripte von CDNs.",
        f"Wenn die App schon existiert, lies zuerst {base}/docs/porting.md; Daten, die die alte Version im Browser hinterlassen hat, übernimmst du mit store.migrateLocal.",
        test_vault,
    ]
    if sandbox_id:
        out += ["Für Testläufe von Anfang bis Ende nimm wds-verify --target sandbox (oder --sandbox-copy). Schreibe die Scope-ID der Testumgebung "
                f"{sandbox_id} nie in die App-Datei: Die Daten dort werden jede Nacht gelöscht."]
    out += [
        f'Wenn du fertig bist, führe wds-verify aus ({repo_url}, integration.md, Abschnitt "wds-verify") und übernimm den Bericht in die README (--heading-level 3 passt ihn unter eine Überschrift "## Verification" ein).',
        "Ergänze den folgenden Abschnitt in CLAUDE.md und in AGENTS.md im Ordner der App (lege die Dateien an, falls sie fehlen; behalte den bisherigen Inhalt):",
        "",
        snippet,
    ]
    return "\n".join(out)
