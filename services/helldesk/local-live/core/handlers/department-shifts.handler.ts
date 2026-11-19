import type { Context } from 'hono';
import { z } from 'zod';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { HelldeskEnv, HelldeskAppEnv } from '../helldesk.worker';

const CreateShiftBody = z.object({
  title: z.string().min(1),
  tickets: z
    .array(
      z.object({
        ticket_id: z.string().min(1),
        workstation_id: z.string().min(1),
      })
    )
    .min(1),
  created_by: z.string().min(1).optional(),
});

export async function handleCreateShift(c: Context<HelldeskAppEnv>, params: { departmentId: string }) {
  const body = await parseJsonBody(c);
  const parsed = CreateShiftBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const departmentDO = getDepartmentDOStub(c.env, params.departmentId);
  const shift = await departmentDO.createShift(parsed.data);
  return c.json(resSuccess(shift), 201);
}

const OnTicketClosedBody = z.object({
  shift_id: z.string().min(1),
  ticket_id: z.string().min(1),
});

export async function handleOnTicketClosed(c: Context<HelldeskAppEnv>, params: { departmentId: string }) {
  const body = await parseJsonBody(c);
  const parsed = OnTicketClosedBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const departmentDO = getDepartmentDOStub(c.env, params.departmentId);
  const shift = await departmentDO.onTicketClosed({
    shiftId: parsed.data.shift_id,
    ticketId: parsed.data.ticket_id,
  });

  if (!shift) return c.json(resError('Shift not found'), 404);
  return c.json(resSuccess(shift));
}
