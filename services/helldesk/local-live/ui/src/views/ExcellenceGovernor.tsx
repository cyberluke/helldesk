import {useEffect,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import {z} from 'zod';
import {ShieldCheck,RefreshCw,ArrowRight} from '@/lib/icons';
const Mission=z.object({missionId:z.string(),objective:z.string(),state:z.string(),blockedReason:z.string().nullable().optional(),verifiedAt:z.string().nullable().optional()});
const Room=z.object({data:z.object({tickets:z.array(z.object({ticket_id:z.string(),title:z.string(),metadata:z.object({local_mission:z.object({missionId:z.string().optional()}).optional()}).passthrough().nullable().optional()}))})});
type Row=z.infer<typeof Mission>&{title:string};
export default function ExcellenceGovernor(){
 const {departmentId=''}=useParams();const [rows,setRows]=useState<Row[]>([]);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;
  async function load(){if(active)setBusy(true);try{
   const [missionResponse,roomResponse]=await Promise.all([fetch('/api/v1/missions',{signal:AbortSignal.timeout(10000)}),fetch(`/api/departments/${encodeURIComponent(departmentId)}/room`,{signal:AbortSignal.timeout(10000)})]);
   if(!missionResponse.ok||!roomResponse.ok)throw Error('Mission controller unavailable. Check the local daemon in launcher logs.');
   const missions=z.object({missions:z.array(Mission)}).parse(await missionResponse.json()).missions;
   const tickets=Room.parse(await roomResponse.json()).data.tickets;
   const mapped=missions.flatMap(m=>{const b=tickets.find(b=>b.metadata?.local_mission?.missionId===m.missionId);return b?[{...m,title:b.title}]:[]});
   if(active){setRows(mapped);setError('');}
  }catch(e){if(active)setError(e instanceof Error?e.message:'Could not read reviews');}finally{if(active)setBusy(false);}}
  void load();const timer=setInterval(load,5000);return()=>{active=false;clearInterval(timer)};
 },[departmentId]);
 return <div className="operator-page operator-console"><header className="operator-hero"><div><span className="operator-eyebrow">INDEPENDENT MACHINE REVIEW</span><h1>Build. Challenge. Refine.</h1><p>Kilo implements. The configured reviewer challenges each revision. You steer asynchronously and alone give production acceptance.</p></div><ShieldCheck size={40}/></header>
  <div className="connection-status"><span className="chip">Local mission controller</span><span>{rows.length} missions in this department</span><span>{busy?<RefreshCw size={14} className="spin"/>:'Refreshes every 5 seconds'}</span></div>
  {error&&<p role="alert" className="error-banner">{error}</p>}
  {!rows.length&&!error&&<section className="connections-panel"><h2>Your review loop starts with a task.</h2><p className="muted">Choose ExcellenceGovernor in Task Studio. Implementation and review run together; no human approval inbox is inserted.</p><Link to={`/helldesk/${departmentId}/studio`}>Open Task Studio <ArrowRight size={15}/></Link></section>}
  {rows.map(m=><article key={m.missionId} className="connections-panel"><header><div><span className="eyebrow">{m.missionId.slice(0,12)}</span><h2>{m.title}</h2></div><span className={'chip '+(m.state==='VERIFIED_10_10'?'ok':m.state==='BLOCKED'?'warn':'')}>{m.state==='VERIFIED_10_10'?'Machine review satisfied':m.state.replaceAll('_',' ')}</span></header>
   {m.blockedReason&&<p className="error-banner">{m.blockedReason}</p>}
   <details><summary>Full objective</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',font:'12px/1.7 var(--mono)',maxHeight:280,overflow:'auto'}}>{m.objective}</pre></details>
   <p className="muted">Machine verdicts do not grant CTO acceptance. Send corrections from the Operator-console; they persist for the next work boundary.</p>
   <Link to={`/helldesk/${departmentId}/chat`}>Steer the crew <ArrowRight size={15}/></Link>
  </article>)}
 </div>;
}
