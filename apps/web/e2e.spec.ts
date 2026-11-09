import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Catalog } from '../../packages/shared/src/index';

const catalog=JSON.parse(readFileSync('content/catalog.json','utf8')) as Catalog;
async function mockDesk(page:Page,options:{catalog?:Catalog;initialDrafts?:{taskId:string;taskVersion:string|number;answer:unknown}[]}={}) {
  const testCatalog=options.catalog??catalog;
  const drafts=new Map<string,{taskId:string;taskVersion:string|number;answer:unknown}>();
  for(const d of options.initialDrafts??[])drafts.set(`${d.taskId}@${d.taskVersion}`,d);
  const attempts:Record<string,unknown>[]=[],judgments:Record<string,unknown>[]=[],external:string[]=[],imports:unknown[]=[],writes:string[]=[];
  const controls={failSaves:false,delaySaveMs:0,delayLoadMs:0,failAfterSubmit:false,delaySubmitMs:0};
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost'){external.push(url.href);await route.abort();return;}
    if(!url.pathname.startsWith('/api/')){await route.continue();return;}
    if(route.request().method()!=='GET')writes.push(`${route.request().method()} ${url.pathname}`);
    const body=route.request().method()==='GET'?undefined:route.request().postDataJSON() as Record<string,unknown>;
    let result:unknown={};
    if(url.pathname==='/api/session')result={csrfToken:'test-only-session-token'};
    else if(url.pathname==='/api/catalog')result=testCatalog;
    else if(url.pathname==='/api/state')result={attempts,judgments,evidenceEvents:[],taskVersions:testCatalog.tasks,drafts:[...drafts.values()]};
    else if(url.pathname.startsWith('/api/drafts/')){
      const taskId=decodeURIComponent(url.pathname.split('/').at(-1)!),task=testCatalog.tasks.find(t=>t.id===taskId)!;
      if(body){
        if(controls.delaySaveMs)await new Promise(r=>setTimeout(r,controls.delaySaveMs));
        if(controls.failSaves){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic save failure'})});return;}
        drafts.set(`${taskId}@${body.taskVersion}`,{taskId,taskVersion:body.taskVersion as string|number,answer:body.answer});
      }else if(controls.delayLoadMs)await new Promise(r=>setTimeout(r,controls.delayLoadMs));
      result={answer:drafts.get(`${taskId}@${task.version}`)?.answer??null,taskVersion:task.version,currentTaskVersion:task.version,olderDrafts:[...drafts.values()].filter(d=>d.taskId===taskId&&String(d.taskVersion)!==String(task.version))};
    }else if(url.pathname==='/api/attempts'){
      if(controls.delaySubmitMs)await new Promise(r=>setTimeout(r,controls.delaySubmitMs));
      if(controls.failAfterSubmit)controls.failSaves=true;
      const attempt={id:`attempt-${attempts.length}`,taskId:body!.taskId,taskVersion:body!.taskVersion,originalAnswer:body!.answer,hintCount:body!.hintCount,submittedAt:new Date().toISOString()};attempts.push(attempt);
      const judgment={id:`judgment-${judgments.length}`,attemptId:attempt.id,result:{status:'pending_review',feedback:'Response preserved for review.'}};judgments.push(judgment);result={attempt,judgment};
    }else if(url.pathname==='/api/import/preview')result={newAttempts:1,conflicts:0};
    else if(url.pathname==='/api/import'){imports.push(body);result={imported:1};}
    else if(url.pathname==='/api/export')result={schemaVersion:1,attempts,judgments,evidenceEvents:[]};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  return {drafts,attempts,external,imports,controls,writes};
}
test('practice supports keyboard selection, hints, and recovered answers without external requests',async({page})=>{
  const service=await mockDesk(page);
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Build understanding. Keep the evidence.'})).toBeVisible();
  await page.getByRole('button',{name:'Begin a practice check'}).click();
  const choice=page.getByRole('radio').first();await choice.focus();await page.keyboard.press('Space');await expect(choice).toBeChecked();
  await page.getByRole('button',{name:'Save draft now',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await page.reload();
  await page.getByRole('button',{name:'Learn & practice',exact:false}).click();
  await expect(page.getByRole('radio').first()).toBeChecked();
  await page.getByRole('button',{name:'Use a hint',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await page.reload();
  await page.getByRole('button',{name:'Learn & practice',exact:false}).click();
  await expect(page.getByText('Hint used · 1',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Submit response',exact:true}).click();
  await expect(page.getByRole('heading',{name:'What this response shows'})).toBeVisible();
  expect(service.attempts[0]?.hintCount).toBe(1);
  expect(service.external).toEqual([]);
});

test('writing preserves the same authored mentor text across all five parts and reloads drafts',async({page})=>{
  const service=await mockDesk(page);await page.goto('/');await page.getByRole('button',{name:'Writing studio',exact:false}).click();
  const task=catalog.tasks.find(t=>t.kind==='writing')!;const mentor=catalog.mentorTexts.find(m=>m.id===task.mentorTextId)!;
  await expect(page.getByRole('heading',{name:mentor.title,exact:true})).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Ready to begin');
  for(const [index,part] of task.parts!.entries()){
    await page.getByRole('button',{name:`Part ${index+1} `,exact:false}).click();
    await page.getByLabel(`Your response for ${part.title}`,{exact:true}).fill(`Synthetic reasoning for part ${index+1}: preserve content goals and check evidence.`);
    await expect(page.getByRole('heading',{name:mentor.title,exact:true})).toBeVisible();
  }
  await page.getByRole('button',{name:'Save all parts now',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('All five parts saved');
  await page.getByRole('button',{name:'Preserve all five parts',exact:true}).click();
  await expect(page.getByText('All five parts were preserved together', {exact:false})).toBeVisible();
  const answer=service.attempts[0]?.originalAnswer as {mentorTextId:string;mentorTextHash:string;parts:Record<string,string>};
  expect(answer.mentorTextId).toBe(mentor.id);expect(answer.mentorTextHash).toBe(mentor.sha256);expect(Object.keys(answer.parts)).toEqual(task.parts!.map(p=>p.id));
  await page.reload();await page.getByRole('button',{name:'Writing studio',exact:false}).click();
  await expect(page.getByLabel(`Your response for ${task.parts![0]!.title}`,{exact:true})).toHaveValue(/Synthetic reasoning for part 1/);
  expect(service.external).toEqual([]);
});

test('JSON imports require a preview and explicit confirmation; TSV does not claim synchronized reviews',async({page})=>{
  const service=await mockDesk(page);await page.goto('/');await page.getByRole('button',{name:'Take it with you',exact:false}).click();
  await expect(page.getByText('Reviews not synchronized.',{exact:true})).toBeVisible();
  await page.getByLabel('Preview a saved JSON import').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({schemaVersion:1,attempts:[]}))});
  await expect(page.getByRole('heading',{name:'Import preview',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Confirm local import',exact:true})).toBeDisabled();expect(service.imports).toHaveLength(0);
  await page.getByLabel('I reviewed this preview and want to import these records.').check();
  await page.getByRole('button',{name:'Confirm local import',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Import complete');expect(service.imports).toHaveLength(1);expect(service.external).toEqual([]);
});

test('real local API preserves a browser response and serves all standards',async({page})=>{
  const external:string[]=[];
  await page.route('**/*',async route=>{const host=new URL(route.request().url()).hostname;if(host!=='127.0.0.1'&&host!=='localhost'){external.push(host);await route.abort();}else await route.continue();});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Build understanding. Keep the evidence.'})).toBeVisible();
  await page.screenshot({path:'runtime/ui-preview.png',fullPage:true});
  mkdirSync('runtime/test-databases',{recursive:true});
  const privateFile=resolve('runtime/test-databases/fs-private.txt');
  writeFileSync(privateFile,'SYNTHETIC PRIVATE MARKER');
  const denied=await page.request.get(`/@fs/${privateFile.replaceAll('\\','/')}`);
  expect(denied.status()).toBe(403);
  expect(await denied.text()).not.toContain('SYNTHETIC PRIVATE MARKER');
  await page.getByRole('button',{name:'Begin a practice check'}).click();
  await page.getByRole('radio').first().check();
  await page.getByRole('button',{name:'Submit response',exact:true}).click();
  await expect(page.getByRole('heading',{name:'What this response shows'})).toBeVisible();
  await page.getByRole('button',{name:'Learning evidence',exact:false}).click();
  await expect(page.getByRole('heading',{name:'Response archive',exact:true})).toBeVisible();
  await expect(page.locator('.history details')).not.toHaveCount(0);
  await page.getByRole('button',{name:'Standards map',exact:false}).click();
  await expect(page.locator('.coverage-list>details')).toHaveCount(13);
  expect(external).toEqual([]);
});


test('immediate keyboard workspace navigation flushes practice edits and reload restores them',async({page})=>{
  const service=await mockDesk(page),task=catalog.tasks.find(t=>t.kind==='short')!;
  await page.goto('/');await page.getByRole('button',{name:'Learn & practice',exact:false}).click();
  await page.locator('.task-list').getByRole('button',{name:task.title,exact:false}).click();
  await page.getByLabel('Your response',{exact:true}).fill('Latest practice edit before debounce');
  await page.getByRole('button',{name:'Standards map',exact:false}).focus();await page.keyboard.press('Enter');
  await expect(page.locator('.coverage-list>details')).toHaveCount(13);
  await page.reload();await page.getByRole('button',{name:'Learn & practice',exact:false}).click();
  await page.locator('.task-list').getByRole('button',{name:task.title,exact:false}).click();
  await expect(page.getByLabel('Your response',{exact:true})).toHaveValue('Latest practice edit before debounce');
  expect((service.drafts.get(`${task.id}@${task.version}`)?.answer as {response:string}).response).toBe('Latest practice edit before debounce');
});

test('rapid practice task switches serialize in-flight saves without cross-writing',async({page})=>{
  const service=await mockDesk(page),[first,second]=catalog.tasks.filter(t=>t.kind==='short');service.controls.delaySaveMs=150;
  await page.goto('/');await page.getByRole('button',{name:'Learn & practice',exact:false}).click();
  await page.locator('.task-list').getByRole('button',{name:first!.title,exact:false}).click();
  await page.getByLabel('Your response',{exact:true}).fill('First task latest');
  await page.getByRole('button',{name:'Save draft now',exact:true}).click();
  await page.getByLabel('Your response',{exact:true}).fill('First task newest while saving');
  await page.locator('.task-list').getByRole('button',{name:second!.title,exact:false}).click();
  await expect(page.locator('.practice-card h2')).toHaveText(second!.title);
  await page.getByLabel('Your response',{exact:true}).fill('Second task latest');
  await page.locator('.task-list').getByRole('button',{name:first!.title,exact:false}).click();
  await expect(page.getByLabel('Your response',{exact:true})).toHaveValue('First task newest while saving');
  expect((service.drafts.get(`${second!.id}@${second!.version}`)?.answer as {response:string}).response).toBe('Second task latest');
});

test('immediate writing workspace and text switches preserve exact latest drafts',async({page})=>{
  const service=await mockDesk(page),[first,second]=catalog.tasks.filter(t=>t.kind==='writing');service.controls.delaySaveMs=100;
  await page.goto('/');await page.getByRole('button',{name:'Writing studio',exact:false}).click();
  await page.locator('#writing-answer').fill('Math draft typed immediately before text switch');
  await page.getByLabel('Practice text and task').selectOption(second!.id);
  await expect(page.locator('#writing-answer')).toHaveValue('');
  await page.locator('#writing-answer').fill('Science draft before workspace switch');
  await page.getByRole('button',{name:'Standards map',exact:false}).click();
  await expect(page.locator('.coverage-list>details')).toHaveCount(13);
  await page.reload();await page.getByRole('button',{name:'Writing studio',exact:false}).click();
  await expect(page.locator('#writing-answer')).toHaveValue('Math draft typed immediately before text switch');
  await page.getByLabel('Practice text and task').selectOption(second!.id);
  await expect(page.locator('#writing-answer')).toHaveValue('Science draft before workspace switch');
  expect((service.drafts.get(`${first!.id}@${first!.version}`)?.answer as {parts:Record<string,string>}).parts[first!.parts![0]!.id]).toBe('Math draft typed immediately before text switch');
});

test('failed save blocks navigation and retains latest writing until successful retry',async({page})=>{
  const service=await mockDesk(page);await page.goto('/');await page.getByRole('button',{name:'Writing studio',exact:false}).click();
  await page.locator('#writing-answer').fill('Must survive a failed save');service.controls.failSaves=true;
  await page.getByRole('button',{name:'Standards map',exact:false}).click();
  await expect(page.getByRole('alert').filter({hasText:'still in this editor'})).toBeVisible();
  await expect(page.locator('#writing-answer')).toHaveValue('Must survive a failed save');
  await expect(page.locator('.coverage-list')).toHaveCount(0);
  service.controls.failSaves=false;await page.getByRole('button',{name:'Save all parts now',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('All five parts saved');
  await page.getByRole('button',{name:'Standards map',exact:false}).click();await expect(page.locator('.coverage-list>details')).toHaveCount(13);
});

test('old practice draft stays separate until explicitly copied into the new version',async({page})=>{
  const changed=structuredClone(catalog),task=changed.tasks.find(t=>t.kind==='short')!;task.version=2;task.prompt='Changed prompt for version 2';
  const old={response:'Prior-version answer',hintCount:2,assistance:[],parentAttemptId:'prior-attempt',startedAt:'2026-11-01T00:00:00Z'};
  const service=await mockDesk(page,{catalog:changed,initialDrafts:[{taskId:task.id,taskVersion:1,answer:old}]});
  await page.goto('/');await page.getByRole('button',{name:'Learn & practice',exact:false}).click();await page.locator('.task-list').getByRole('button',{name:task.title,exact:false}).click();
  await expect(page.getByLabel('Your response',{exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'Submit response',exact:true})).toBeDisabled();
  await page.getByText('Saved draft · version 1',{exact:true}).click();await page.getByRole('button',{name:'Copy this draft into version 2',exact:true}).click();
  await expect(page.getByLabel('Your response',{exact:true})).toHaveValue('Prior-version answer');
  await page.getByRole('button',{name:'Save draft now',exact:true}).click();await expect(page.getByRole('status')).toContainText('Draft saved');
  expect(service.drafts.get(`${task.id}@1`)?.answer).toEqual(old);
  expect(service.drafts.get(`${task.id}@2`)?.answer).toMatchObject({response:'Prior-version answer',hintCount:2,assistance:['copied_prior_version']});
});

test('changed writing prompt with unchanged mentor text requires deliberate draft copying',async({page})=>{
  const changed=structuredClone(catalog),task=changed.tasks.find(t=>t.kind==='writing')!;task.version=2;task.prompt='Changed writing prompt, same mentor';
  const mentor=changed.mentorTexts.find(m=>m.id===task.mentorTextId)!;
  const old={mentorTextId:mentor.id,mentorTextVersion:mentor.version,mentorTextHash:mentor.sha256,rubricVersionId:task.rubricVersionId,parts:{[task.parts![0]!.id]:'Earlier writing response'},plannedMinutes:45};
  const service=await mockDesk(page,{catalog:changed,initialDrafts:[{taskId:task.id,taskVersion:1,answer:old}]});
  await page.goto('/');await page.getByRole('button',{name:'Writing studio',exact:false}).click();
  await expect(page.locator('#writing-answer')).toHaveValue('');await expect(page.getByRole('button',{name:'Preserve all five parts',exact:true})).toBeDisabled();
  await page.getByText('Saved writing · version 1',{exact:true}).click();await page.getByRole('button',{name:'Copy this writing into version 2',exact:true}).click();
  await expect(page.locator('#writing-answer')).toHaveValue('Earlier writing response');
  await page.getByRole('button',{name:'Save all parts now',exact:true}).click();await expect(page.getByRole('status')).toContainText('All five parts saved');
  expect(service.drafts.get(`${task.id}@1`)?.answer).toEqual(old);
  expect(service.drafts.get(`${task.id}@2`)?.answer).toMatchObject({mentorTextId:mentor.id,mentorTextHash:mentor.sha256,rubricVersionId:task.rubricVersionId,assistance:['copied_prior_version']});
});

test('editor waits for draft hydration and warns before abandoning unsaved browser work',async({page})=>{
  const service=await mockDesk(page);service.controls.delayLoadMs=350;
  await page.goto('/');await page.getByRole('button',{name:'Writing studio',exact:false}).click();
  await expect(page.locator('#writing-answer')).toBeDisabled();await expect(page.locator('#writing-answer')).toBeEnabled();
  await page.locator('#writing-answer').fill('Pending unload warning');
  expect(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(true);
  await page.getByRole('button',{name:'Save all parts now',exact:true}).click();await expect(page.getByRole('status')).toContainText('All five parts saved');
});


test('navigation waits for submission metadata and blocks when its draft save fails',async({page})=>{
  const service=await mockDesk(page);service.controls.delaySubmitMs=200;service.controls.failAfterSubmit=true;
  await page.goto('/');await page.getByRole('button',{name:'Begin a practice check'}).click();await page.getByRole('radio').first().check();
  await page.getByRole('button',{name:'Submit response',exact:true}).click();await page.getByRole('button',{name:'Standards map',exact:false}).click();
  await expect(page.getByRole('alert').filter({hasText:'still in this editor'})).toBeVisible();
  await expect(page.locator('.practice-card')).toBeVisible();await expect(page.locator('.coverage-list')).toHaveCount(0);
  expect(service.attempts).toHaveLength(1);service.controls.failSaves=false;
  await page.getByRole('button',{name:'Standards map',exact:false}).click();await expect(page.locator('.coverage-list>details')).toHaveCount(13);
  const task=catalog.tasks.find(t=>t.kind==='mc')!;expect(service.drafts.get(`${task.id}@${task.version}`)?.answer).toMatchObject({parentAttemptId:'attempt-0'});
});

test('session recommendations have separate tracks and support keyboard launch without evidence writes',async({page})=>{
  const service=await mockDesk(page);await page.goto('/');
  const plan=page.getByRole('region',{name:'A short next session'});
  await expect(plan).toBeVisible();
  for(const track of ['RETRIEVAL','APPLICATION_TRANSFER','WRITING'])await expect(plan.locator(`[data-track="${track}"]`)).toHaveCount(1);
  await expect(plan.getByText('Retrieval',{exact:true})).toBeVisible();
  await expect(plan.getByText('Application / transfer',{exact:true})).toBeVisible();
  await expect(plan.getByText('Writing',{exact:true})).toBeVisible();
  const launch=plan.getByRole('button',{name:'Open recommended retrieval task',exact:true});
  await launch.focus();await page.keyboard.press('Enter');
  await expect(page.locator('.practice-card')).toBeVisible();
  expect(service.attempts).toEqual([]);expect(service.writes).toEqual([]);expect(service.external).toEqual([]);
});

test('session override opens the chosen existing writing task without fabricated attempts',async({page})=>{
  const service=await mockDesk(page),task=catalog.tasks.filter(t=>t.kind==='writing')[1]!;
  await page.goto('/');
  await page.getByLabel('Choose any existing task',{exact:true}).selectOption(task.id);
  const open=page.getByRole('button',{name:'Open chosen task',exact:true});await open.focus();await page.keyboard.press('Enter');
  await expect(page.getByLabel('Practice text and task',{exact:true})).toHaveValue(task.id);
  await expect(page.locator('#writing-answer')).toBeEnabled();
  expect(service.attempts).toEqual([]);expect(service.drafts.size).toBe(0);expect(service.writes).toEqual([]);expect(service.external).toEqual([]);
});

test('returning to the desk refreshes held assisted drafts before recommending independent work',async({page})=>{
  const changed=structuredClone(catalog),task=changed.tasks.find(t=>t.kind==='mc')!;
  changed.tasks=[task];
  const service=await mockDesk(page,{catalog:changed});await page.goto('/');
  await page.getByRole('button',{name:'Begin a practice check'}).click();
  await page.getByRole('radio').first().check();
  await page.getByRole('button',{name:'Use a hint',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await page.getByRole('button',{name:'Study desk',exact:false}).click();
  const retrieval=page.getByRole('region',{name:'A short next session'}).locator('[data-track="RETRIEVAL"]');
  await expect(retrieval).toContainText(/draft|assisted/i);
  expect(service.attempts).toEqual([]);
  expect(service.drafts.get(`${task.id}@${task.version}`)?.answer).toMatchObject({hintCount:1});
});

test('standards show every objective gap and distinguish the integration referral denominator',async({page})=>{
  const service=await mockDesk(page);await page.goto('/');
  const gaps=page.getByRole('button',{name:'See statement gaps',exact:true});await gaps.focus();await page.keyboard.press('Enter');
  const objectives=page.locator('.coverage-list>details');await expect(objectives).toHaveCount(13);
  for(const objective of await objectives.all())await expect(objective.locator('summary').first()).toContainText(/gap/i);
  await expect(page.getByRole('main')).toContainText('59 official descriptive bullets');
  await expect(page.getByRole('main')).toContainText('1 integration referral');
  const integration=objectives.filter({hasText:'0013'});await integration.locator('summary').first().click();
  await expect(integration).toContainText('mtel56.obj.0013.reference.0001-0012');
  expect(service.attempts).toEqual([]);expect(service.external).toEqual([]);
});

test('Objective 0001 lesson opens its own checks without treating guided practice as evidence',async({page})=>{
  const service=await mockDesk(page);
  const lessonId='lesson.obj0001.identification-shared.v1';
  const moduleTasks=catalog.tasks.filter(t=>t.lessonId===lessonId);
  expect(moduleTasks).toHaveLength(8);
  await page.goto('/');
  await page.getByRole('button',{name:'Learn & practice',exact:false}).click();
  await page.getByLabel('Short lesson',{exact:true}).selectOption(lessonId);
  const lesson=page.locator('.lesson');
  await expect(lesson).toContainText(/guided/i);
  await expect(lesson).toContainText('create no attempts or independent evidence');
  const checks=page.getByRole('navigation',{name:'Checks for this lesson',exact:true});
  await expect(checks.getByRole('button')).toHaveCount(8);
  await expect(page.getByRole('button',{name:'Save draft now',exact:true})).toBeEnabled();
  await lesson.getByRole('button',{name:'Try a related check',exact:true}).click();
  await expect(page.locator('.practice-card h2')).toHaveText(moduleTasks[0]!.title);
  await expect(page.getByRole('button',{name:'Save draft now',exact:true})).toBeEnabled();
  const transfer=moduleTasks.find(t=>t.kind==='case')!;
  await checks.getByRole('button',{name:transfer.title,exact:true}).click();
  await expect(page.locator('.practice-card h2')).toHaveText(transfer.title);
  await expect(page.getByLabel('Your response',{exact:true})).toBeEnabled();
  await expect(page.getByLabel('Your response',{exact:true})).toHaveValue('');
  expect(service.attempts).toEqual([]);
  expect(service.writes).toEqual([]);
  expect(service.external).toEqual([]);
});

for (const lessonId of [
  'lesson.obj0002.diversity.v1',
  'lesson.obj0003.culture-partnerships.v1',
  'lesson.obj0004.forms-transfer.v1',
  'lesson.obj0005.profiles-environments.v1',
  'lesson.obj0006.vocabulary-talk.v1',
  'lesson.obj0007.sheltered-planning.v1',
  'lesson.obj0008.academic-discourse.v1',
  'lesson.obj0009.assessment-decisions.v1',
]) {
  test(`${lessonId} opens assisted instruction, a linked check and its manual case without evidence writes`, async ({page}) => {
    const service = await mockDesk(page);
    const lessonTasks = catalog.tasks.filter(t => t.lessonId === lessonId);
    const check = lessonTasks.find(t => t.kind === 'mc')!;
    const application = lessonTasks.find(t => t.kind === 'case')!;
    expect(check).toBeDefined();
    expect(application.answerKey).toBeUndefined();
    await page.goto('/');
    await page.getByRole('button', {name: 'Learn & practice', exact: false}).click();
    await page.getByLabel('Short lesson', {exact: true}).selectOption(lessonId);
    const lesson = page.locator('.lesson');
    await expect(lesson).toContainText(/content goal/i);
    await expect(lesson).toContainText(/language goal/i);
    await expect(lesson).toContainText(/assisted/i);
    await expect(lesson).toContainText('no attempts or independent evidence');
    const links = page.getByRole('navigation', {name: 'Checks for this lesson', exact: true});
    await expect(links.getByRole('button')).toHaveCount(lessonTasks.length);
    await links.getByRole('button', {name: check.title, exact: true}).click();
    await expect(page.locator('.practice-card h2')).toHaveText(check.title);
    await expect(page.getByRole('radio')).toHaveCount(4);
    await expect(page.getByRole('button', {name: 'Save draft now', exact: true})).toBeEnabled();
    await links.getByRole('button', {name: application.title, exact: true}).click();
    await expect(page.locator('.practice-card h2')).toHaveText(application.title);
    await expect(page.locator('.practice-card')).toContainText(/pending|provisional/i);
    await expect(page.getByLabel('Your response', {exact: true})).toHaveValue('');
    await expect(page.getByLabel('Your response', {exact: true})).toBeEnabled();
    expect(service.attempts).toEqual([]);
    expect(service.drafts.size).toBe(0);
    expect(service.writes).toEqual([]);
    expect(service.external).toEqual([]);
  });
}

for (const timezoneId of ['America/New_York', 'Asia/Tokyo']) {
  test.describe(`source retrieval calendar dates in ${timezoneId}`, () => {
    test.use({timezoneId, locale: 'en-US'});

    test('source library displays the supplied retrieval date without an invented time', async ({page}) => {
      const service = await mockDesk(page);
      const sources = catalog.sources.filter(source => source.id.startsWith('source.obj0001.'));
      expect(sources).toHaveLength(9);
      await page.goto('/');
      await page.getByRole('button', {name: 'Source library', exact: false}).click();
      await expect(page.getByRole('heading', {name: 'Know what supports the content.', exact: true})).toBeVisible();
      for (const source of sources) {
        expect(source.retrievedAt).toBe('2026-11-08');
        const card = page.locator('article.source').filter({has: page.getByRole('heading', {name: source.title, exact: true})});
        const provenance = card.locator('p.small').first();
        await expect(provenance).toBeVisible();
        await expect(provenance).toHaveText(/^Retrieved: 2026-11-08\s*Effective date:/);
      }
      expect(service.attempts).toEqual([]);
      expect(service.writes).toEqual([]);
      expect(service.external).toEqual([]);
    });
  });
}
