import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_HELLDESK_FEATURE } from '@/lib/constants';
import { WorkstationDetailPageClient } from './WorkstationDetailPageClient';

export default async function WorkstationDetailPage({
  params,
}: {
  params: Promise<{ departmentId: string; workstationId: string }>;
}) {
  const { departmentId, workstationId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/helldesk/${departmentId}/workstations/${workstationId}`
  );

  if (!ENABLE_HELLDESK_FEATURE || !user.is_admin) {
    return notFound();
  }

  return <WorkstationDetailPageClient departmentId={departmentId} workstationId={workstationId} />;
}
