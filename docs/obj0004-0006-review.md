# Objectives 0004–0006: bounded curriculum and supplied-packet review

This slice starts at clean `189d52fd001240b7fb5f18eaeea47e50ba1de575` on `athena/20261109-084503-6a8973`. HEAD and local `main` matched before edits. No local `origin/main` ref was available; no network request was made to inspect a remote. Staging and commit are bridge-owned under the task's specific authorization; the agent leaves the Git index untouched.

## Curriculum and immutable history

Three original unofficial lessons add content and language goals, staged explanations, reasoned worked examples/counterexamples and assisted guided feedback. Thirteen unaided MC checks sample distinct packet targets T1–T13, three unfamiliar nonmath cases require justified plans with uncertainty, and six native cards provide recall support. Reading, guided pauses and cards create no independent evidence. Cases retain the existing provisional/manual `needs_review` behavior without answer keys or keyword grading. An unfamiliar tag is not evidence of transfer.

The original four Objective 0004, six Objective 0005 and six Objective 0006 descriptive statements are copied exactly into S1 and remain unchanged in the catalog. Coverage contract v3 appends 24 bindings after its exact 25-entry prefix; its representation and evidence semantics are unchanged, so no version bump is needed. Each finite check has one narrow decision scope. Five statements have lesson-only scopes: 0005.ds.01/.03/.05 and 0006.ds.02/.06. All statements retain explicit gaps; no objective is complete.

Every prior catalog entity remains in its original order with identical content, including all sources, lessons, task versions, cards, mentor texts and review events. An independent final audit compared all 315 prior entities as raw JSON object substrings, including internal whitespace, text and key order: every entity is byte-for-byte preserved. Exact catalog and contract fixtures from the required base are checked in under `tests/fixtures/`, SHA-256 verified by `tests/obj0004-0006-baseline.ts`. Read-only Git blob comparison also confirmed the fixture bytes match the base blobs (`df55d2e30d50b7313ac28147d793ea9dd608407e` and `74d476ca6c847e91bd6c655d65bcbfbf9717b7b3`). Tests use these fixtures without requiring Git.

The author recipe now includes the new bundle and its optional cards. It requires matching model-review hashes for sources, lessons, tasks and cards before installation and refuses same-identity conflicts. Existing Objective 0001/0002/0003 tests retain their original assertions over their exact module ranges and prior-card prefixes. Real-catalog native integration counts use `catalog.cards.length`; the hosted synthetic 12-card fixture is unchanged.

## Claim-to-source comparison

All source material is the **supplied packet**, not a new retrieval. Source metadata retains exact URLs, edition/date cues, the seven supplied binary SHA-256 values, date-only `retrievedAt: 2026-11-08` and `America/New_York`. Codex did not fetch the URLs, download original binaries or independently verify binary hashes. New IDs are `source.obj0004-0006.s1` through `.s10`, each suffixed `.2026-11-08`; earlier snapshots are not reused with changed content.

| Target/check | Packet support and narrow decision |
| --- | --- |
| T1 `obj0004.sound-or-part` | S1 language units/terminology; S5 word parts: distinguish a pronunciation sound target from meaningful parts. |
| T2 `obj0004.argument-forms` | S1 forms/functions; S2 dimensions; S7 arguing with evidence: select claim/evidence structures for the actual purpose. |
| T3 `obj0004.audience-register` | S1 context/audience/register: adapt forms for the audience without inferring personality. |
| T4 `obj0004.cognate-resource` | S3 language assets and S5 cognates: check a useful cross-language connection; availability is not universal. |
| T5 `obj0004.false-friend` | S1 transfer and S5 false cognates: contrast meanings in context without discarding all L1 resources. |
| T6 `obj0005.domain-profile` | S2 domain snapshots and rigorous access: support writing separately from speaking while retaining complex content. |
| T7 `obj0005.pld-boundary` | S2 inapplicable PLD uses: language proficiency alone cannot determine cognitive ability, readiness or disability placement. |
| T8 `obj0005.non-linear` | S2 topic/audience/situation: contextual performance variation does not establish permanent linear regression. |
| T9 `obj0005.risk-and-rigor` | S1 environment/feedback purposes; S7 safe, risk-encouraging rigorous learning: support participation without removing demanding ideas. |
| T10 `obj0006.word-sequence` | S5 Rec 1, S6 classroom tips: small word set, multiple days and varied activities in the K–8 scope. |
| T11 `obj0006.content-talk` | S5 Rec 2 and joint S5/S6 excerpt block: daily content talk/listening with written follow-through. |
| T12 `obj0006.polysemy` | S1 multiple-meaning cue and S5 contextual vocabulary: distinguish meanings across content contexts. |
| T13 `obj0005.sci-esl` | S7: content ELD and dedicated ESL coexist; do not remove students from core SEI content. |

Cases demand different reasoning: revise an argument for different audiences while preserving uncertain chronology (0004); analyze an uneven domain profile and competing museum-content plans, prioritize two follow-up observations and identify a comparison confounded by changed topic and visual support (0005); justify a multi-day civic vocabulary and talk sequence using cognate/false-cognate/polysemy/morphology considerations, then respond to incomplete new access information (0006). These are authored planning applications of excerpts, not official writing prompts or deterministic scoring rules.

The six card backs are compared against the particular packet excerpts named by their `source` field. All retain the existing five-field card shape and objective/skill/version/application tags. Five equivalent MC concepts reuse existing families: domain profile, language/disability, preserving rigor, oral-to-writing and shared responsibility. Distinct transfer decisions have separate families; renamed wording does not reset an existing concept's cooldown.

S2 supports domain-at-a-time, non-linear performance and the prohibition on restricting complex texts or using PLDs alone for high-stakes decisions. S9's WIDA quotation supports reciprocal L1/English academic-language resources as a planning stance, not a universal BICS/CALP timetable. S3 supports assets, individual experiences and multiple modalities without learning-style types. S4/S10 Can Dos supplement standards and are not yet updated to the 2020 Edition. S5 Rec 1 and Rec 2 retain their Strong ratings, the Rec 2 content-acquisition qualification and K–8 scope, without effect sizes or unrestricted extrapolation. S6's oral-practice excerpts were jointly supplied under S5/S6; the record does not imply independent binary attribution.

S8 has inventory metadata only and supports no lesson, task, card or scope claim. Beck's tiers monograph and Cummins's primary text were not supplied: no tier-membership rules, fixed word lists, iceberg diagram or acquisition clock is invented. T14 learning-styles matching remains a pedagogy caution/gap, not an additional assessed Field 56 requirement. Complete linguistic systems, factor effects/causal rankings, WIDA progressions/Speaking Rubric and technology methods remain explicit gaps.

## Review process and checks

The content author and comparison reviewer are separate model passes. After reviewing all thirteen keys, thirty-nine wrong-option rationales, three lessons, three cases and six cards, the reviewer recorded 35 exact canonical payload SHA-256 values at `2026-11-09T14:00:25.076Z`. Events specify `reviewerKind: model`, supplied-packet provenance and explicit **not human review** limits. This actual review time is not a source retrieval time. Source-checked status describes the content comparison only. No human-review event or learner success is fabricated.

The separate pass repaired source encoding, added missing supplied WIDA snapshot/language-variety excerpt anchors, labeled S1/S5 packet notes without presenting them as official quotations, clarified joint S5/S6 attribution, strengthened a T1 rationale's S2 source binding and an Objective 0006 feedback citation, and added the distinct observation-design constraint to the Objective 0005 case. Final lesson fingerprints are `2a276ff3`, `c5003db1` and `a208b972`. The author recipe installed only the final hash-matched payloads.

| Check on Node 22.17.1 | Actual result |
| --- | --- |
| `node --experimental-strip-types content/author-seed.ts` | Passed: reviewed slice appended; previous records preserved. |
| `node --experimental-strip-types scripts/verify-obj0001.mjs` | **8 passed**, 0 failed. |
| `node --experimental-strip-types scripts/verify-obj0002-0003.mjs` | **10 passed**, 0 failed. |
| `node --experimental-strip-types scripts/verify-obj0004-0006.mjs` | **11 passed**, 0 failed: exact history/scopes, source metadata, keys/feedback, manual boundaries, card bindings, model hashes, family correlations, recipe idempotency and conflict/stale-review rejection. |
| Strip-types syntax checks for changed/new TypeScript and verifier code | Passed; syntax only, not typechecking. |
| Catalog/contract counts and JSON/hash audit | Passed: 12 lessons, 56 checks, 9 cases, 18 cards, 67 tasks, 40 sources; 49 bindings over 32 statements. |
| `git diff --check`, changed-path and index audit | Passed: 20 intended paths, no protected paths or manifest changes, no staged files. |
| Vitest, integration, content validation, typecheck, lint, build and Playwright | **Unrun:** dependencies absent; provisioning forbidden. Nine new Vitest cases and three additional browser cases are authored for the coordinator. |

Full dependency-based suites, build, lint, schema validation and browser execution are unavailable in this worktree because dependencies are absent and provisioning is forbidden. Existing configured browser/integration paths also use protected runtime databases; these checks remain for the separately authorized coordinator. Added browser assertions open each new lesson, a linked check and its manual case and verify that navigation creates no attempts, drafts or evidence writes. The new Vitest cases exercise finite grading, provisional cases, cooldowns, immutable history, assisted/draft exclusion, native-card evidence separation and preservation of earlier card events/responses through append and rebuild. Those runtime assertions have not been executed here.

GitNexus upstream requests for `SOURCE_COVERAGE_CONTRACT`, file-qualified authoring `catalog`, `parseSliceBaseline` and affected test symbols returned no matching application targets: risk **UNKNOWN**, with no applicable direct callers or processes. Local tracing finds `deriveCoverage` consuming the contract for Standards/planner/tests, the author recipe producing the catalog consumed by server/UI validation, and test runners consuming the changed regressions. Local risk is moderate for curriculum scope/provenance and low for append plumbing and tests; there is no HIGH/CRITICAL tool result. No production scoring, storage, scheduling, authentication or hosting logic changes.

`gitnexus detect_changes --scope all --repo Projects` was attempted after installation. Its indexed location reported “Not a git repository,” so it supplied no usable change analysis. Repository-local fixture, diff and allowed-path audits provide the applicable checks; no index/configuration was created and staging/commit remain bridge-owned.

## Changed files

- Content: `content/catalog.json`, `content/author-seed.ts`, and `content/obj0004-0006-{module,sources,review}.json`.
- Scope: `packages/shared/src/coverage-contract.ts`.
- New verification: `tests/obj0004-0006.test.ts`, `tests/obj0004-0006-baseline.ts`, both `tests/fixtures/*-189d52fd001240b7fb5f18eaeea47e50ba1de575.*` files, and `scripts/verify-obj0004-0006.mjs`.
- Compatibility/browser: `tests/obj0001.test.ts`, `tests/obj0002-0003.test.ts`, both older objective verifiers, `apps/server/native.integration.test.ts`, and `apps/web/e2e.spec.ts`.
- Documentation: `README.md`, `docs/coverage-and-planner.md`, and this review.

No protected paths, dependency manifests or learner runtime data are changed. No dependencies, browsers or models are installed; no network, publication or deployment action is performed.
