import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// Same controlled-boundary approach as Lumiverse's e2e-diagnostics harness.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const bundle = await readFile(new URL('../dist/frontend.js', import.meta.url))
const fixture = `<!doctype html><html><style>
*{box-sizing:border-box}html,body{height:100%;margin:0;font-family:Arial;background:#17171e;color:#eee}
:root{--lumiverse-bg:#17171e;--lumiverse-text:#eee;--lumiverse-border:#444;--lumiverse-text-muted:#aaa}
</style><body><div id="toolbar"></div><script type="module">
import { setup } from '/frontend.js';
const block=(id,content)=>({id,name:id,content,role:'system',enabled:true,position:'pre_history',depth:0,marker:null,isLocked:false,color:null,injectionTrigger:[],group:null});
let preset={id:'fixture',name:'Review fixture',blocks:[block('one','{{var::missing_one}}'),block('two','{{var::missing_two}}'),block('other','untouched')],parameters:{},prompts:{},metadata:{},createdAt:0,updatedAt:0};
const listeners=new Set();window.writes=0;window.flushes=0;window.mounts=0;window.destroys=0;
window.snapshot=()=>structuredClone(preset);
window.external=(id)=>{preset.blocks=preset.blocks.map(b=>b.id===id?{...b,content:'external change'}:b);for(const fn of listeners)fn(state());};
const state=()=>({open:true,presetId:'fixture',preset:structuredClone(preset)});
setup({dom:{addStyle(css){let s=document.createElement('style');s.textContent=css;document.head.append(s);return()=>s.remove();}},getActiveChat:()=>({chatId:null}),onBackendMessage:()=>()=>{},sendToBackend(){},
ui:{mount:()=>document.querySelector('#toolbar'),presetEditor:{getState:state,extension:{getState:()=>({presetId:'fixture',blocks:structuredClone(preset.blocks),promptVariableValues:{}})},onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);},updatePreset(fn){const next=fn(preset);if(next!==preset)window.writes++;preset=next;for(const cb of listeners)cb(state());},flush:async()=>{window.flushes++;}},showConfirm:async()=>({confirmed:true}),showModal(){let back=document.createElement('div');back.style.cssText='position:fixed;inset:0;display:flex';let c=document.createElement('div'),h=document.createElement('header'),b=document.createElement('div'),root=document.createElement('div');b.append(root);c.append(h,b);back.append(c);document.body.append(back);const callbacks=new Set();return{root,dismiss(){back.remove();for(const fn of callbacks)fn();},onDismiss(fn){callbacks.add(fn);return()=>callbacks.delete(fn);}};}},
components:{mountLoomBlockEditor(target,initial){window.mounts++;let opts=initial;const render=()=>{target.replaceChildren();let block=opts.value.blocks.find(b=>b.id===opts.selectedBlockId);if(!block||opts.readOnly)return;let box=document.createElement('div'),text=document.createElement('textarea'),save=document.createElement('button'),cancel=document.createElement('button');box.style.cssText='padding:16px;overflow:auto';text.setAttribute('aria-label','Native content');text.style.cssText='width:100%;height:260px';text.value=block.content;save.textContent='Save';cancel.textContent='Cancel';let draft=()=>({...opts.value,blocks:opts.value.blocks.map(b=>b.id===block.id?{...b,content:text.value}:b)});text.addEventListener('input',()=>opts.onDraftChange?.(draft()));save.onclick=()=>{const next=draft();opts.onChange?.(next);opts.value=next;opts.onDraftChange?.(null);opts.onSelectedBlockChange?.(null);};cancel.onclick=()=>{opts.onDraftChange?.(null);render();};box.append(text,save,cancel);target.append(box);};render();return{update(next){opts={...opts,...next};render();},destroy(){window.destroys++;target.replaceChildren();},getValue:()=>opts.value};}}
});
</script></body></html>`
const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/frontend.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/frontend.js' ? bundle : fixture) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: 'Open Workshop', exact: true }).click()
    if (width < 900) await page.getByRole('button', { name: 'Open variables', exact: true }).click()
    await page.locator('[data-variable-pane="all"]').getByRole('button', { name: 'Show sections', exact: true }).click()
    await page.getByRole('button', { name: 'Review issues', exact: true }).click()
    const review = page.locator('.workshop-review')
    assert.equal(await review.locator('[data-review="position"]').textContent(), '1 / 2')
    await review.getByLabel('Native content').fill('fixed one')
    await review.getByRole('button', { name: 'Next', exact: true }).click()
    assert.equal(await review.getByLabel('Native content').inputValue(), '{{var::missing_two}}')
    await review.getByRole('button', { name: 'Previous', exact: true }).click()
    assert.equal(await review.getByLabel('Native content').inputValue(), 'fixed one')
    await review.getByRole('button', { name: 'Next', exact: true }).click()
    await review.getByLabel('Native content').fill('fixed two')
    await review.getByRole('button', { name: 'Save', exact: true }).click()
    assert.equal(await review.locator('[data-review="state"]').textContent(), 'Resolved locally')
    assert.equal(await page.evaluate(() => window.writes), 0)
    assert.equal(await page.evaluate(() => window.snapshot().blocks[0].content), '{{var::missing_one}}')
    await review.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: /Review issues/ }).click()
    assert.equal(await review.locator('[data-review="title"]').textContent(), 'No remaining issues')
    await page.evaluate(() => window.external('other'))
    await review.getByRole('button', { name: 'Apply', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.snapshot().blocks.map(b => b.content)), ['fixed one', 'fixed two', 'external change'])
    assert.equal(await page.evaluate(() => window.writes), 1)
    assert.equal(await page.evaluate(() => window.flushes), 1)
    await review.getByRole('button', { name: 'Close', exact: true }).click()
    // Refresh the controlled fixture and verify conflict refusal and discard.
    await page.reload()
    await page.getByRole('button', { name: 'Open Workshop', exact: true }).click()
    if (width < 900) await page.getByRole('button', { name: 'Open variables', exact: true }).click()
    await page.locator('[data-variable-pane="all"]').getByRole('button', { name: 'Show sections', exact: true }).click()
    await page.getByRole('button', { name: 'Review issues', exact: true }).click()
    await review.getByLabel('Native content').fill('local conflict')
    await page.evaluate(() => window.external('one'))
    await review.getByRole('button', { name: 'Apply', exact: true }).click()
    assert.match(await review.locator('[data-review="notice"]').textContent(), /changed or disappeared/)
    assert.equal(await page.evaluate(() => window.writes), 0)
    assert.equal(await page.evaluate(() => window.snapshot().blocks[0].content), 'external change')
    await review.getByRole('button', { name: 'Discard fixes', exact: true }).click()
    assert.equal(await review.getByLabel('Native content').inputValue(), '{{var::missing_two}}')
    await review.getByLabel('Native content').fill('temporary')
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await review.getByLabel('Native content').inputValue(), '{{var::missing_two}}')
    await review.getByRole('button', { name: 'Next', exact: true }).isDisabled()
    const applyBox = await review.getByRole('button', { name: 'Apply', exact: true }).boundingBox()
    assert.ok(applyBox.x >= 0 && applyBox.x + applyBox.width <= width && applyBox.y + applyBox.height <= 900)
    if (process.env.SANDBOX_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SANDBOX_SCREENSHOT_DIR, `issue-review-${width}.png`) })
    await review.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal(await page.evaluate(() => window.mounts - window.destroys), 2)
    assert.deepEqual(errors, [])
    console.log(`PASS issue review navigation, local Save, reopen, batch Apply, conflicts, cancel, cleanup and layout: ${width}px`)
    await page.close()
  }
} finally { await browser.close(); server.close() }
