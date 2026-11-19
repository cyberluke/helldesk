import type { Context } from 'hono';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { HelldeskEnv } from '../helldesk.worker';
import { DepartmentConfigUpdateSchema, type DepartmentConfig } from '../types';

const LOG = '[department-config.handler]';

export async function handleGetDepartmentConfig(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const departmentDO = getDepartmentDOStub(c.env, params.departmentId);
  const config = await departmentDO.getDepartmentConfig();
  return c.json(resSuccess(maskSensitiveValues(config)));
}

export async function handleUpdateDepartmentConfig(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const body = await parseJsonBody(c);
  const parsed = DepartmentConfigUpdateSchema.safeParse(body);
  if (!parsed.success) {
    console.error(`${LOG} handleUpdateDepartmentConfig: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  // Validate env var key names: alphanumeric + underscore, no reserved prefixes
  if (parsed.data.env_vars) {
    for (const key of Object.keys(parsed.data.env_vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return c.json(
          resError(`Invalid env var key "${key}": must be alphanumeric with underscores`),
          400
        );
      }
      if (key.startsWith('HELLDESK_')) {
        return c.json(resError(`Env var key "${key}" uses reserved HELLDESK_ prefix`), 400);
      }
    }
  }

  // Strip ownership fields — only the system (createDepartment flows) should set these
  const {
    owner_user_id: _a,
    owner_type: _b,
    owner_id: _c,
    organization_id: _d,
    created_by_user_id: _e,
    ...safeConfig
  } = parsed.data;

  const departmentDO = getDepartmentDOStub(c.env, params.departmentId);
  const existingConfig = await departmentDO.getDepartmentConfig();
  const config = await departmentDO.updateDepartmentConfig(safeConfig);

  // Rewrite the frontDesk's AGENTS.md when custom instructions change
  if (config.custom_instructions?.frontDesk !== existingConfig.custom_instructions?.frontDesk) {
    try {
      await departmentDO.updateFrontDeskSystemPrompt();
    } catch (err) {
      console.warn(`${LOG} handleUpdateDepartmentConfig: updateFrontDeskSystemPrompt failed:`, err);
    }
  }

  console.log(`${LOG} handleUpdateDepartmentConfig: department=${params.departmentId} updated config`);
  return c.json(resSuccess(maskSensitiveValues(config)));
}

// Mask token values: show only last 4 chars
function maskToken(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.length <= 4) return '****';
  return '****' + value.slice(-4);
}

function maskSensitiveValues(config: DepartmentConfig): DepartmentConfig {
  const envVars = { ...config.env_vars };
  for (const [key, value] of Object.entries(envVars)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('password') ||
      lowerKey.includes('key') ||
      lowerKey.includes('auth')
    ) {
      envVars[key] = maskToken(value) ?? '';
    }
  }

  return {
    ...config,
    kilocode_token: maskToken(config.kilocode_token),
    env_vars: envVars,
    git_auth: {
      ...config.git_auth,
      github_token: maskToken(config.git_auth.github_token),
      gitlab_token: maskToken(config.git_auth.gitlab_token),
    },
  };
}
