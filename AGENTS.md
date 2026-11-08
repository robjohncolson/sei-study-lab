# SEI Study Lab — contributor boundaries

This is an isolated, local-only study application. Make changes only in this repository. Do not touch classroom repositories or import student data. Do not commit, push, publish, acquire credentials, download models/browsers, or install system software without explicit authorization. Ordinary npm dependencies are permitted.

Use Node >=22.17 with built-in node:sqlite; tested runtime and exact dependency versions are recorded in README/package-lock.json. SQLite is experimental on the tested Node 22 runtime. Never substitute browser storage for authoritative evidence.

Commands: npm ci; npm run dev; npm run build; npm start; npm run typecheck; npm run lint; npm test; npm run test:integration; npm run test:e2e; npm run content:validate; npm run db:backup.

Bind only 127.0.0.1, retain Host/Origin/CSRF protection. No automatic external requests, model calls, telemetry or external assets. Keep secrets backend-only. Runtime databases, answers, imports/exports, configuration and backups belong under ignored runtime/. Use consistent SQLite backup, never copy a live database main file alone.

Attempts, judgments and evidence are immutable. Correct judgments with superseding events. Imported data is untrusted; validate schemas, identity, references and conflicts transactionally. Original answers must remain unchanged. Never mark drafts or hinted practice as independent evidence. Human review requires a real human action.

All official wording belongs in versioned source inventory; derived lessons/tasks must be visibly labeled. Do not invent policy thresholds or official writing prompts. Optional model/AnkiConnect integrations remain deferred until separately requested.

Before editing existing symbols run GitNexus upstream impact and report direct callers, processes and risk. New application symbols may not exist in the parent Projects index: report that limitation, inspect local callers and test. Warn on HIGH/CRITICAL. Before any authorized commit run GitNexus detect_changes; never stage or commit by default.
