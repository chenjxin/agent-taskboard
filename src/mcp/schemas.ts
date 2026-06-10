import { z } from 'zod';
import { PARAM_DESCRIPTIONS as P } from './descriptions.js';

export const agentIdSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, "agent_id must look like '<human>/<agent>', e.g. 'wang/claude-main'")
  .max(100)
  .describe(P.agent_id);

export const scopeRowSchema = z
  .object({
    path_glob: z.string().max(500).optional().describe(P.path_glob),
    module: z.string().max(200).optional().describe(P.module),
    note: z.string().max(500).optional().describe(P.scope_note),
  })
  .describe('One scope declaration row; needs path_glob and/or module.');

export const registerTaskShape = {
  agent_id: agentIdSchema,
  project: z.string().min(1).max(200).describe(P.project),
  title: z.string().min(1).max(200).describe(P.title),
  description: z.string().max(4000).optional().describe(P.description),
  branch: z.string().max(200).optional().describe(P.branch),
  scope: z.array(scopeRowSchema).max(50).optional().describe(P.scope),
};

export const listTasksShape = {
  agent_id: agentIdSchema,
  project: z.string().max(200).optional().describe(P.project),
  status: z.enum(['active', 'done', 'abandoned', 'all']).optional().describe(P.status_filter),
  owner_agent_id: z.string().max(100).optional().describe(P.owner_filter),
};

export const getTaskShape = {
  agent_id: agentIdSchema,
  task_id: z.string().min(1).max(50).describe(P.task_id),
};

export const checkOverlapShape = {
  agent_id: agentIdSchema,
  project: z.string().min(1).max(200).describe(P.project),
  scope: z.array(scopeRowSchema).max(50).optional().describe(P.scope),
  exclude_task_id: z.string().max(50).optional().describe(P.exclude_task_id),
};

export const updateScopeShape = {
  agent_id: agentIdSchema,
  task_id: z.string().min(1).max(50).describe(P.task_id),
  scope: z.array(scopeRowSchema).max(50).describe(`FULL REPLACEMENT of all scope rows. ${P.scope}`),
};

export const addCommentShape = {
  agent_id: agentIdSchema,
  task_id: z
    .string()
    .min(1)
    .max(50)
    .describe(`${P.task_id} Coordination happens on the COUNTERPART's thread — comment on their task.`),
  body: z.string().min(1).max(8000).describe(P.comment_body),
  kind: z.enum(['comment', 'boundary_agreement']).optional().describe(P.comment_kind),
};

export const updateStatusShape = {
  agent_id: agentIdSchema,
  task_id: z.string().min(1).max(50).describe(P.task_id),
  status: z.enum(['done', 'abandoned']).describe(P.close_status),
  closing_note: z.string().max(4000).optional().describe(P.closing_note),
};

export const heartbeatShape = {
  agent_id: agentIdSchema,
  task_id: z.string().min(1).max(50).describe(P.task_id),
};
