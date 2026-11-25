# Using an app with WIAI Datastore

Apps of the University of Bamberg that show this storage keep your data on a faculty server, **encrypted on your device
before it is sent**. This page explains what you need, what to keep safe and who can see what. [Deutsche Fassung]({{base}}/docs/users.de)

## What you need

1. **A join code** from the person who runs the app. You need it once, to create your vault.
2. **A passphrase of your own**, at least 12 characters. Four or more unrelated words work well ("purple elephant marching slowly").
   The app rejects very common passphrases (also German ones such as "ichliebedich123") and passphrases that appear in known data breaches. If the breach check cannot be reached, or is switched off for the app, the app asks for a stronger passphrase. For that check only the first five
   characters of a hash of your passphrase go to the service Pwned Passwords in the USA, never the passphrase itself.
3. **Your access sheet.** After creating your vault the app shows it: your **access ID** (five groups of four characters) and your
   **recovery code**. Print it or save it, and keep it apart from your computer.

**Nobody can reset your passphrase.** The server does not know it. If you lose it, only the recovery procedure below helps.

## Access ID, key file, recovery code

| What | What it is for | Secret? |
|---|---|---|
| Access ID | Names your vault. You enter it together with your passphrase on a new device. | No, but keep it with your sheet. |
| Key file | A small file with the app and your access ID. Drag it into the app on a new device instead of typing the ID. | No. It holds no passphrase. |
| Passphrase | Opens your data. Only in your head or your password manager. | Yes |
| Recovery code | Lets the faculty restore access if you lose your passphrase. | Yes. Keep it apart from your computer. |

## On a new device or after clearing the browser

Open the app, enter your access ID (or drop the key file) and your passphrase. The app says
"This device is new to your vault." That is normal.

## Sharing

Owners share their whole vault: in the app choose **Share**, pick a role and create an invite code.

- **Can edit**: can read and change. **Read only**: can only read.
- Send the code over another channel than the app itself (in person, a chat). It expires after the time you chose.
- The other person enters the code in the app and chooses a **passphrase of their own**. You see "An invitation was redeemed."
- **Revoke** ends someone's access at once. The app then re-encrypts all data under new keys; this takes a while for large
  vaults and continues by itself if you close the page.
- Revoked people keep what they already downloaded.

## When two people change the same thing

The app asks before it overwrites anything. The standard dialog says "Another device or person saved a newer version" and offers
**Keep theirs**, **Keep mine** and **Download both**. An app may show a dialog of its own that words the same choice differently (for
example **Keep the newer version** and **Keep my version**). If you keep yours, the other version stays in the history and can be
restored. Apps may show a history of earlier versions.

## What the faculty can see

In short: **Data is end-to-end encrypted; the faculty holds a recovery key for emergencies.** The details:

- The server stores only encrypted data. It sees which app you use, how many items you have, how large they are, when they
  changed and how many people have access (as anonymous entries). It does not see names, texts or files.
- Server logs of the web server are switched off for this service. IP addresses are used for rate limiting in memory only.
- **The exception:** the faculty keeps a recovery key (escrow key), stored offline by the operator. Whoever holds this key can decrypt every
  vault. It is used only in the recovery procedure below, and every use is logged.
- The app itself sees your data while it runs. Use only apps you trust.
- Encrypted backups of the server exist. After you delete data or someone loses access, old copies remain in backups for the
  retention period named in the [privacy information]({{base}}/privacy).

## Recovery if you forget the passphrase

1. Contact the person who runs the app, who passes your request to the operator of the service. Have your **access ID** and
   **recovery code** ready.
2. The operator starts the recovery. With the recovery code a **72-hour waiting period** begins. During it, every unlock of
   your vault shows "A recovery of this vault was requested" with a **Cancel the request** button. If you did not ask for it, cancel it
   and tell the operator.
3. After the waiting period the operator adds a new owner access to your vault and gives you an invite code. You redeem it and
   choose a new passphrase. The app says "The faculty added an owner access" and asks you to confirm.
4. The old access is not removed automatically. Open **Share** and revoke it.

Without a recovery code, recovery works only if you stored an e-mail address as recovery contact when you created the vault;
the waiting period is then 7 days. With neither, your data cannot be recovered.

## If a dialog says "Sandbox"

If a dialog starts with **Sandbox** (or a bar at the top of the page says so), you are in a **test copy** of an app. Do not enter real data. Everything in the sandbox is **deleted every night**,
there is no recovery code and nobody can restore a sandbox vault. Developers use it to try their apps; it is not a place to keep anything.

## Your data, your export

Use the app's **Export** button, or open [{{base}}/export/]({{base}}/export/) in any browser, enter the app ID and access ID (or
key file) and your passphrase, and download everything decrypted as a ZIP file. The files are not encrypted: store them carefully.

**Files you download from an app are not encrypted**, whatever they are: a CSV table, an attachment, a PDF, the export ZIP. Once a file is on your computer, it is protected only by what protects your computer.
