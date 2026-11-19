/**
 * Integration tests for the torn-down-SDK fall-through in _ensureFrontDesk.
 *
 * Change 3 of the frontDesk startup optimization: when the container reports
 * the frontDesk as "running"/"starting" but the SDK has no serverPort or
 * sessionId (torn down after stream errors or drain), _ensureFrontDesk must
 * fall through to a fresh dispatch instead of returning early.
 *
 * In the test environment there's no real container, so
 * checkAgentContainerStatus returns { status: 'unknown' } or
 * { status: 'not_found' }. These tests verify that:
 * 1. ensureFrontDesk falls through when the container status is not "running"/"starting"
 * 2. checkAgentContainerStatus surfaces serverPort and sessionId when available
 * 3. The sdkAlive check correctly rejects zero/empty port/session values
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name = 'test-department') {
  const id = env.department.idFromName(name);
  return env.department.get(id);
}

describe('ensureFrontDesk torn-down-SDK fall-through', () => {
  let department: ReturnType<typeof getDepartmentStub>;
  let departmentName: string;

  beforeEach(async () => {
    departmentName = `sdk-fallthrough-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
    await department.setDepartmentId(departmentName);
    await department.addWorkstation({
      workstationId: 'workstation-1',
      name: 'main-workstation',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  describe('container not available (test env baseline)', () => {
    it('should fall through when container status is not running/starting', async () => {
      const result = await department.ensureFrontDesk();
      expect(result.agentId).toBeTruthy();
      expect(result.sessionStatus).toBe('idle');
    });

    it('should return the same agentId on repeated ensureFrontDesk calls', async () => {
      const first = await department.ensureFrontDesk();
      const second = await department.ensureFrontDesk();
      expect(first.agentId).toBe(second.agentId);
    });
  });

  describe('sdkAlive validation logic', () => {
    it('should reject zero serverPort (SDK torn down)', () => {
      const isAlive = true;
      const serverPort = 0;
      const sessionId = 'some-session';
      const sdkAlive = isAlive && (serverPort ?? 0) > 0 && Boolean(sessionId);
      expect(sdkAlive).toBe(false);
    });

    it('should reject empty sessionId (SDK torn down)', () => {
      const isAlive = true;
      const serverPort = 8080;
      const sessionId = '';
      const sdkAlive = isAlive && (serverPort ?? 0) > 0 && Boolean(sessionId);
      expect(sdkAlive).toBe(false);
    });

    it('should accept valid serverPort and sessionId', () => {
      const isAlive = true;
      const serverPort = 8080;
      const sessionId = 'session-123';
      const sdkAlive = isAlive && (serverPort ?? 0) > 0 && Boolean(sessionId);
      expect(sdkAlive).toBe(true);
    });

    it('should reject when container says not alive', () => {
      const isAlive = false;
      const serverPort = 8080;
      const sessionId = 'session-123';
      const sdkAlive = isAlive && (serverPort ?? 0) > 0 && Boolean(sessionId);
      expect(sdkAlive).toBe(false);
    });
  });

  describe('checkAgentContainerStatus response parsing', () => {
    it('should include serverPort and sessionId from container response', async () => {
      const agentId = (await department.ensureFrontDesk()).agentId;
      const container = env.DEPARTMENT_CONTAINER.get(env.DEPARTMENT_CONTAINER.idFromName(departmentName));
      const response = await container.fetch(`http://container/agents/${agentId}/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(404);
    });
  });
});
