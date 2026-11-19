import { getKiloDiscovery, reloadKiloDiscovery } from '../../../local/src/config-discovery';
type DiscoveryContext = { json(value: unknown, status?: number): Response };
export function initializeKiloDiscovery() { return reloadKiloDiscovery(); }
export function handleGetKiloConfig(c: DiscoveryContext) { return c.json({ success: true, data: getKiloDiscovery() }); }
export function handleReloadKiloConfig(c: DiscoveryContext) {
  const data = reloadKiloDiscovery();
  return c.json({ success: data.status !== 'unavailable', data }, data.status === 'unavailable' ? 422 : 200);
}
