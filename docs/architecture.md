# Architecture and evidence rules

The browser renders React locally. Vite proxies /api to Fastify during development. Built assets and the API share http://127.0.0.1:4317. The server uses node:sqlite, parameterized statements, versioned catalog rows, and append-only learning events. React text rendering treats imported strings as text, never executable HTML. No runtime source fetch or inference is needed.

The main boundaries are content/catalog.json (versioned public/derived curriculum), packages/shared (Zod catalog/proposal validation, graph validation and readiness), apps/server (security, SQLite, data interchange and manual judgment approval), and apps/web (accessible study workspaces). The root npm package coordinates these directories without separate package manifests; this reduces tooling for one small local application while keeping the requested separation.

A task is identified by stable ID plus version. Attempts retain exact submitted answer JSON, help usage, timestamp, family, novelty and mentor-text identity. Authored-key checking handles only bounded answer variants. Unrecognized short answers and extended responses require review. No arbitrary essay is failed for absent keywords.

Readiness is an educational heuristic, never a probability of passing. Two eligible successes must come from different item families at least 24 hours apart. Hints and draft tasks cannot qualify. Transfer also needs an explicit unfamiliar scenario. A later eligible failure flags needs_recheck without removing prior evidence. An objective with no practice is a gap, even when its official statements are inventoried.

A manual judgment export selects private answers explicitly. A returned proposal must identify the packet, attempt, task and rubric versions and quote only original-answer text. Preview does not approve it. Local approval appends a provisional judgment; it is not official scoring or independent human validation of curriculum.

Anki export is a separate memory workflow. Stable IDs support controlled note reimport. TSV export does not synchronize reviews and cannot prove transfer learning. BKT, AnkiConnect, local model adapters and cloud model adapters are deliberately absent.
