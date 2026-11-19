import type { Config } from '../src/config';

/** Build an in-memory Config for tests without a config file. */
export function loadConfigLegacy(runner: 'fake' | 'openai' | 'kilo' = 'fake', opts?: {
  reviewerModel?: { providerID: string; modelID: string };
  dataDir?: string;
  reportDir?: string;
}): Config {
  return {
    version: 1,
    daemon: {
      bind: '127.0.0.1',
      port: 4799,
      debounceMs: 200,
      maxConcurrentJobs: 1,
      maxReviewersPerJob: 2,
      maxAttempts: 3,
      leaseSeconds: 120,
      requestTimeoutMs: 60_000,
      retryBaseMs: 100,
      retryMaxMs: 2000,
      breakerThreshold: 3,
      breakerCooldownMs: 1000,
      maxSnapshotBytes: 64 * 1024 * 1024,
      retentionDays: 7,
      dataDir: opts?.dataDir,
    },
    policy: {
      runner,
      providers: runner === 'openai' ? {} : undefined,
      reviewerModel: opts?.reviewerModel,
      strictCoverage: true,
    },
    autonomy: {
      enabled: false,
      mutationRunner: 'kilo',
      kiloBin: '',
      providerID: '',
      modelID: '',
      baseURL: '',
      apiKey: '',
    },
    workspaces: [],
  };
}