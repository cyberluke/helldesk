import {test,expect} from 'bun:test';
import {makeTestDb} from '../helpers';
import {createMissionRequest,listMissions} from '../../src/mission-repository';
test('lost submission response reuses one durable mission and rejects changed objectives',()=>{
 const fixture=makeTestDb();
 try{
  const request={workspaceId:'ws_fixture',objective:'complete the full objective',idempotencyKey:'department:ticket:one',taskGates:['scope'],tickets:[{title:'Implement',objective:'complete the full objective',dependsOn:[]}]};
  const first=createMissionRequest(fixture.d,request);
  const retry=createMissionRequest(fixture.d,structuredClone(request));
  expect(first.conflict).toBe(false);expect(retry.conflict).toBe(false);
  if(!first.conflict&&!retry.conflict){expect(retry.missionId).toBe(first.missionId);expect(retry.ticketIds).toEqual(first.ticketIds);expect(retry.reused).toBe(true);}
  expect(createMissionRequest(fixture.d,{...request,objective:'silently changed scope'}).conflict).toBe(true);
  expect(listMissions(fixture.d).length).toBe(1);
 }finally{fixture.d.close();}
});
