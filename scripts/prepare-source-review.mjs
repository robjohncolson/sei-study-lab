import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd();
const manifestPath='docs/publication-manifest.json';
const candidatePaths=[...new Set([...execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean),manifestPath])].sort();
const excluded=/(^|\/)(?:\.git|\.vercel|runtime|node_modules|dist|secrets|credentials|exports|imports|answers|private-fixtures|responses|backups|test-results|playwright-report)(\/|$)|(^|\/)\.env(?!\.example$)|\.(?:sqlite(?:3)?(?:-.*)?|db(?:-.*)?|pem|key|pfx|p12|jks|keystore|bak|backup|log)$/i;
const credentialPatterns=[
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
 ['AWS access key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
 ['Slack token',/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
 ['API secret key',/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}\b/],
];
const findings=[];
const files=candidatePaths.map(path=>{
 const absolute=resolve(root,path),within=relative(root,absolute);
 if(isAbsolute(within)||within==='..'||within.startsWith('..\\')||excluded.test(path))throw new Error(`Excluded or outside-root path in candidate list: ${path}`);
 if(path===manifestPath)return {path,bytes:null,sha256:null,note:'Self-hash/size omitted to avoid circular metadata'};
 if(!lstatSync(absolute).isFile()||lstatSync(absolute).isSymbolicLink())throw new Error(`Not a regular source file: ${path}`);
 const bytes=readFileSync(absolute),text=bytes.toString('utf8');
 for(const [kind,pattern] of credentialPatterns)if(pattern.test(text))findings.push({path,kind});
 return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
});
const ignoreProbes=['runtime/study.sqlite','runtime/study.sqlite-wal','runtime/backups/example.sqlite','runtime/exports/answer.json','runtime/review/source-review.zip','.env','.env.local','.vercel/project.json','secrets/example.json','credentials/example.json','imports/private.json','exports/private.json','answers/private.json','certificate.pfx','certificate.p12','sei-study-lab-export.json','sei-review-packet.json','sei-review-packet.md','apps/server/private-fixtures/example.json'];
for(const path of ignoreProbes){try{execFileSync('git',['check-ignore','-q','--no-index','--',path]);}catch{throw new Error(`Private path is not ignored: ${path}`);}}
const staged=execFileSync('git',['diff','--cached','--name-only'],{encoding:'utf8'}).trim();
const remotes=execFileSync('git',['remote'],{encoding:'utf8'}).trim();
if(findings.length){console.error(JSON.stringify({credentialPatternFindings:findings}));process.exitCode=1;}else{
 const manifest={schemaVersion:1,preparedAt:new Date().toISOString(),purpose:'Proposed source-code review publication; nothing uploaded',fileCount:files.length,totalBytesExcludingManifest:files.reduce((n,f)=>n+(f.bytes??0),0),files,privacyChecks:{gitIgnoredPathProbes:ignoreProbes,allProbesIgnored:true,credentialPatternScan:{findingCount:0,scope:'Candidate regular source files only; no runtime/private file contents read',limitation:'Heuristic signatures, not a guarantee that every secret or personal detail is absent'},excludedDirectories:['.git/','.vercel/','runtime/','node_modules/','dist/','test-results/','playwright-report/','secrets/','credentials/','imports/','exports/','answers/'],intentionalPublicContext:['MTEL/SEI educational context','January 16, 2027 planning target','official source text and provenance','synthetic demonstration answers','tested development tool versions']},repositoryState:{stagedFiles:staged?staged.split('\n'):[],remoteNames:remotes?remotes.split('\n'):[],pushedByThisPreparation:false,deployedByThisPreparation:false}};
 writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({fileCount:files.length,totalBytesExcludingManifest:manifest.totalBytesExcludingManifest,ignoredProbes:ignoreProbes.length,credentialPatternFindings:0,stagedFiles:manifest.repositoryState.stagedFiles,remoteNames:manifest.repositoryState.remoteNames},null,2));
}
