# Anki TSV workflow

Export from Data & handoff → Anki. The file is UTF-8 TSV with fields in this order: StableID, Front, Back, Source, Tags. Create a note type with those fields and put StableID first. Front and Back should be the visible card templates; StableID is a matching key, not the question.

In Anki's text import dialog, explicitly select the intended note type and deck, inspect field mapping, and match existing notes by the first field (StableID) when updating. Map the fifth column to tags where the installed version supports it. The file includes separator/HTML/columns metadata; inspect the preview rather than assuming all versions interpret these headers identically. HTML is escaped and line breaks are encoded as br elements. Stable IDs and objective/skill/version tags are retained. Back up your Anki collection before any intentional reimport update.

The current Anki manual was retrieved in the source inventory. No installed Anki version was inspected or tested. Import UI labels/settings vary by version; verify those settings in your installed version. No APKG generation or AnkiConnect calls are implemented.

FSRS scheduling happens within Anki when configured there. This app neither implements FSRS nor assigns intervals. Exporting cards does not return review history. The app truthfully displays “reviews not synchronized”; self-ratings do not establish transfer mastery.
