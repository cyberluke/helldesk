import { describe, expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import {
  profileRepo,
  renderRepoProfile,
  type RepoProfileSummary,
} from '../../src/repo-profile';

/**
 * Deterministic, read-only fixture: package.json (Next/React/Zod/TypeScript),
 * README with fake TOKEN=/API_KEY= assignments, two .ts files with known line
 * counts, and a `secrets*` file that must never surface.
 */
const FIXTURE_ROOT = join(import.meta.dir, '..', 'fixtures', 'repo-profile');

describe('profileRepo (read-only)', () => {
  it('profiles the fixture with git metadata, manifests, dirs and line counts', () => {
    const profile = profileRepo(FIXTURE_ROOT);

    expect(profile.path).toBe(resolve(FIXTURE_ROOT));
    // The fixture lives inside this repository checkout, so committed tests see
    // real git metadata here.
    expect(profile.kind).toBe('git');
    expect(profile.head ?? '').toMatch(/^[0-9a-f]{40}$/);
    expect(typeof profile.branch).toBe('string');
    // `git ls-files` is scoped to the profiled subtree, so a freshly created
    // fixture is honestly 0 until committed (and 5 afterwards) — never null.
    expect(typeof profile.trackedCount).toBe('number');
    expect(profile.trackedCount).toBeGreaterThanOrEqual(0);
    expect(typeof profile.dirtyFiles).toBe('number');

    expect(profile.topLevel).toContain('src');

    const src = profile.dirs.find((dir) => dir.path === 'src');
    expect(src).toEqual({ path: 'src', files: 2, lines: 12 });

    expect(profile.frameworks).toContain('Next.js');
    expect(profile.frameworks).toContain('React');
    expect(profile.frameworks).toContain('TypeScript');
    expect(profile.frameworks).toContain('Zod');

    expect(profile.scripts.build).toBe('next build');
    expect(profile.scripts.test).toBe('bun test');

    expect(profile.keyFiles).toContain('package.json');
    expect(profile.keyFiles).toContain('README.md');
    // Secret-like paths are skipped, never surfaced as key files.
    expect(profile.keyFiles).not.toContain('secrets.local.json');
  });

  it('redacts TOKEN=/API_KEY= values in bounded doc excerpts', () => {
    const profile = profileRepo(FIXTURE_ROOT);
    const readme = profile.docs.find((doc) => doc.name === 'README.md');
    expect(readme).toBeDefined();
    expect(readme!.excerpt).toContain('***redacted***');
    expect(readme!.excerpt).toContain('LABEL=visible-value');
    expect(readme!.excerpt).not.toContain('fake-token-should-be-redacted');
    expect(readme!.excerpt).not.toContain('fake-api-key-should-be-redacted');
  });

  it('renders bounded markdown without leaking the fake secret file', () => {
    const profile = profileRepo(FIXTURE_ROOT);
    const rendered = renderRepoProfile(profile);

    expect(rendered).toContain('Repository profile');
    expect(rendered).toContain('src: 2 files, 12 lines');
    expect(rendered).toContain('***redacted***');
    expect(rendered).not.toContain('fake-token-should-be-redacted');
    expect(rendered).not.toContain('fake-password-should-not-appear');
    expect(rendered.length).toBeLessThanOrEqual(12_000);
  });

  it('bounds an oversized render at the requested limit', () => {
    const profile = profileRepo(FIXTURE_ROOT);
    const oversized: RepoProfileSummary = {
      ...profile,
      docs: [{ name: 'BIG.md', excerpt: 'x'.repeat(50_000) }],
    };
    const rendered = renderRepoProfile(oversized, { maxChars: 2_000 });
    expect(rendered.length).toBeLessThanOrEqual(2_000);
    expect(rendered).toContain('repository profile truncated');
  });

  it('degrades a missing path to kind=missing without throwing', () => {
    const missing = profileRepo(join(FIXTURE_ROOT, 'does-not-exist'));
    expect(missing.kind).toBe('missing');
    expect(missing.head).toBeNull();
    expect(missing.branch).toBeNull();
    expect(missing.trackedCount).toBeNull();
    expect(missing.notes.join(' ')).toContain('path does not exist');
  });
});
