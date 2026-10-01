import { useEffect, useRef } from 'react';
import type { HarnessConfig } from '@/store/config';
import { useRoute } from '../router/useRoute';
import { formatRoute, routeTitle } from '../router/routes';
import { AgentsView } from '../pages/AgentsView';
import { NotFoundPage } from '../pages/NotFoundPage';

export function RouteView({ config }: { config: HarnessConfig }) {
  const route = useRoute();
  const key = formatRoute(route);
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
    mainRef.current?.querySelector<HTMLElement>('h1')?.focus?.();
    document.title = `${routeTitle(route)} · Nexus`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  let page;
  switch (route.name) {
    case 'agents': page = <AgentsView config={config} />; break;
    case 'not-found': page = <NotFoundPage />; break;
    default: page = <NotFoundPage message="Coming in this build." />;
  }
  return <main ref={mainRef} className={`nx-main${route.name === 'agents' ? ' nx-main--flush' : ''}`} id="nx-main">{page}</main>;
}
