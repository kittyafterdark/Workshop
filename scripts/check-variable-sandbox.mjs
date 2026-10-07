import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// Use the Playwright installation from Lumiverse's e2e-diagnostics harness.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const bundle = await readFile(new URL('../dist/frontend.js', import.meta.url))
const fixture = `<!doctype html><html><head><style>
* { box-sizing:border-box; }
html, body { width:100%; height:100%; overflow:hidden; margin:0; font-family:Arial,sans-serif; }
:root { --lumiverse-text:#eee; --lumiverse-text-muted:#aaa; --lumiverse-text-dim:#888; --lumiverse-border:#333; --lumiverse-primary:#aa88ef; --lumiverse-bg:#15151b; --lumiverse-bg-dark:rgba(0,0,0,.15); }
</style></head><body style="background:#15151b;color:#eee">
<div id="toolbar"></div><script type="module">
import { setup } from '/frontend.js';
const variables = [
 {id:'text',name:'text',label:'Text',type:'text',defaultValue:'original'},
 {id:'area',name:'area',label:'Long text',type:'textarea',defaultValue:'long original'},
 {id:'number',name:'amount',label:'Amount',type:'number',defaultValue:2,min:0,max:10},
 {id:'slider',name:'level',label:'Level',type:'slider',defaultValue:3,min:0,max:10},
 {id:'switch',name:'on',label:'Enabled',type:'switch',defaultValue:0},
 {id:'select',name:'pov',label:'Perspective',type:'select',defaultValue:'third',options:[{id:'first',label:'First',value:'first person'},{id:'third',label:'Third',value:'third person'}]},
 {id:'multi',name:'traits',label:'Traits',type:'multiselect',defaultValue:['a'],options:[{id:'a',label:'A',value:'alpha'},{id:'b',label:'B',value:'beta'}]},
];
const block = {id:'controls',name:'Controls',variables,content:'{{var::text}}',role:'system',enabled:true,position:'pre_history',depth:0,marker:null,isLocked:false,color:null,injectionTrigger:[],group:null};
let preset={id:'fixture',name:'Fixture',blocks:[block],parameters:{},prompts:{},metadata:{},createdAt:0,updatedAt:0};
const values={controls:{text:'host value'}};
const listeners=new Set(); const backend=new Set();
window.requests=[]; window.writes=0; window.nativeValues=[];
const state=()=>({open:true,presetId:'fixture',preset:structuredClone(preset)});
window.refreshHost=()=>{values.controls.text='fresh host';for(const fn of listeners) fn(state());};
window.changeDefinition=()=>{preset.blocks[0].variables[0].label='Changed text';for(const fn of listeners) fn(state());};
setup({
 dom:{addStyle(css){const s=document.createElement('style');s.textContent=css;document.head.append(s);return()=>s.remove();}},
 getActiveChat:()=>({chatId:'mock-chat'}),
 onBackendMessage(fn){backend.add(fn);return()=>backend.delete(fn);},
 sendToBackend(message){if(message.type!=='workshop:assemble')return;window.requests.push(structuredClone(message));queueMicrotask(()=>{for(const fn of backend)fn({type:'workshop:assembly-result',requestId:message.requestId,result:{messages:[{role:'system',content:JSON.stringify(message.promptVariables)}],breakdown:[]}});});},
 ui:{mount:()=>document.querySelector('#toolbar'),presetEditor:{getState:state,
   extension:{getState:()=>({presetId:'fixture',blocks:structuredClone(preset.blocks),promptVariableValues:structuredClone(values)})},
   onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);},
   updatePreset(fn){window.writes++;preset=fn(preset);for(const listener of listeners)listener(state());},flush:async()=>{}},
   showConfirm:async()=>({confirmed:true}),showModal(){
     const backdrop=document.createElement('div');backdrop.style.cssText='position:fixed;inset:0;display:flex';
     const container=document.createElement('div');const header=document.createElement('header');const body=document.createElement('div');const root=document.createElement('div');
     body.append(root);container.append(header,body);backdrop.append(container);document.body.append(backdrop);
     const dismissers=new Set();return{root,dismiss(){backdrop.remove();for(const fn of dismissers)fn();},onDismiss(fn){dismissers.add(fn);return()=>dismissers.delete(fn);}};
   }},
 components:{mountLoomBlockEditor(target,options){window.nativeValues.push(structuredClone(options.value));return{update(next){if(next.value)window.nativeValues.push(structuredClone(next.value));},destroy(){},getValue:()=>options.value};}}
});
</script></body></html>`
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/frontend.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/frontend.js' ? bundle : fixture)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: 'Open Workshop' }).click()
    if (width < 900) {
      await page.getByRole('button', { name: 'Open prompts', exact: true }).click()
      for (const side of ['left', 'right']) {
        const background = await page.locator(`.workshop-rail.${side}`).evaluate((element) => {
          const style = getComputedStyle(element)
          return { color: style.backgroundColor, image: style.backgroundImage }
        })
        assert.equal(background.color, 'rgb(21, 21, 27)')
        assert.ok(background.image.startsWith('linear-gradient('))
      }
      if (process.env.SANDBOX_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SANDBOX_SCREENSHOT_DIR, `prompts-${width}.png`) })
      await page.getByRole('button', { name: 'Open prompts', exact: true }).click()
    }
    if (width < 900) await page.getByRole('button', { name: 'Open variables', exact: true }).click()
    const choose = async (name) => {
      await page.locator('.workshop-variable-card').filter({ has: page.locator('.workshop-variable-label', { hasText: new RegExp(`^${name}( · Mock)?$`) }) }).click()
    }
    const waitValue = async (name, value) => {
      await page.waitForFunction(({ name, value }) => JSON.stringify(window.requests.at(-1)?.promptVariables.controls?.[name]) === JSON.stringify(value), { name, value })
    }
    await choose('Text')
    await page.getByLabel('Mock Text', { exact: true }).fill('mock text')
    await page.getByLabel('Mock Text', { exact: true }).press('Tab')
    await waitValue('text', 'mock text')
    const bounds = await page.getByLabel('Mock Text', { exact: true }).boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width)
    if (process.env.SANDBOX_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SANDBOX_SCREENSHOT_DIR, `sandbox-${width}.png`) })
    await choose('Perspective')
    await page.getByLabel('Mock Perspective').selectOption('first')
    await waitValue('pov', 'first')
    await page.getByLabel('Mock Perspective').focus()
    await page.getByLabel('Mock Perspective').press('ArrowDown')
    await waitValue('pov', 'third')
    assert.equal(await page.getByLabel('Mock Perspective').evaluate((element) => element === document.activeElement), true)
    await choose('Traits')
    await page.getByLabel('Mock Traits').selectOption(['a', 'b'])
    await waitValue('traits', ['a', 'b'])
    await page.getByLabel('Mock Traits').selectOption([])
    await waitValue('traits', [])
    await choose('Enabled')
    await page.getByLabel('Mock Enabled').check()
    await waitValue('on', 1)
    await choose('Amount')
    await page.getByLabel('Mock Amount').fill('0')
    await page.getByLabel('Mock Amount').press('Tab')
    await waitValue('amount', 0)
    await choose('Level')
    await page.getByLabel('Mock Level').focus()
    await page.getByLabel('Mock Level').press('ArrowRight')
    await waitValue('level', 4)
    await choose('Long text')
    await page.getByLabel('Mock Long text').fill('line one\nline two')
    await page.getByLabel('Mock Long text').press('Tab')
    await waitValue('area', 'line one\nline two')
    await page.evaluate(() => window.refreshHost())
    await waitValue('text', 'mock text')
    await choose('Text')
    await page.getByRole('button', { name: 'Reset mock', exact: true }).click()
    await waitValue('text', 'fresh host')
    await page.getByRole('button', { name: /Reset mocks/ }).click()
    await page.waitForFunction(() => JSON.stringify(window.requests.at(-1).promptVariables) === JSON.stringify({ controls: { text: 'fresh host' } }))
    if (width >= 900) {
      await page.getByRole('button', { name: 'Collapse variables', exact: true }).click()
      assert.equal(await page.getByRole('button', { name: /Reset mocks/ }).isVisible(), false)
      await page.getByRole('button', { name: 'Expand variables', exact: true }).click()
    }
    await page.getByLabel('Mock Text', { exact: true }).fill('another mock')
    await page.getByLabel('Mock Text', { exact: true }).press('Tab')
    await waitValue('text', 'another mock')
    await page.evaluate(() => window.changeDefinition())
    await waitValue('text', 'fresh host')
    assert.equal(await page.getByRole('button', { name: /Reset mocks/ }).isDisabled(), true)
    await page.getByLabel('Mock Changed text').fill('close mock')
    await page.getByLabel('Mock Changed text').press('Tab')
    await waitValue('text', 'close mock')
    if (width < 900) await page.locator('[data-action="mobile-right"]').click()
    await page.getByRole('button', { name: 'Close Workshop', exact: true }).click()
    await page.getByRole('button', { name: 'Open Workshop' }).click()
    await waitValue('text', 'fresh host')
    assert.equal(await page.evaluate(() => window.writes), 0)
    assert.equal(await page.evaluate(() => window.nativeValues.some((value) => JSON.stringify(value).includes('mock text'))), false)
    assert.deepEqual(errors, [])
    console.log(`PASS sandbox controls, keyboard, reset, refresh, definition change, close/reopen and write isolation: ${width}px`)
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
}
