# Database schema and interchange

Migration: apps/server/src/migrations/001-initial.sql, tracked in schema_migrations. SQLite foreign keys and WAL are enabled. All catalog/event rows carry entity_json for faithful versioned export alongside indexed relational fields.

| Area | Tables | Rules |
|---|---|---|
| Authority | source_versions, review_events | Versioned source identity; review events append only |
| Curriculum | objectives, statements, skills, alignments, prerequisites | Stable IDs, explicit versions; graph validated before startup |
| Practice | tasks, task_skills, mentor_texts, rubrics | Composite task/version references; exact mentor identity |
| Evidence | attempts, judgments, evidence_events | UUIDs and UTC timestamps; no UPDATE or DELETE via triggers |
| Interchange | import_batches | Content hash records import batches; existing identical event IDs are no-ops |
| Handoff | handoff_packets, proposal_approvals | Locally known packet/source identity required; approval appends provisional judgment |
| Optional memory links | anki_links, anki_review_events | Reserved for future consented synchronization; TSV currently does not synchronize |
| Working state | drafts | Mutable answer drafts; submission creates an immutable attempt |

Immutable catalog changes require a new version. Startup rejects changed contents under an existing immutable identity. Keep existing source/task versions when extending the catalog. Never edit runtime evidence to repair a score: append a superseding judgment.

Interchange schemaVersion 1 exports catalog snapshots, original attempts, judgments and evidence. Import accepts matching locally known catalog versions, validates references and independently checks authored-key judgments/evidence against the keys. It does not install arbitrary curriculum. It is bounded to 2 MB, previewed before explicit confirmation, and committed in one transaction. A conflicting ID aborts the entire import. Import data never controls a path, shell, network request or SQL statement.

Drafts and pending handoff packets are local working state, outside the evidence interchange. Use db:backup for a complete database backup including working state. The supported node:sqlite backup API produces a consistent snapshot including committed WAL data. Runtime databases, backups and exported answers are private and ignored by Git.

## Review-fix upgrade

Migration 002-versioned-drafts.sql keeps drafts_legacy_v1 as a read-only archive and creates drafts keyed by (task_id,task_version). Existing version-1 file databases must be opened through await SeiStore.open(), which completes a supported SQLite backup before migration. New/updated normal startup uses this path. Original attempts/judgments/evidence remain append-only.

State includes immutable taskVersions from storage; readiness uses these exact snapshots instead of only active catalog tasks. Evidence policy v2 independently excludes recent same-task/family feedback and records explanatory exclusions. Stored historical eligibility is not a current readiness cache. See review-fixes.md for the precise retest and recovery workflow.
