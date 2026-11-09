import {deriveCoverage} from '../../../packages/shared/src/coverage';
import {Badge, PageHeading} from './App';
import type {Catalog, StudyState} from './types';

export function Standards({catalog,state,onPractice}:{catalog:Catalog;state:StudyState;onPractice:()=>void}) {
  const coverage=deriveCoverage(catalog,state);
  return <>
    <PageHeading eyebrow="INVENTORY ≠ MASTERY" title="The whole framework. Visible gaps." text="Each official statement has its own coverage record. Broad skill alignments do not prove that every linked statement was taught or tested. Partial instruction and scoped observations never complete an objective."/>
    <section className="panel" aria-label="Coverage denominators">
      <h2>{coverage.totals.objectiveCount} objectives · {coverage.totals.statementCount} statement records</h2>
      <p>{coverage.totals.bulletCount} official descriptive bullets + {coverage.totals.referralCount} integration referral. Objective 0013 refers to objectives 0001–0012; it adds no descriptive bullet.</p>
      <div className="coverage-counts"><span>{coverage.totals.mappedStatementCount} mapped statements</span><span>{coverage.totals.partialInstructionCount} with partial instruction</span><span>{coverage.totals.reviewedPracticeCount} with scoped reviewed practice</span><span>{coverage.totals.independentEvidenceCount} with scoped independent observations</span><span>{coverage.totals.pendingJudgmentCount} with pending judgments</span><span>{coverage.totals.gapCount} statement gaps</span></div>
      <p className="small">These are counts of statement records with some support, out of {coverage.totals.statementCount}; they are not completion percentages or mastery scores. Source-checked practice is model-assisted/source-compared, not human validated. Lessons are derived instruction; displaying one is not evidence that it was learned.</p>
      <details><summary>Coverage contract limits · version {coverage.contractVersion}</summary><ul>{coverage.limitations.map((limit,index)=><li key={index}>{limit}</li>)}</ul></details>
    </section>
    <div className="coverage-list space-top">{coverage.objectives.map(objective=>{
      const record=catalog.objectives.find(o=>o.id===objective.objectiveId)!;
      const statements=coverage.statements.filter(s=>s.objectiveId===objective.objectiveId);
      return <details key={record.id} className="panel">
        <summary><span className="objective-number">{record.id.split('.').at(-1)}</span><span>{record.text}</span><span className="badge amber">{objective.gapCount} / {objective.statementCount} statement gaps</span></summary>
        <p className="tiny muted">Objective version {String(record.version)} · source {record.sourceVersionId}</p>
        <div className="coverage-counts"><span>{objective.bulletCount} bullets + {objective.referralCount} referral</span><span>{objective.partialInstructionCount} partial instruction</span><span>{objective.reviewedPracticeCount} scoped reviewed practice</span><span>{objective.independentEvidenceCount} scoped independent observations</span><span>{objective.pendingJudgmentCount} pending judgment</span></div>
        {statements.length===0&&<p className="notice">Inventory gap: this objective has no statement records. An empty objective is never complete.</p>}
        {statements.map(statement=><article key={statement.statementId} className="statement">
          <p className="tiny muted">{statement.statementId} · version {String(statement.version)} · source {statement.sourceVersionId} · source version {String(statement.sourceVersion??'missing')} · {statement.sourceState.replaceAll('_',' ')}</p>
          <Badge value={statement.kind}/><p>{statement.text}</p>
          <p className="small"><strong>Inventory:</strong> recorded. <strong>Mapping:</strong> {statement.mappedSkillIds.length?statement.mappedSkillIds.map(id=>catalog.skills.find(s=>s.id===id)?.title??id).join('; '):'none'}.</p>
          <p className="small"><strong>Partial instruction:</strong> {statement.partialInstruction.length?'Derived lesson scope below.':'No explicit lesson scope established.'}</p>
          {statement.partialInstruction.map((lesson,index)=><p className="small" key={index}>{catalog.lessons.find(l=>l.id===lesson.lessonId)?.title??lesson.lessonId}: {lesson.scope}</p>)}
          <p className="small"><strong>Reviewed practice:</strong> {statement.reviewedPractice.length} explicitly scoped tasks.</p>
          {statement.reviewedPractice.length>0&&<details><summary>Task scope and review provenance</summary>{statement.reviewedPractice.map((task,index)=><p className="small" key={index}>{task.taskId} · v{String(task.taskVersion)} · {task.reviewState.replaceAll('_',' ')} — {task.scope}</p>)}</details>}
          <p className="small"><strong>Independent evidence:</strong> {statement.independentEvidence.length} qualifying observations within the explicit task scope. <strong>Pending judgments:</strong> {statement.pendingJudgments.length}. {statement.needsRecheck&&<strong>Needs recheck; earlier successes do not resolve current uncertainty.</strong>}</p>
          {statement.historicalObservations.length>0&&<p className="small">{statement.historicalObservations.length} archived observations retained under their original task versions.</p>}
          {statement.independentEvidence.length>0&&<details><summary>Scoped observation identities</summary>{statement.independentEvidence.map(observation=><p className="small" key={observation.attemptId}>{observation.attemptId} · {observation.taskId} v{String(observation.taskVersion)}{observation.historical?' · archived version':''} — {observation.scope}</p>)}</details>}
          {statement.exclusions.length>0&&<details><summary>Why observations do not qualify ({statement.exclusions.length})</summary>{statement.exclusions.map((exclusion,index)=><p className="small" key={index}>{exclusion.attemptId}: {exclusion.reason}</p>)}</details>}
          <div className="notice"><strong>Remaining gaps</strong><ul>{statement.gaps.map((gap,index)=><li key={index}>{gap}</li>)}</ul></div>
        </article>)}
      </details>;
    })}</div>
    <h2 className="space-top">Recommended learning paths</h2><p className="muted">These are soft prerequisites. You can start any diagnostic or advanced task now.</p>
    <div className="panel">{catalog.prerequisites.map(edge=><p key={edge.id}><strong>{catalog.skills.find(s=>s.id===edge.fromSkillId)?.title}</strong> <span aria-hidden="true">→</span> <strong>{catalog.skills.find(s=>s.id===edge.toSkillId)?.title}</strong><br/><span className="small muted">{edge.rationale}</span></p>)}<button type="button" onClick={onPractice}>Bypass recommendations and practice</button></div>
    <h2 className="space-top">Separate endorsement crosswalk</h2><p className="muted">{catalog.competencies.length} competencies and {catalog.indicators.length} teacher indicators have separate denominators. These links are standards alignments, not prerequisite edges or evidence of full instruction.</p>
    {([{label:'603 CMR 7.14 competencies',items:catalog.competencies},{label:'603 CMR 7.08 teacher indicators',items:catalog.indicators}]).map(({label,items})=><section className="panel space-top" key={label}><h3>{label}</h3>{items.map(item=><details key={item.id}><summary>{item.id}</summary><p>{item.text}</p><p className="tiny muted">Source {item.sourceVersionId}</p>{catalog.alignments.filter(a=>a.statementId===item.id).map(a=><p key={a.id} className="small">{catalog.skills.find(s=>s.id===a.skillId)?.title}: {a.rationale}</p>)}</details>)}</section>)}
  </>;
}
