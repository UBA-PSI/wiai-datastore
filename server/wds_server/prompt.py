"""The text for Claude: the staff member pastes it into a conversation with Claude, and Claude keeps it in the app's CLAUDE.md and AGENTS.md.

One English text for both (the app's repository holds code and English documentation; the dashboard explains the text in German).
Only the app ID, the service address and the sandbox ID vary. Nothing that can change later is copied into it (limits and the
library tag are in llms.txt and in what wds-verify prints).
"""

from __future__ import annotations

# The official privacy sentence, in both languages. docs/site/integration.md (section 11), llms.txt and users.*.md carry the same words (server/tests/test_docs.py checks).
PRIVACY_EN = "Data is end-to-end encrypted; the faculty holds a recovery key for emergencies."
PRIVACY_DE = "Die Daten sind Ende-zu-Ende-verschlüsselt; die Fakultät verwahrt für Notfälle einen Wiederherstellungsschlüssel."

# The breach check of passphrases runs through the faculty's server for every scope, so there is one wording. It belongs on the
# privacy pages and in users.*.md (the person who chooses a passphrase reads it); an app's own privacy text does not need it.
BREACH_EN = ("When you choose a passphrase, your browser sends the first five characters of a checksum of the passphrase to the faculty's server, "
             "which asks the Pwned Passwords service (USA) on your behalf; the service sees neither the passphrase nor your IP address.")
BREACH_DE = ("Wenn Sie eine Passphrase wählen, sendet Ihr Browser die ersten fünf Zeichen einer Prüfsumme der Passphrase an den Server der Fakultät, "
             "der in Ihrem Auftrag den Dienst Pwned Passwords (USA) fragt; der Dienst sieht weder die Passphrase noch Ihre IP-Adresse.")


def claude_text(*, sid: str, base: str, repo_url: str, sandbox_id: str | None) -> str:
    lines = [
        "## Data storage: WIAI Datastore",
        "",
        f"This app keeps all user data in the WIAI Datastore (University of Bamberg), app ID (scope) {sid}.",
        "",
        f"- Before building or changing storage, the data model, the library script tag or the Content-Security-Policy, read {base}/llms.txt and follow its rules.",
        "- Privacy texts of this app (README, start page, dialogs) say, word for word and in the language of the text; a longer text may follow:",
        f'  en: "{PRIVACY_EN}"',
        f'  de: "{PRIVACY_DE}"',
        "- The join code of this app is a secret of the staff. Never write it into the app, the README, tests, scripts, CLAUDE.md or AGENTS.md, "
        "and never ask for it in the chat.",
        f"- Test with wds-verify ({repo_url}); it runs against the sandbox. After every change run it and update its report in README.md."
        + (f" Never write the sandbox scope ID {sandbox_id} into this app." if sandbox_id else ""),
        "- Keep this section in CLAUDE.md and AGENTS.md in the app's folder (create the files if missing; keep their other content).",
    ]
    return "\n".join(lines)
