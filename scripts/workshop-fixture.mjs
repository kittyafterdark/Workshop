export const fixture = `<!doctype html><html><style>
*{box-sizing:border-box}html,body{height:100%;margin:0;font-family:Arial;background:#17171e;color:#eee}
:root{--lumiverse-bg:#17171e;--lumiverse-text:#eee;--lumiverse-border:#444;--lumiverse-text-muted:#aaa}
/* Controlled notched-phone representation; production uses the host's canonical variables. */
@media(max-width:900px){:root{--app-interactive-safe-top:54px;--app-interactive-viewport-height:calc(100dvh - var(--app-interactive-safe-top))}}
</style><body><div id="toolbar"></div><script type="module">
import { setup } from '/frontend.js';
const block=(id,content)=>({id,name:id,content,role:'system',enabled:true,position:'pre_history',depth:0,marker:null,isLocked:false,color:null,injectionTrigger:[],group:null});
let preset={id:'fixture',name:'Review fixture',blocks:[block('one','{{var::missing_one}}'),block('two','{{var::missing_two}}'),block('other','untouched')],parameters:{},prompts:{},metadata:{},createdAt:0,updatedAt:0};
const responses=new Set();
window.spindle={
 connections:{async list(){return [{id:'connection',name:'Fixture connection',model:'Fixture model'}]}},
 mcp:{servers:{async list(){return {data:[{id:'tools',name:'PresetTools fixture',is_enabled:true}],total:1}},async connect(){return {connected:true}}},tools:{async list(){return [{name:'preset_modify_block'}]},async call(){window.remoteToolCalls=(window.remoteToolCalls||0)+1;throw Error('Remote files must not be called')}}},
 generate:{async raw(input){window.agentRequests=(window.agentRequests||0)+1;if(window.generationDelay)await new Promise(resolve=>{window.releaseGeneration=resolve});if(Array.isArray(input.messages.at(-1).content))return {content:'Drafted the requested prompt change.'};return {content:'',tool_calls:[{name:'preset_show_block',args:{name:'one'},call_id:'read'},{name:'preset_modify_block',args:{name:'one',content:'agent fixed'},call_id:'edit'}]}}},
 ephemeral:{
 async read(path){const entry=JSON.parse(localStorage.getItem('backup:'+path)||'null');if(!entry||entry.expiresAt<=Date.now())throw Error('Missing');return entry.text},
 async write(path,text,options){if(window.backupDelay)await new Promise(resolve=>{window.releaseBackup=resolve});if(window.backupFailure)throw Error('Full');localStorage.setItem('backup:'+path,JSON.stringify({text,expiresAt:Date.now()+options.ttlMs}))},
 async list(prefix=''){return Object.keys(localStorage).filter(key=>key.startsWith('backup:'+prefix)).map(key=>key.slice(('backup:'+prefix).length).replaceAll('/',String.fromCharCode(92)))},
 async clearExpired(){let count=0;for(const key of Object.keys(localStorage))if(key.startsWith('backup:')&&JSON.parse(localStorage.getItem(key)).expiresAt<=Date.now()){localStorage.removeItem(key);count++}return count}
},onFrontendMessage(fn){window.backendHandler=fn},sendToFrontend(data){for(const fn of responses)fn(data)},log:{info(){}}};
await import('/backend.js');
const listeners=new Set();window.writes=0;window.flushes=0;window.mounts=0;window.destroys=0;
window.snapshot=()=>structuredClone(preset);
window.external=(id)=>{preset.blocks=preset.blocks.map(b=>b.id===id?{...b,content:'external change'}:b);for(const fn of listeners)fn(state());};
const state=()=>({open:true,presetId:'fixture',preset:structuredClone(preset)});
window.changeShape=()=>{preset.blocks=preset.blocks.filter(block=>block.id!=='two');preset.blocks.push(block('extra','new outside block'));preset.parameters={temperature:2};for(const fn of listeners)fn(state());};
window.mountWorkshop=()=>setup({dom:{addStyle(css){let s=document.createElement('style');s.textContent=css;document.head.append(s);return()=>s.remove();}},getActiveChat:()=>({chatId:null}),onBackendMessage(fn){responses.add(fn);return()=>responses.delete(fn)},sendToBackend(data){window.backendHandler(data,'fixture-user')},
ui:{mount:()=>document.querySelector('#toolbar'),presetEditor:{getState:state,extension:{getState:()=>({presetId:'fixture',blocks:structuredClone(preset.blocks),promptVariableValues:{}})},onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);},updatePreset(fn){const next=fn(preset);if(next!==preset)window.writes++;preset=next;for(const cb of listeners)cb(state());},flush:async()=>{window.flushes++;}},showConfirm:async()=>({confirmed:true}),showModal(options){let back=document.createElement('div');back.style.cssText='position:fixed;inset:0;display:flex';let c=document.createElement('div'),h=document.createElement('header'),b=document.createElement('div'),root=document.createElement('div');c.setAttribute('role','dialog');c.setAttribute('aria-modal','true');c.setAttribute('aria-label',options.title);b.append(root);c.append(h,b);back.append(c);document.body.append(back);const callbacks=new Set();return{root,dismiss(){back.remove();for(const fn of callbacks)fn();},onDismiss(fn){callbacks.add(fn);return()=>callbacks.delete(fn);}};}},
components:{mountLoomBlockEditor(target,initial){window.mounts++;let opts=initial;const render=()=>{target.replaceChildren();let block=opts.value.blocks.find(b=>b.id===opts.selectedBlockId);if(!block||opts.readOnly)return;let box=document.createElement('div'),text=document.createElement('textarea'),save=document.createElement('button'),cancel=document.createElement('button');box.style.cssText='padding:16px;overflow:auto';text.setAttribute('aria-label','Native content');text.style.cssText='width:100%;height:260px';text.value=block.content;save.textContent='Save';cancel.textContent='Cancel';let draft=()=>({...opts.value,blocks:opts.value.blocks.map(b=>b.id===block.id?{...b,content:text.value}:b)});text.addEventListener('input',()=>opts.onDraftChange?.(draft()));save.onclick=()=>{const next=draft();opts.onChange?.(next);opts.value=next;opts.onDraftChange?.(null);opts.onSelectedBlockChange?.(null);};cancel.onclick=()=>{opts.onDraftChange?.(null);render();};box.append(text,save,cancel);target.append(box);};render();return{update(next){opts={...opts,...next};render();},destroy(){window.destroys++;target.replaceChildren();},getValue:()=>opts.value};}}
});
window.disposeWorkshop=window.mountWorkshop();
</script></body></html>`
