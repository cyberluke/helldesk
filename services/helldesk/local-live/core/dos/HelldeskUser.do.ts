import type { LocalEnv } from '../runtime/registry';

export function getHelldeskUserStub(env: LocalEnv, userId: string) {
  return env.HELLDESK_USER.get(env.HELLDESK_USER.idFromName(userId));
}