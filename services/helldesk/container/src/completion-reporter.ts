/**
 * Reports agent completion/failure back to the HELLDESK worker API.
 * This closes the ticket and unhooks the agent so the reconciler does not
 * re-dispatch it.
 */

import type { ManagedAgent } from './types';

/**
 * Notify the DepartmentDO that the frontDesk has finished processing a prompt and
 * is now waiting for user input. This lets the DepartmentDO transition the
 * frontDesk from "working" to "waiting", which drops the alarm to the idle
 * cadence and stops health-check pings that reset the container's
 * sleepAfter timer.
 *
 * Best-effort: errors are logged but do not propagate.
 */
export async function reportFrontDeskWaiting(agent: ManagedAgent): Promise<void> {
  const apiUrl = agent.helldeskApiUrl;
  const authToken =
    process.env.HELLDESK_CONTAINER_TOKEN ?? agent.helldeskContainerToken ?? agent.helldeskSessionToken;
  if (!apiUrl || !authToken) {
    console.warn(
      `Cannot report frontDesk ${agent.agentId} waiting: no API credentials on agent record`
    );
    return;
  }

  const url = `${apiUrl}/api/departments/${agent.departmentId}/workstations/${agent.workstationId}/agents/${agent.agentId}/waiting`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ agentId: agent.agentId, firedAt: Date.now() }),
    });

    if (!response.ok) {
      console.warn(
        `Failed to report frontDesk ${agent.agentId} waiting: ${response.status} ${response.statusText}`
      );
    }
  } catch (err) {
    console.warn(`Error reporting frontDesk ${agent.agentId} waiting:`, err);
  }
}

/**
 * Notify the Workstation DO that an agent session has completed or failed.
 * Best-effort: errors are logged but do not propagate.
 */
export async function reportAgentCompleted(
  agent: ManagedAgent,
  status: 'completed' | 'failed',
  reason?: string
): Promise<void> {
  const apiUrl = agent.helldeskApiUrl;
  // Prefer live container token (refreshed via POST /refresh-token)
  const authToken =
    process.env.HELLDESK_CONTAINER_TOKEN ?? agent.helldeskContainerToken ?? agent.helldeskSessionToken;
  if (!apiUrl || !authToken) {
    console.warn(
      `Cannot report agent ${agent.agentId} completion: no API credentials on agent record`
    );
    return;
  }

  const url =
    agent.completionCallbackUrl ??
    `${apiUrl}/api/departments/${agent.departmentId}/workstations/${agent.workstationId}/agents/${agent.agentId}/completed`;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status, reason, agentId: agent.agentId }),
    });

    if (!response.ok) {
      console.warn(
        `Failed to report agent ${agent.agentId} completion: ${response.status} ${response.statusText}`
      );
    } else {
      console.log(`Reported agent ${agent.agentId} ${status} to Workstation DO`);
    }
  } catch (err) {
    console.warn(`Error reporting agent ${agent.agentId} completion:`, err);
  }
}
