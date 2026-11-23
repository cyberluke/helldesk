import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveKiloBinary } from '../../src/kilo-binary';

const SCRATCH = resolve(import.meta.dir, '../../.local');

function tempHome(): string {
  mkdirSync(SCRATCH, { recursive: true });
  const home = join(SCRATCH, `kilo-binary-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  return home;
}

function installExtension(home: string, version: string): string {
  const root = join(home, '.vscode-insiders', 'extensions');
  const dir = join(root, `kilocode.kilo-code-${version}-win32-x64`, 'bin');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'kilo.exe');
  writeFileSync(bin, 'dummy');
  return bin;
}

describe('Kilo binary discovery', () => {
  test('prefers the newest installed extension over older ones', () => {
    const home = tempHome();
    try {
      const oldBin = installExtension(home, '7.8.31');
      const newBin = installExtension(home, '7.8.32');
      const found = resolveKiloBinary({
        home,
        platform: 'win32',
        skipPathLookup: true,
        extensionRoots: [join(home, '.vscode-insiders', 'extensions')],
      });
      expect(found).toEqual({ path: newBin, source: 'extension', version: '7.8.32' });
      expect(found?.path).not.toBe(oldBin);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an explicit configured binary wins over discovery', () => {
    const home = tempHome();
    try {
      installExtension(home, '7.8.32');
      const explicit = installExtension(home, '9.9.9');
      const found = resolveKiloBinary({
        configured: explicit,
        home,
        platform: 'win32',
        skipPathLookup: true,
        extensionRoots: [join(home, '.vscode-insiders', 'extensions')],
      });
      expect(found).toEqual({ path: explicit, source: 'configured' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an environment override wins when no configured path exists', () => {
    const home = tempHome();
    try {
      const envBin = installExtension(home, '7.8.32');
      const found = resolveKiloBinary({
        configured: join(home, 'missing', 'kilo.exe'),
        env: { KILO_BIN: envBin },
        home,
        platform: 'win32',
        skipPathLookup: true,
        extensionRoots: [join(home, '.vscode-insiders', 'extensions')],
      });
      expect(found).toEqual({ path: envBin, source: 'env' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns null instead of inventing a path', () => {
    const home = tempHome();
    try {
      const found = resolveKiloBinary({
        home,
        platform: 'win32',
        skipPathLookup: true,
        extensionRoots: [join(home, '.vscode-insiders', 'extensions')],
      });
      expect(found).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
