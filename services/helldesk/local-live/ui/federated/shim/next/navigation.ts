/**
 * next/navigation shim — maps the Next.js navigation API onto react-router
 * (HashRouter) so the verbatim original HELLDESK client components can navigate.
 */
import { useNavigate, useLocation, Link as RRLink, type LinkProps } from 'react-router-dom';

export function useRouter(): { push: (href: string) => void; replace: (href: string) => void; back: () => void; prefetch: () => void } {
  const nav = useNavigate();
  return {
    push: (href: string) => nav(href),
    replace: (href: string) => nav(href, { replace: true }),
    back: () => nav(-1),
    prefetch: () => {},
  };
}

export function usePathname(): string {
  const { pathname } = useLocation();
  return pathname;
}

export function useSearchParams(): [URLSearchParams, () => void] {
  const { search } = useLocation();
  return [new URLSearchParams(search), () => {}];
}

export function notFound(): never {
  throw new Error('notFound() called in standalone HELLDESK UI');
}

export function redirect(): never {
  throw new Error('redirect() called in standalone HELLDESK UI');
}