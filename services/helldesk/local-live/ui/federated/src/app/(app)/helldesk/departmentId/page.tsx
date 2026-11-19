import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_HELLDESK_FEATURE } from '@/lib/constants';
import { DepartmentOverviewPageClient } from './DepartmentOverviewPageClient';

export default async function DepartmentOverviewPage({
  params,
}: {
  params: Promise<{ departmentId: string }>;
}) {
  const { departmentId } = await params;
  const user = await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/helldesk/${departmentId}`);

  if (!ENABLE_HELLDESK_FEATURE || !user.is_admin) {
    return notFound();
  }

  return <DepartmentOverviewPageClient departmentId={departmentId} />;
}
