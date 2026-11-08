// Deliberate development-only source collection. Never imported by the application.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const decode = (s: string) => s.replace(/<span[^>]*class="visually-hidden"[^>]*>[\s\S]*?<\/span>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|#160);/g, ' ').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&rsquo;|&#8217;/g, '’').replace(/&lsquo;/g, '‘').replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”').replace(/&reg;/g, '®').replace(/&sect;/g, '§').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/g, ' ').trim();
const specifications = [
  ['framework', 'https://www.mtel.nesinc.com/Content/StudyGuide/MA_SG_OBJ_56.htm', 'MTEL Field 56 overview and objectives', 'Apply understanding of all educators\' shared responsibility to educate and support all English language learners.'],
  ['exam', 'https://www.mtel.nesinc.com/TestView.aspx?f=HTML_FRAG/MA056_TestPage.html', 'MTEL Sheltered English Immersion (56) test information', '60 multiple-choice items and 1 open-response assignment consisting of 5 tasks'],
  ['preparation', 'https://www.mtel.nesinc.com/TestView.aspx?f=HTML_FRAG/MA056_PrepMaterials.html', 'MTEL Field 56 preparation materials', 'Sheltered English Immersion'],
  ['rubric', 'https://www.mtel.nesinc.com/Content/StudyGuide/MA_SG_CRI_56.asp', 'MTEL Field 56 public open-response sample and scoring rubric', 'Quality and relevance of supporting details.'],
  ['competencies', 'https://www.doe.mass.edu/lawsregs/603cmr7.html?section=14', '603 CMR 7.14 Endorsements', 'The basic structure and functions of language.'],
  ['indicators', 'https://www.doe.mass.edu/lawsregs/603cmr7.html?section=08', '603 CMR 7.08 Professional Standards for Teachers', 'Uses effective strategies and techniques for making content accessible to English learners.'],
  ['pathways', 'https://www.doe.mass.edu/retell/', 'Rethinking Equity and Teaching for English Language Learners (RETELL)', 'Sheltered English Immersion'],
  ['anki', 'https://docs.ankiweb.net/deck-options.html#fsrs', 'Anki Manual: Deck Options', 'FSRS'],
  ['deepseek', 'https://api-docs.deepseek.com/', 'DeepSeek API: Your First API Call', 'OpenAI'],
  ['identification', 'https://www.doe.mass.edu/lawsregs/603cmr14.html?section=02', '603 CMR 14.02 Identification and Assessment of Students', 'Each school district shall establish criteria, in accordance with Department guidelines, to identify students who may no longer be English learners.'],
  ['guidance', 'https://www.doe.mass.edu/ele/guidance/', 'Massachusetts English Learner Education: Guidance and Laws', '2026 Guidance on English Learner Education Services and Programming'],
  ['monitoring', 'https://www.doe.mass.edu/ele/cpr/', 'English Learner Education Program Monitoring & Compliance', 'Follow-Up Support'],
  ['survey', 'https://www.doe.mass.edu/ele/guidance/ma-language-survey-protocol.docx', 'Massachusetts Language Survey Protocol, June 2025', 'The Language Survey (LS) is the first step in identifying ELs'],
];
const sources: Record<string, unknown>[] = [];
const html: Record<string, string> = {};
for (const [key, url, title, excerpt] of specifications) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    html[key] = text;
    const comparison = key === 'survey' || decode(text).includes(excerpt);
    sources.push({ id: `source.${key}.2026-11-08`, url: response.url, title, retrievedAt: new Date().toISOString(), effectiveDate: null, sha256: hash(bytes), excerpt: comparison ? excerpt : '', reviewState: comparison ? 'source_compared' : 'unverified', version: '2026-11-08', checks: key === 'survey' ? 'DOCX read separately in memory with PowerShell ZipArchive; matched paragraph text. Publication June 2025, effective date not established.' : comparison ? 'Fetched bytes; excerpt compared with decoded visible text. Retrieval date is not an effective date.' : 'Fetch succeeded; supplied excerpt not matched, review pending.' });
  } catch (error) {
    sources.push({ id: `source.${key}.2026-11-08`, url, title, retrievedAt: new Date().toISOString(), effectiveDate: null, sha256: '', excerpt: '', reviewState: 'unverified', version: '2026-11-08', checks: String(error) });
  }
}
const objectives: Record<string, unknown>[] = [];
const statements: Record<string, unknown>[] = [];
const statementLabels = ['01','02','03','04','05','06','07','08','09','10','11','12'];
for (const match of html.framework.matchAll(/<h5>\s*Objective (\d{4}):\s*([\s\S]*?)<\/h5>([\s\S]*?)(?=<h5>|<\/div>)/g)) {
  const objectiveId = `mtel56.obj.${match[1]}`;
  objectives.push({ id: objectiveId, version: 1, sourceVersionId: 'source.framework.2026-11-08', text: decode(match[2]) });
  // Labels are assigned once to this exact source snapshot and persisted, never computed at runtime.
  const lis = [...match[3].matchAll(/<li>([\s\S]*?)<\/li>/g)];
  lis.forEach((li, position) => statements.push({ id: `${objectiveId}.ds.${statementLabels[position]}`, version: 1, objectiveId, sourceVersionId: 'source.framework.2026-11-08', text: decode(li[1]) }));
}
const competencySection = html.competencies.split('(b) Subject Matter Knowledge:')[1]?.split('</ol>')[0] ?? '';
const integrationReferral = '(Refer to objectives 0001 through 0012 and associated descriptive statements.)';
if (!decode(html.framework).includes(integrationReferral)) throw new Error('Missing objective 0013 integration referral');
statements.push({ id: 'mtel56.obj.0013.reference.0001-0012', version: 1, objectiveId: 'mtel56.obj.0013', sourceVersionId: 'source.framework.2026-11-08', text: integrationReferral });
const competencies = [...competencySection.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match, i) => ({ id: `cmr7.14.1b.${statementLabels[i]}`, text: decode(match[1]), sourceVersionId: 'source.competencies.2026-11-08' }));
const indicatorSection = html.indicators.split('<b>Indicators</b>')[1]?.split('</ol>')[0] ?? '';
const indicators = [...indicatorSection.matchAll(/<li><p>\(([a-e])\) ([\s\S]*?)<\/p><\/li>/g)].map(match => ({ id: `cmr7.08.3.${match[1]}`, text: decode(match[2]), sourceVersionId: 'source.indicators.2026-11-08' }));
const rubricHtml = html.rubric.split('<h4>Performance Characteristics</h4>')[1] ?? '';
const criteria = [...rubricHtml.split('</table>')[0].matchAll(/<th scope="row">(.*?)<\/th>\s*<td>(.*?)<\/td>/g)].map(m => ({ id: m[1].toLowerCase().replace(/ /g, '-'), title: m[1], text: decode(m[2]) }));
const scale: Record<string, string> = {};
for (const m of rubricHtml.matchAll(/<th class="center" scope="row">([1-4UB])<\/th>\s*<td>([\s\S]*?)<\/td>/g)) scale[m[1]] = decode(m[2]);
if (objectives.length !== 13 || competencies.length !== 11 || indicators.length !== 5 || criteria.length !== 4) throw new Error(`Unexpected source shape: ${objectives.length}/${competencies.length}/${indicators.length}/${criteria.length}`);
writeFileSync(new URL('./inventory.json', import.meta.url), JSON.stringify({ sources, objectives, statements, competencies, indicators, rubrics: [{ id: 'rubric.mtel56.public', version: 1, sourceVersionId: 'source.rubric.2026-11-08', criteria, scale }] }, null, 2) + '\n');
console.log(JSON.stringify({ objectives: objectives.length, statements: statements.length, competencies: competencies.length, indicators: indicators.length, sources: sources.length }));
