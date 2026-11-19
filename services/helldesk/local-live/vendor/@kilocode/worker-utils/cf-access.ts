import { validateCfAccessRequest as impl } from './index';
export async function assertCfAccess(_req: Request): Promise<void> {
  await impl();
}