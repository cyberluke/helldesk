import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_HELLDESK_FEATURE } from '@/lib/constants';
import { TicketsPageClient } from './TicketsPageClient';

export default async function TicketsPage({ params }: { params: Promise<{ departmentId: string }> }) {
  const { departmentId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/helldesk/${departmentId}/tickets`
  );
  if (!ENABLE_HELLDESK_FEATURE || !user.is_admin) return notFound();
  return <TicketsPageClient departmentId={departmentId} />;
}
