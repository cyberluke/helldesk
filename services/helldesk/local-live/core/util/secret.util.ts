/** Local HELLDESK — secret util shim. CTO: secrets live in NAI Lattice. */
export async function resolveSecret(ref?: string): Promise<string | null> {
  if (!ref) return null;
  // Plain local passthrough (dev) — a real secret facade can be mounted later.
  if (ref.startsWith('env::')) return process.env[ref.slice(5)] ?? null;
  return ref;
}

export async function resolveSecretOrThrow(ref: string): Promise<string> {
  const v = await resolveSecret(ref);
  if (v == null) throw new Error(`secret not resolvable locally: ${ref}`);
  return v;
}