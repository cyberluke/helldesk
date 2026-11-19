import {z} from 'zod';
import type {LocalDepartment} from '../runtime/LocalDepartment';
import {steerLocalMission} from '../runtime/mission-dispatch';
const Nudge=z.object({target_agent_id:z.string().min(1),message:z.string().trim().min(1).max(16000),mode:z.enum(['queue','immediate']).optional()});
export async function handleOperatorNudge(c:{req:{json():Promise<unknown>};json(body:unknown,status?:number):Response},department:LocalDepartment){
 const input=Nudge.safeParse(await c.req.json().catch(()=>null));
 if(!input.success)return c.json({success:false,error:'Select a recipient and enter a message'},400);
 const agent=await department.getAgentAsync(input.data.target_agent_id);
 if(!agent)return c.json({success:false,error:'Agent no longer exists in this department'},404);
 try{
  const mission=agent.current_hook_ticket_id?await steerLocalMission(department.sql,agent.current_hook_ticket_id,input.data.message,'message'):null;
  const id=await department.queueNudge(input.data.target_agent_id,input.data.message,{source:'human',type:'operator-message',mode:'queue'});
  return c.json({success:true,data:{nudge_id:id,delivery:mission?.delivery||'queued_for_agent',acknowledgedByAgent:false}});
 }catch{return c.json({success:false,error:'Message could not be durably queued. Please retry; work has not been paused.'},503);}
}
