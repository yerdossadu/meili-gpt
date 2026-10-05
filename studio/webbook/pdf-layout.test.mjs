import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createPdfLayout, validateRange } from './pdf-layout.mjs';

test('reject invalid page ranges', () => {
  assert.deepEqual(validateRange(1, 3, 3), { from: 1, to: 3 });
  for (const range of [[0,1],[2,1],[1,4],[1.5,2],[NaN,2],['1',2]]) assert.throws(() => validateRange(...range,3));
});

test('native conversion preserves text, isolates output and survives restart', async () => {
  const studio = resolve('studio'), root = resolve('.local/pdf-layout-integration'), book = 'abcdef012345';
  process.env.PDF2HTMLEX_PATH = join(studio,'.tools/pdf2htmlEX/pdf2htmlEX.exe');
  await mkdir(join(root,'library',book),{recursive:true}); await mkdir(join(root,'webbook'),{recursive:true});
  for (const file of ['pdf-layout-viewer.js','pdf-layout-viewer.css']) await copyFile(join(studio,'webbook',file),join(root,'webbook',file));
  await copyFile(join(studio,'.tools/pdf2htmlEX/test/browser_tests/basic_text.pdf'),join(root,'library',book,'source.pdf'));
  await writeFile(join(root,'library',book,'book.json'),JSON.stringify({pages:1}));
  await writeFile(join(root,'library',book,'existing.html'),'preserve me');
  const scan = join(root,'reference.png');
  await writeFile(scan,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1EAAAAASUVORK5CYII=','base64'));
  let service = createPdfLayout({root,renderScan:async()=>scan});
  const server = createServer((req,res)=>service.handle(req,res,new URL(req.url,'http://localhost')));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const api = `http://127.0.0.1:${server.address().port}/local/pdf-layout/`;
  try {
    assert.equal((await fetch(api+book,{method:'POST',body:JSON.stringify({from:2,to:1})})).status,400);
    const input = await readFile(join(root,'library',book,'source.pdf'));
    const response = await fetch(api+book,{method:'POST',body:JSON.stringify({from:1,to:1})}); assert.equal(response.status,202);
    let job = await response.json();
    for (let i=0;i<120 && ['queued','running'].includes(job.state);i++) {
      await new Promise(r=>setTimeout(r,250)); job = await (await fetch(api+book+'/'+job.id)).json();
    }
    assert.equal(job.state,'done',job.error);
    const dir = join(root,'library',book,'pdf-layout',job.id), html = await readFile(join(dir,'web/index.html'),'utf8');
    for (const word of ['Normal','CharSpace','Rotated']) assert.ok(html.includes(word),word);
    assert.ok((await readdir(join(dir,'web'))).some(f=>f.endsWith('.woff')),'embedded font files');
    assert.equal((await readFile(join(dir,'web-version.zip'))).readUInt32LE(0),0x04034b50);
    assert.equal(await readFile(join(root,'library',book,'existing.html'),'utf8'),'preserve me');
    assert.equal(createHash('sha256').update(await readFile(join(root,'library',book,'source.pdf'))).digest('hex'),createHash('sha256').update(input).digest('hex'));
    service = createPdfLayout({root,renderScan:async()=>scan});
    assert.ok((await (await fetch(api+book)).json()).some(j=>j.id===job.id && j.state==='done'));
    const pending = {...job,id:'00000000-0000-0000-0000-000000000001',state:'running'};
    await mkdir(join(root,'library',book,'pdf-layout',pending.id),{recursive:true}); await writeFile(join(root,'library',book,'pdf-layout',pending.id,'job.json'),JSON.stringify(pending));
    assert.equal((await (await fetch(api+book)).json()).find(j=>j.id===pending.id).state,'error');
    console.log('Verified native job:',job.id);
  } finally { await new Promise(r=>server.close(r)); }
});
