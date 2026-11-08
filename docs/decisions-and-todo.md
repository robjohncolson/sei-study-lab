# Decisions and remaining work

- Use installed Node 22.17.1 / npm 10.9.2. Built-in SQLite DatabaseSync and backup are available, avoiding native addons. Node reports SQLite experimental. Node 24 LTS is preferred for a later user-managed runtime update; it was not installed or claimed tested.
- One package manages apps/web, apps/server and packages/shared. This keeps installation and offline operation simple.
- No classroom repository patterns were inspected; interface/navigation/persistence patterns are proposed for this app.
- Default is zero inference, zero model requests, no auth service, no deployment, no cloud infrastructure.
- Optional AnkiConnect, DeepSeek/local adapters and BKT are deferred. No credentials, model weights or browser binaries were acquired.
- Review every source's retrieved/effective dates before relying on policy details. Current retrieval does not guarantee a specific rule's effective date.
- All source and task reviews are machine-assisted unless explicitly recorded otherwise. Human review remains a gap.
- Follow-up publication requires explicit user authorization after reviewing ignored runtime/private data, public source licensing, dependency audit, and the proposed Git diff. No remote, staging, commit or publication occurs in this build.
