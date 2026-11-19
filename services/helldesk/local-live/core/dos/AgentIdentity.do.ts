import type { LocalEnv } from '../runtime/registry';

export const getHelldeskUserStub = (env: LocalEnv, userId: string) => env.HELLDESK_USER.get(env.HELLDESK_USER.idFromName(userId));

export { getAgentIdentityStub } from './Agent.do';
export const noopIdentity = true;