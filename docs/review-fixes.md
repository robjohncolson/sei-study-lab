# Review-fix behavior and safe restart

This revision addresses the four findings in codex-review-fixes.md. The review prompt is retained as historical input. Its no-push instruction applied to the proposed local repair; the user subsequently explicitly authorized publication of the repaired source to a public repository. This does not authorize exposing local databases or deploying a hosted service.

## 1. Feedback-dependent revisions

Evidence policy v2 derives independence from recorded attempts, not just the client hint counter. A previous response to the same task or item family (across task versions) counts as feedback exposure. A fresh retest must start at least 24 hours after the latest such response, with no hints or assistance. Waiting to submit a draft that was started inside the cooldown does not qualify. Keeping a parent attempt for lineage does not permanently disqualify a genuinely delayed retest.

Use **Start fresh retest** to deliberately begin a blank response with a new start timestamp. The server checks elapsed time; the button does not waive the cooldown. Repeated item families still count as one family for promotion. A feedback-trained correction cannot clear an independent failure or restore an older success pair.

Original answers, judgments and evidence rows are not rewritten. The dashboard applies policy v2 to legacy records, exposes exclusions, and uses effective eligible counts rather than historical raw eligibility flags. Imported evidence is data, not authority to promote readiness. A software timestamp rule cannot verify what someone consulted outside the application; this remains a transparent educational heuristic.

## 2. Draft navigation

Editors retain the newest edit synchronously, serialize saves to SQLite, and wait for the latest save before switching task, text or workspace. Navigation stays in the editor and announces an error if saving fails. Editing remains disabled until the initial draft is recovered, preventing a late load from overwriting new typing. A browser-close/reload warning covers unsaved work; the app does not claim to survive forced browser or operating-system termination before a save succeeds.

## 3. Historical task versions

The server supplies stored immutable task snapshots with state. Readiness resolves each attempt against its exact task version, including versions no longer active. A newer question does not erase earlier success or failure or create a new item family. The dashboard identifies observations under archived wording. Active task retirement, a missing snapshot, or an explicitly superseded source produces a visible recheck/exclusion rather than an unseen skill. These checks do not constitute a complete author-facing source-retirement workflow.

## 4. Versioned draft recovery

Drafts are now keyed by task ID and task version. Both editors check the prompt version; writing also retains mentor ID/version/hash and rubric identity. Drafts under earlier prompts are displayed separately. They are never loaded into or submitted as the new prompt automatically. A deliberate copy keeps the old draft and records assistance on the new working response.

Migration 002 retains the original draft table as a read-only legacy archive and copies its records into the new composite-key table. It does not alter attempt, judgment or evidence history. The supported startup path creates a consistent SQLite backup before upgrading an existing version-1 database. A failed backup stops the upgrade.

## Safe restart

Stop the old local server before starting the updated version:

```powershell
npm run content:validate
npm test
npm run build
npm start
```

The first updated startup on an existing database performs the backup and draft migration. Keep runtime/ and its backups private. Do not delete/reset your database. Development startup also uses the guarded migration path. Existing exports retain original event IDs; imports still require matching installed catalog versions.

See docs/implementation-status.md for the actual repair verification results. No learner database was opened to develop or test these repairs; regressions use synthetic isolated databases under runtime/.

### Recorded versus effective eligibility

New policy-v2 evidence stores the IDs of the same-task/family attempts that were known when the event was generated. Import validates those IDs and recomputes the recorded event against that context, preserving immutable event bytes. Readiness separately evaluates the complete merged attempt history; a valid historical event can therefore be excluded now. Removing context from a proposed import cannot manufacture current dashboard eligibility. Legacy policy-v1 records remain readable and are also interpreted using policy v2.

When an originally eligible failure and unparented correction share the same timestamp, feedback order can be ambiguous. The dashboard retains an explicit recheck signal until a strictly later independent observation; excluding both timestamps cannot revive an older success pair. This is a conservative uncertainty rule, not proof of the exact order.
