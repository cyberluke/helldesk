import type { LocalEnv } from '../runtime/registry';

export function getHelldeskOrgStub(env: LocalEnv, orgId: string) {
  return env.HELLDESK_ORG.get(env.HELLDESK_ORG.idFromName(orgId));
}