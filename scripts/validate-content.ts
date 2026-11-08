import {readFileSync} from 'node:fs';
import {validateCatalog} from '../packages/shared/src/index.js';
const catalog=JSON.parse(readFileSync('content/catalog.json','utf8').replace(/^\uFEFF/,''));
const errors=validateCatalog(catalog);if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log('Catalog valid',Object.fromEntries(Object.entries(catalog).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,(v as unknown[]).length])));
