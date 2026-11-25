"""The text a staff member pastes into a conversation with Claude, and the section for the app's own CLAUDE.md / AGENTS.md.

Plain text (the dashboard escapes it when it puts it into a page). The prompt follows the dashboard language; the snippet is
always English, because it lives in the app's repository next to code and English documentation.

Every value that can change later (enrollment, breach check, limits) carries the date it was read: wds-verify prints the
current ones from the public scope document, and the snippet says so instead of copying numbers into a repository.
"""

from __future__ import annotations

HIBP = "https://api.pwnedpasswords.com"


def claude_md(*, sid: str, base: str, repo_url: str, sandbox_id: str | None) -> str:
    lines = [
        "## Data storage: WIAI Datastore",
        "",
        f"This app keeps all user data in the WIAI Datastore (University of Bamberg), scope {sid}. Data is end-to-end encrypted; "
        "the faculty holds a recovery key for emergencies. Privacy texts of this app must say so.",
        "",
        "- Before changing storage, the data model, the library script tag or the Content-Security-Policy, read "
        f"{base}/llms.txt and follow it.",
        "- Keep the library script tag as it is; to update the library, take the new tag from llms.txt.",
        "- All user data goes through the store from WDS.connect(). No own cryptography, no fetch to the datastore, no user data in "
        "localStorage, sessionStorage, IndexedDB or cookies, no third-party scripts. Never add hosts to script-src or connect-src.",
    ]
    if sandbox_id:
        lines.append(f"- Never write the sandbox scope ID {sandbox_id} into this app; test with wds-verify --target sandbox.")
    lines += [
        "- Current scope settings (enrollment, breach check, limits): run wds-verify, it prints them.",
        f"- After every change run wds-verify ({repo_url}) and update the report in README.md.",
    ]
    return "\n".join(lines)


def prompt(lang: str, *, sid: str, date: str, base: str, tag: str, repo_url: str, sandbox_id: str | None, enrollment: str,
           hibp: bool, max_vaults: int, max_value: str, vault_bytes: str, history_versions: int, snippet: str) -> str:
    if lang == "en":
        enroll = {
            "join_code": "join code: users type a join code when they create their vault; never put it into the app",
            "open": f"open: anybody with the app can create a vault (limit {max_vaults})",
            "closed": "closed: no new vaults",
        }[enrollment]
        breach = (f"on (keep {HIBP} in connect-src)" if hibp else f"off (remove {HIBP} from connect-src)")
        out = [
            "I am building or porting a single-file web app that stores its data in the WIAI Datastore of the University of Bamberg.",
            "Data is end-to-end encrypted; the faculty holds a recovery key for emergencies. Say exactly this wherever the app "
            "describes its privacy.",
            "",
            f"Scope settings (as of {date}; wds-verify prints the current ones):",
            f"- Scope ID: {sid}",
            f"- Enrollment: {enroll}",
            f"- Breach check: {breach}",
            f"- Limits: {max_value} per record, {vault_bytes} per vault including history, {history_versions} versions per record, "
            f"{max_vaults} vaults",
            "",
            f"First read {base}/llms.txt and follow the documents it links to. Include the library with exactly this tag (do not change the hash):",
            tag,
            "",
            f'Connect with WDS.connect({{ scope: "{sid}" }}). No own cryptography, no own fetch to the datastore, no user data in '
            "localStorage, sessionStorage, IndexedDB or cookies, no scripts from CDNs.",
            'If the app already exists, follow the section "Porting an existing app" of integration.md.',
        ]
        if sandbox_id:
            out += ["For end-to-end test runs use wds-verify --target sandbox (or --sandbox-copy). Never write the sandbox scope ID "
                    f"{sandbox_id} into the app file: data there is deleted every night."]
        out += [
            f'When you are done, run wds-verify ({repo_url}, integration.md section "wds-verify") and put its report into the README.',
            "Add the following section to CLAUDE.md and to AGENTS.md in the app's folder (create them if missing; keep existing content):",
            "",
            snippet,
        ]
        return "\n".join(out)
    enroll = {
        "join_code": "Beitrittscode: Nutzende geben beim Anlegen ihres Tresors einen Beitrittscode ein; trage ihn nie in die App ein",
        "open": f"offen: jede Person mit der App kann einen Tresor anlegen (Höchstzahl {max_vaults})",
        "closed": "geschlossen: keine neuen Tresore",
    }[enrollment]
    breach = (f"an ({HIBP} bleibt in connect-src)" if hibp else f"aus ({HIBP} aus connect-src entfernen)")
    out = [
        "Ich baue oder portiere eine Web-App in einer einzigen HTML-Datei, die ihre Daten im WIAI Datastore der Universität Bamberg speichert.",
        "Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät hält für Notfälle einen Wiederherstellungsschlüssel. Sag genau das überall, "
        "wo die App ihren Datenschutz beschreibt.",
        "",
        f"Einstellungen des Scopes (Stand {date}; wds-verify gibt die aktuellen aus):",
        f"- Scope-ID: {sid}",
        f"- Anlegen von Tresoren: {enroll}",
        f"- Prüfung auf Datenlecks: {breach}",
        f"- Grenzen: {max_value} je Datensatz, {vault_bytes} je Tresor einschließlich Verlauf, {history_versions} Versionen je Datensatz, "
        f"{max_vaults} Tresore",
        "",
        f"Lies zuerst {base}/llms.txt und folge den dort verlinkten Dokumenten. Binde die Bibliothek mit genau diesem Tag ein (Hash nicht ändern):",
        tag,
        "",
        f'Verbinde mit WDS.connect({{ scope: "{sid}" }}). Keine eigene Kryptografie, kein eigenes fetch an den Datastore, keine Nutzerdaten in '
        "localStorage, sessionStorage, IndexedDB oder Cookies, keine Skripte von CDNs.",
        'Wenn die App schon existiert, folge dem Abschnitt "Porting an existing app" in integration.md.',
    ]
    if sandbox_id:
        out += ["Für Testläufe von Anfang bis Ende nimm wds-verify --target sandbox (oder --sandbox-copy). Schreibe die Scope-ID der Testumgebung "
                f"{sandbox_id} nie in die App-Datei: Die Daten dort werden jede Nacht gelöscht."]
    out += [
        f'Wenn du fertig bist, führe wds-verify aus ({repo_url}, integration.md, Abschnitt "wds-verify") und übernimm den Bericht in die README.',
        "Ergänze den folgenden Abschnitt in CLAUDE.md und in AGENTS.md im Ordner der App (lege die Dateien an, falls sie fehlen; behalte den bisherigen Inhalt):",
        "",
        snippet,
    ]
    return "\n".join(out)
