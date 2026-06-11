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
  start_as: z.enum(['active', 'planned', 'backlog']).optional().describe(P.start_as),
  iteration: z.string().max(100).optional().describe(P.iteration),
  depends_on: z.array(z.string().max(50)).max(20).optional().describe(P.depends_on),
};

export const listTasksShape = {
  agent_id: agentIdSchema,
  project: z.string().max(200).optional().describe(P.project),
  status: z
    .enum(['open', 'planned', 'active', 'done', 'abandoned', 'all'])
    .optional()
    .describe(P.status_filter),
  owner_agent_id: z.string().max(100).optional().describe(P.owner_filter),
  iteration: z.string().max(100).optional().describe(P.iteration_filter),
};

export const claimTaskShape = {
  agent_id: agentIdSchema,
  task_id: z
    .string()
    .min(1)
    .max(50)
    .describe(
      'The planned/backlog task to claim. Origin: list_tasks rows, an overlap report, or your human.',
    ),
};

export const updateTaskShape = {
  agent_id: agentIdSchema,
  task_id: z.string().min(1).max(50).describe(P.task_id),
  title: z.string().min(1).max(200).optional().describe(P.title),
  description: z.string().max(4000).optional().describe(P.description),
  branch: z.string().max(200).nullable().optional().describe(`${P.branch} Pass null to clear.`),
  iteration: z.string().max(100).optional().describe(P.iteration),
  depends_on: z
    .array(z.string().max(50))
    .max(20)
    .optional()
    .describe(`FULL REPLACEMENT of the dependency list. ${P.depends_on}`),
};

export const submitFeedbackShape = {
  agent_id: agentIdSchema,
  kind: z
    .enum(['bug', 'friction', 'idea', 'praise'])
    .describe(
      "'bug' = the board misbehaved; 'friction' = a tool/description made you work harder than needed; 'idea' = a capability you wished for; 'praise' = something worked notably well.",
    ),
  body: z
    .string()
    .min(1)
    .max(4000)
    .describe('The feedback itself, 1-2 sentences. Include what you were trying to do when it came up.'),
  context: z
    .string()
    .max(500)
    .optional()
    .describe('Optional: tool name / project / task id involved, if relevant.'),
};

export const getStandupShape = {
  agent_id: agentIdSchema,
  project: z.string().max(200).optional().describe(P.project),
  iteration: z.string().max(100).optional().describe(P.iteration_filter),
  window_hours: z.number().int().min(1).max(168).optional().describe(P.window_hours),
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
