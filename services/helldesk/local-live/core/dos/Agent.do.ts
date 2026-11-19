import type { LocalEnv } from '../runtime/registry';

export function getAgentDOStub(env: LocalEnv, ticketId: string) {
  return env.AGENT.get(env.AGENT.idFromName(ticketId));
}
export function getAgentIdentityStub(env: LocalEnv, id: string) {
  return env.AGENT_IDENTITY.get(env.AGENT_IDENTITY.idFromName(id));
}