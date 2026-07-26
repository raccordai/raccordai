# Security policy

Raccord is a desktop application that stores third-party API keys (kie.ai,
Anthropic) and runs a local HTTP server on the loopback interface. Security
reports are taken seriously — thank you for taking the time.

## Supported versions

Only the latest released version is supported. Fixes ship in a new release;
there are no backports to older tags.

| Version        | Supported |
| -------------- | --------- |
| Latest release | ✅        |
| Anything older | ❌        |

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Use one of these private
channels instead:

1. **Preferred** — GitHub private vulnerability reporting:
   [Report a vulnerability](https://github.com/raccordai/raccordai/security/advisories/new)
   (_Security_ tab → _Report a vulnerability_). It creates a private advisory
   only you and the maintainers can see.
2. Email <romainmanniez@gmail.com> with `[security]` in the subject.

Please include:

- the affected version (Settings → About shows it) and OS;
- what an attacker can achieve (read a key, execute code, reach the local
  server from another origin…);
- reproduction steps, and a proof of concept if you have one.

### What to expect

- **Acknowledgement within 5 days.** This is a solo-maintained project, not a
  24/7 security team — please allow for that.
- A fix or a mitigation plan within 30 days for anything exploitable, then a
  release and a published advisory crediting you (unless you prefer to stay
  anonymous).
- Please give us that window before disclosing publicly.

There is no bug bounty.

## Scope

In scope — anything that lets code or a website you did not authorize:

- read or exfiltrate the stored API keys;
- reach the local Hono server (`127.0.0.1:4517` by default) or the MCP
  endpoint without the bearer token;
- execute arbitrary code through a project file, a `.raccord` backup, a
  workflow JSON import or a downloaded media file;
- escape the renderer's sandbox (the renderer has no Node access — every
  main-process call goes through the zod-validated IPC contracts).

Out of scope:

- vulnerabilities in kie.ai, Anthropic or any other upstream service (report
  those to the service);
- anything requiring an attacker to already have your unlocked user session
  or filesystem write access to the app's data directory;
- unsigned Linux/Windows builds and macOS Gatekeeper prompts on
  self-built artifacts;
- dependency CVEs with no exploitable path in Raccord — those are handled by
  Dependabot at the normal release cadence, feel free to open a regular issue.

## How Raccord handles secrets

Knowing this may save you a report:

- API keys are encrypted through Electron's
  [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)
  (OS keychain-backed) and never leave the main process in the clear — the
  renderer only ever learns whether a key is configured.
- The local HTTP server binds to `127.0.0.1` only and every route requires a
  bearer token persisted in settings.
- All renderer→main traffic goes through the whitelisted, zod-validated
  channels in `src/shared/ipc/contracts.ts`; the renderer runs with context
  isolation and no Node integration.
- The repository runs GitHub secret scanning with push protection, so a key
  committed by accident is blocked at push time. Never commit one anyway.
