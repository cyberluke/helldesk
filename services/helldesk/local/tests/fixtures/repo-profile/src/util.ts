export interface FixtureConfig {
  name: string;
  retries: number;
}

export const DEFAULT_RETRIES = 3;
export const config: FixtureConfig = { name: 'fixture', retries: DEFAULT_RETRIES };
