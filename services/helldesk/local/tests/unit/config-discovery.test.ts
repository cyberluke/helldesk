import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadKiloDiscovery, writableKiloConfiguration } from '../../src/config-discovery';
import { stripJsoncComments, deepMerge } from '../../src/config-resolve';

test('JSONC parser preserves comment-like strings and strips commented trailing commas', () => {
  expect(JSON.parse(stripJsoncComments('{"url":"https://example.test/a//b", /* hi */ "x": [1, // last\n],}'))).toEqual({url:'https://example.test/a//b', x:[1]});
  expect(() => stripJsoncComments('{/* unfinished')).toThrow();
  expect(deepMerge({}, JSON.parse('{"__proto__":{"polluted":true},"model":"p/m"}'))).toEqual({model:'p/m'});
});

test('discovery inventories both directory spellings without reinjecting plugins, redacts credentials, retains last good', () => {
  const oldHome = process.env.USERPROFILE, oldDir = process.env.KILO_CONFIG_DIR;
  const home = mkdtempSync(join(tmpdir(), 'helldesk-discovery-'));
  const config = join(home, '.config', 'kilo');
  mkdirSync(join(config, 'plugin', 'support'), {recursive:true});
  mkdirSync(join(config, 'plugins'), {recursive:true});
  writeFileSync(join(config, 'plugin', 'one.ts'), 'export const one = () => {}');
  writeFileSync(join(config, 'plugin', 'support', 'helper.ts'), 'export const helper = 1');
  writeFileSync(join(config, 'plugins', 'two.mjs'), 'export const two = () => {}');
  writeFileSync(join(config, 'kilo.json'), JSON.stringify({model:'first/model',plugin:['./plugins/two.mjs']}));
  writeFileSync(join(config, 'kilo.jsonc'), JSON.stringify({model:'second/model', provider:{second:{options:{apiKey:'do-not-disclose'}}},mcp:{lattice:{type:'local',command:['node','secret-argument'],environment:{TOKEN:'do-not-disclose'}}}}));
  process.env.USERPROFILE = home; delete process.env.KILO_CONFIG_DIR;
  try {
    const first = reloadKiloDiscovery();
    expect(first.status).toBe('ready');
    expect(first.model).toBe('second/model');
    expect(first.plugins.length).toBe(3);
    expect(first.plugins.filter(p=>p.loadedOnNewSession).length).toBe(1);
    expect(first.mcp).toEqual([{name:'lattice',type:'local',enabled:true}]);
    expect(JSON.stringify(first)).not.toContain('do-not-disclose');
    expect(JSON.stringify(first)).not.toContain('secret-argument');
    expect(writableKiloConfiguration().plugin?.length).toBe(1);
    expect(writableKiloConfiguration().plugin?.some(p=>p.includes('one.ts'))).toBe(false);
    writeFileSync(join(config, 'kilo.jsonc'), '{ "apiKey": "sensitive-malformed-value",');
    const bad = reloadKiloDiscovery();
    expect(bad.status).toBe('degraded');
    expect(bad.retainedLastGood).toBe(true);
    expect(JSON.stringify(bad)).not.toContain('sensitive-malformed-value');
    expect(writableKiloConfiguration().model).toBe('second/model');
    expect(bad.application.runningSessions).toBe('unchanged');
  } finally {
    if (oldHome === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=oldHome;
    if (oldDir === undefined) delete process.env.KILO_CONFIG_DIR; else process.env.KILO_CONFIG_DIR=oldDir;
    reloadKiloDiscovery();
  }
});
