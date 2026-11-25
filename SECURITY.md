# Security policy

## Reporting a vulnerability

Please report security problems in the WIAI Datastore (the server, the client library, the tools, the protocol) privately, not in a public issue.

- **Contact:** use GitHub's private vulnerability reporting for this repository ("Security" tab → "Report a vulnerability"), or e-mail dh.psi@uni-bamberg.de.
- Describe what you found, how to reproduce it and which version or commit you used. Please do not include real user data.
- We acknowledge a report within a few working days, tell you what we plan, and name you in the fix if you wish.

## What is in scope

- The wire protocol and its checks (PROTOCOL.md), the server (`server/`), the browser library (`client/`), the tools (`tools/`) and the documentation pages served with the service.
- The faculty's escrow key is a documented exception to end-to-end encryption (PLAN.md, section 2); a report that "the operator can decrypt vaults" describes the design, not a flaw.

## What is not in scope

- Weak passphrases chosen by users, apps that are written badly (an app with its own storage or network calls), and denial of service by sheer volume against the public sandbox (the sandbox is limited and emptied every night on purpose).

## Supported versions

Only the library version that the service serves at https://wiai.uni-bamberg.de/datastore/client/ and the current state of this repository.
