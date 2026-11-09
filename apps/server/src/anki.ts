import type { Catalog } from '../../../packages/shared/src/index.js';

/** Pure catalog export shared by local and hosted HTTP adapters. */
export function exportAnkiTsv(catalog: Catalog): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\t/g, ' ').replace(/\r?\n/g, '<br>');
  return '#separator:Tab\n#html:true\n#columns:StableID\tFront\tBack\tSource\tTags\n' + catalog.cards.map(c => [c.id, c.front, c.back, c.source, c.tags.join(' ')].map(escape).join('\t')).join('\n') + '\n';
}
