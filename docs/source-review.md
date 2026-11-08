# Source inventory and content review

The application uses a deliberate development snapshot in `content/catalog.json`. It does not fetch sources at startup. `content/inventory.json` retains the extracted source inventory; each source has its final URL, actual retrieval timestamp, SHA-256 of fetched bytes, a short matched excerpt, version, and review state. Retrieval is not an effective date. All effective-date fields are null because a separate legal commencement date was not established.

The source collection recipes are development tools, not runtime entry points. Do not run them casually against changed pages: changing a source, a statement, a key, or a mentor text requires a new immutable catalog/source version and an explicit comparison. IDs are persisted in the snapshot. Descriptive-statement labels were assigned once in source order for this snapshot; a later inserted statement must receive a new ID rather than renumber existing records. The stable objective identifiers come from the official framework.

## Actual retrieval and comparison

All nine requested official source URLs were reachable during implementation, plus four additional official sources: 603 CMR 14.02, the current DESE guidance landing page, the ELE monitoring inventory, and the June 2025 Massachusetts Language Survey Protocol. The DOCX protocol could not be read through the web tool because of its content type; it was then fetched and read in memory using PowerShell's .NET ZIP/XML support. No student files or credentials were accessed.

The exam-page comparison initially failed because its wording is “multiple-choice items,” while the supplied expected excerpt said “questions.” The fetched page was inspected, the actual excerpt compared, and the inventory regenerated successfully. This was a comparison mismatch, not a network outage. Final source statuses are `source_compared`, not `human_reviewed`.

Source comparison means the particular excerpt, extracted framework/regulation passage, or stated claim was checked. It does not mean an independent human reviewed an entire website or that every item on a landing page was opened. The Anki and DeepSeek entries establish the documentation inventory only; no integration was built or certified from those entries.

The framework has **13 objectives and 59 bullet descriptive statements**. Objective 0013 contains a referral to objectives 0001–0012 rather than a new list. Its exact referral is retained as `mtel56.obj.0013.reference.0001-0012`, bringing the database/catalog statement-record count to **60**. That record is a referral, not an invented sixtieth bullet. The separate regulatory inventory contains **11 competencies** from 7.14(1)(b) and **5 indicators** from 7.08(3)(a–e). Regulatory crosswalks are not prerequisite edges.

The fetched exam pages supported 60 multiple-choice items plus one five-part open response, four hours of testing, and qualifying scaled score 240. The framework reports approximate total-score weights of 10/28/22/40 percent. Online proctoring specifies 2 hours 30 minutes for open response and 1 hour 30 minutes for multiple choice, with a scheduled break and different total appointment time. These are source-snapshot facts, not a personal pass prediction, raw-score cutoff, or booking confirmation. Recheck the official test page before arranging an exam.

The public response sample provides Part I only. It describes a single mentor text retained across five parts and approximately 1,500 words combined. The four criterion definitions and holistic scale were extracted from its scoring rubric. The app's two five-part tasks are **authored derived practice**, not purported official Parts II–V. Both mentor texts are original authored practice and are bound to a version and SHA-256.

## Scope and limits of the policy seeds

The source-compared policy concepts are intentionally narrow: survey information is distinct from proficiency evidence; all educators share responsibility; current/former EL records do not replace evidence about a learner; status decisions require appropriate current procedures. The June 2025 protocol separates identification questions from family communication preferences. The current guidance landing page uses “Language Survey,” while older resources may say “Home Language Survey.”

603 CMR 14.02 was read directly. Its page reports a June 26, 2018 amendment and July 23, 2018 update. The 603 CMR 7.00 pages report a most-recent amendment of April 28, 2026. Those are source publication/amendment labels, not independently established effective dates. The starter content avoids numeric exit criteria, monitoring periods, accommodation entitlements, eligibility deadlines, and full legal conclusions. The detailed 2026 services/programming DOCX was discovered but not fully compared; these operational details remain policy-research gaps. The framework's historical statutory references remain exact inventory text and are not treated as current law.

## Authoring and actual review

The content agent authored the seed, then performed a separate reasoning/source comparison pass over the lessons, all 16 MC keys and their 32 keyed wrong-turn explanations, 8 bounded short-answer keys, 3 case checklists, and both writing scaffolds. The author and this reviewer are the **same model agent**. Review events state this limitation. There is no human review and no imported successful attempt.

A second model agent (the parent implementation agent) separately read all six lessons and reviewed the visible keys/distractors for survey/translation, shared planning, grammar versus content, formative use, oral rehearsal, and scaffolding, plus the cases/writing/rubric. It found the conceptual wording appropriately qualified and no unsupported numeric thresholds in that scope. This was independent model reasoning review of the stated scope, not independent source validation of every check and not human validation.

That second review identified a provenance improvement: the oral-rehearsal recall needed a clearer source rationale. The relevant tasks now also cite the framework, and `align.oral-to-writing.mtel0006` explicitly ties the authored routine to 0006's oral-language/literacy relationship. The official source supports the relationship; it does not mandate this single classroom routine. The exact “oral rehearsal” label is a bounded recall target used by this authored lesson, not a claim that only those words can be correct.

Each MC item has one explicit option key and tailored explanations for its two distractors. Short recall uses finite accepted variants; unrecognized wording requires review instead of automatic essay grading. Cases and writing have no deterministic answer key. These tasks require a judgment with quoted evidence and uncertainty. The status `source_checked` records source comparison, not psychometric validation or official endorsement.

## Counts and remaining gaps

Validated catalog: 6 lessons; 24 checks (16 MC, 8 short recall); 12 Anki cards; 3 multi-step cases; 2 authored mentor texts; 2 five-part writing practices; 9 derived skills; 23 alignments; 5 soft prerequisite edges; 13 source versions; 1 public rubric. The recipes seed 42 model review events. There are no human-reviewed tasks and no seeded learning evidence. The three cases and two writing practices have explicit unfamiliar-scenario tags; that tag alone does not grant transfer evidence.

Substantive initial lessons focus on 0001, 0008, and 0009. Oral-literacy and writing practice also map narrowly to 0006 and 0013; this does not imply those objectives are fully taught. Most of the framework and endorsement standard remains inventory or unmapped coverage. Full legal-policy coverage, broader subject-area transfer, independent human content review, rubric anchor/holdout evaluation, and scoring agreement studies remain unfinished. None of these seeds establishes exam readiness by itself.

Verification actually run: `npm run content:validate` passed after source extraction and seed generation. The validation checks schema, identities, source/skill references, prerequisite DAG, MC keys, five-part writing structure, and rubric references. It does not establish the truth of a pedagogical judgment or replace human review.
