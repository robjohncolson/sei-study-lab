// Offline, append-only authoring recipe. Run with Node 22.17 --experimental-strip-types.
// The installed catalog is the immutable baseline, not regenerated from templates.
// Author drafts in obj0001-module.json; a separate recorded model comparison must
// approve exact payload hashes before this recipe installs source_checked tasks.
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

type RecordRow = {id: string; version?: string | number; [key: string]: unknown};
const read = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const payloadHash = (row: RecordRow) => createHash('sha256').update(canonical(row)).digest('hex');
const catalog = read('./catalog.json');
const {sources} = read('./obj0001-sources.json') as {sources: RecordRow[]};
const {lessons, tasks} = read('./obj0001-module.json') as {lessons: RecordRow[]; tasks: RecordRow[]};
const {reviewEvents} = read('./obj0001-review.json') as {reviewEvents: RecordRow[]};

for (const [kind, rows] of [['source', sources], ['lesson', lessons], ['task', tasks]] as const) {
  for (const row of rows) {
    const review = reviewEvents.find(e => e.entityType === kind && e.entityId === row.id);
    if (!review || review.reviewerKind !== 'model' || review.payloadSha256 !== payloadHash(row)) {
      throw new Error(`Missing or stale model comparison for ${row.id}; do not promote a draft automatically.`);
    }
    if (kind === 'task' && row.reviewState !== 'source_checked') throw new Error(`Unreviewed task: ${row.id}`);
    if (kind === 'source' && row.reviewState !== 'source_compared') throw new Error(`Uncompared source: ${row.id}`);
  }
}

// A source ID is itself a snapshot key; tasks also have an explicit version.
// Refuse every same-key conflict rather than rewriting evidence used by history.
const additions = {sources, lessons, tasks, reviewEvents};
for (const [table, rows] of Object.entries(additions)) {
  const installed = catalog[table] as RecordRow[];
  for (const row of rows) {
    const old = installed.find(x => x.id === row.id && (table !== 'tasks' || String(x.version) === String(row.version)));
    if (old) {
      if (canonical(old) !== canonical(row)) throw new Error(`Immutable catalog conflict: ${table}/${row.id}`);
    } else installed.push(row);
  }
}
writeFileSync(new URL('./catalog.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n');
console.log('Appended reviewed Objective 0001 slice; all installed records preserved.');
