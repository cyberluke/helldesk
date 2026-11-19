import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_HELLDESK_FEATURE } from '@/lib/constants';
import { AgentsPageClient } from './AgentsPageClient';

export default async function AgentsPage({ params }: { params: Promise<{ departmentId: string }> }) {
  const { departmentId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/helldesk/${departmentId}/agents`
  );
  if (!ENABLE_HELLDESK_FEATURE || !user.is_admin) return notFound();
  return <AgentsPageClient departmentId={departmentId} />;
}
