import {useEffect, useState} from 'react';
import {z} from 'zod';
import {RefreshCw, Network, Layers, ShieldCheck} from '@/lib/icons';
const Snapshot = z.object({
 scannedAt:z.string(), revision:z.string(), status:z.string(), retainedLastGood:z.boolean(),
 model:z.string().nullable().optional(), defaultAgent:z.string().nullable().optional(), providerNames:z.array(z.string()),
 plugins:z.array(z.object({id:z.string(),source:z.string(),location:z.string().optional(),available:z.boolean().optional(),sha256:z.string().optional()})),
 mcp:z.array(z.object({name:z.string(),type:z.string(),enabled:z.boolean()})),
 errors:z.array(z.object({path:z.string(),code:z.string(),message:z.string()})),
 application:z.object({mode:z.string(),runningSessions:z.string(),message:z.string()})
});
type Connections = z.infer<typeof Snapshot>;
export default function KiloConnections(){
 const [data,setData]=useState<Connections>();const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 async function load(reload=false){
  setBusy(true);setError('');
  try{const response=await fetch('/api/kilo/config'+(reload?'/reload':''),{method:reload?'POST':'GET'});
   const body=z.object({data:Snapshot}).parse(await response.json());setData(body.data);
   if(!response.ok)setError('Configuration could not be applied. See the reported source errors below.');
  }catch(e){setError(e instanceof Error?e.message:'Configuration unavailable');}finally{setBusy(false);}
 }
 useEffect(()=>{void load()},[]);
 return <section className="connections-panel" aria-labelledby="connections-heading">
  <header><div><span className="eyebrow">LIVE TOOLCHAIN</span><h2 id="connections-heading">Your tools. One connected crew.</h2><p className="muted">Kilo providers, MCP servers and plugins — discovered on startup, refreshed on your signal.</p></div>
   <button className="primary" disabled={busy} onClick={()=>void load(true)}><RefreshCw size={16} className={busy?'spin':''}/>{busy?'Reading configuration…':'Reload connections'}</button></header>
  {error&&<p role="alert" className="error-banner">{error}</p>}
  {data&&<>
   <div className="connection-metrics"><div><ShieldCheck/><span>Default model<strong>{data.model||'Not configured'}</strong></span></div><div><Network/><span>MCP declarations<strong>{data.mcp.filter(m=>m.enabled).length} enabled / {data.mcp.length} total</strong></span></div><div><Layers/><span>Plugin sources<strong>{data.plugins.length} discovered</strong></span></div></div>
   <div className="connection-status" role="status"><span className={'chip '+(data.status==='ready'?'ok':'warn')}>{data.status}{data.retainedLastGood?' · last good snapshot':''}</span><span>{data.application.message}</span><time dateTime={data.scannedAt}>{new Date(data.scannedAt).toLocaleTimeString()}</time></div>
   <div className="connection-lists"><div><h3>MCP servers</h3><p className="muted">Declared configuration; this scan does not start or health-check servers.</p>{data.mcp.map(m=><div className="connection-row" key={m.name}><Network size={16}/><strong>{m.name}</strong><span>{m.type}</span><span className="chip">{m.enabled?'enabled':'disabled'}</span></div>)}{!data.mcp.length&&<p className="muted">No MCP entries found.</p>}</div>
   <div><h3>Plugins</h3><p className="muted">Executable plugins load in new Kilo sessions. Running work stays uninterrupted.</p>{data.plugins.map((p,i)=><div className="connection-row" key={p.id+String(i)}><Layers size={16}/><div><strong>{p.id}</strong><small className="mono">{p.source}</small></div><span className="chip">{p.available===false?'missing':'discovered'}</span></div>)}{!data.plugins.length&&<p className="muted">No plugin entries found.</p>}</div></div>
   {data.errors.map((e,i)=><p className="error-banner" key={i}>{e.code}: {e.message} <span className="mono">{e.path}</span></p>)}
  </>}
 </section>
}
