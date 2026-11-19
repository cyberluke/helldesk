import { randomUUID } from 'node:crypto';

export function generateId(prefix?: string): string {
  const id = randomUUID().replace(/-/g, '');
  return prefix ? `${prefix}_${id}` : id;
}

export function now(): string {
  return new Date().toISOString();
}