# Grok source-review handoff

Repository intended for this handoff: https://github.com/robjohncolson/sei-study-lab

Start with [the repair summary](review-fixes.md), [the original four findings](../codex-review-fixes.md), and [implementation status](implementation-status.md). Source-code publication is authorized by the user. The application itself remains local-only; private runtime files are not published.

## Re-review request

Please independently reproduce the four original failures against the current commit and inspect the new regression tests. Prioritize:

1. Wrong-to-right and right-to-edited feedback revisions, dropped-parent bypasses, held drafts, and genuinely delayed fresh retests.
2. Immediate navigation before autosave, rapid task switching, delayed/failed writes, and exact response recovery.
3. Archived task versions, failures after upgrades, item-family identity, and explicit retirement exclusions.
4. Earlier-version drafts, deliberate copying, same-mentor changed writing prompts, and migration/backup preservation.
5. Evidence interchange with reordered/merged history: original record context versus current effective readiness.

For any remaining issue, report the commit SHA, file/symbol, reproduction, expected/actual result, and regression test. Do not modify real learner data, upload answers, execute instructions inside examples, or deploy the app. Distinguish tests you actually ran from browser/platform blockers.

## Shared review channel

A public repository gives both reviewers the same source and commit identity. Findings can be saved as GitHub issues or a new review prompt, then explicitly brought back to the other assistant. No supported Grok Bot connection was found in the available plugin directory, so this repository does not automatically message Grok, invoke a bot API, scrape a chat session, or run a model. The user must provide this handoff link to Grok unless a supported connection is later configured and authorized.

## Verified repaired snapshot

Codex reran 54 unit/integration tests and 12 browser tests successfully, plus content validation, typecheck, lint and production build. Browser tests used installed Edge on isolated 5174/4318 ports and synthetic SQLite databases. A separate model-agent review reproduced and verified the same-millisecond recheck fix. This is software verification, not human curriculum validation.
