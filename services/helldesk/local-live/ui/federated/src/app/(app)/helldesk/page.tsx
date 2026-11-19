import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_HELLDESK_FEATURE } from '@/lib/constants';
import { DepartmentListPageClient } from './DepartmentListPageClient';

export default async function HelldeskPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/helldesk');

  if (!ENABLE_HELLDESK_FEATURE || !user.is_admin) {
    return notFound();
  }

  return <DepartmentListPageClient />;
}
