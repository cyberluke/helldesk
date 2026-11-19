/**
 * next/link shim — maps Next.js <Link> onto react-router <Link> for the
 * verbatim original HELLDESK client components.
 */
import { Link as RRLink, type LinkProps } from 'react-router-dom';
import type { ReactNode } from 'react';

export default function Link({
  href,
  children,
  prefetch,
  className,
  onClick,
  ...rest
}: {
  href: string;
  children: ReactNode;
  prefetch?: boolean;
  className?: string;
  onClick?: React.MouseEventHandler;
} & Omit<LinkProps, 'to' | 'prefetch'>) {
  return (
    <RRLink to={href} className={className} onClick={onClick} {...rest}>
      {children}
    </RRLink>
  );
}