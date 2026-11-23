import { notFound } from 'next/navigation';
import { CommitsPageClient } from './CommitsPageClient';

export default async function CommitsPage({
  params,
}: {
  params: Promise<{ departmentId: string }>;
}) {
  const { departmentId } = await params;
  if (!departmentId) notFound();
  return <CommitsPageClient departmentId={departmentId} />;
}
