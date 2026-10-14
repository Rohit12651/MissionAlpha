// Step 1 — the env block for a seat's mail MCP server, as ONE pure function so the binding
// can be pinned without spawning anything. Job id = ctx.storyId (Manager-planned goals carry
// the job id there); goal id = ctx.goalId. Roles only — never a writeScope.
export function mailEnvFor({ seat, ctx, roster, mailDir }) {
  return {
    MA_MAIL_AGENT_ID: seat.id,
    MA_MAIL_DIR: mailDir,
    MA_MAIL_JOB_ID: ctx?.storyId || "",
    MA_MAIL_GOAL_ID: ctx?.goalId || "",
    MA_MAIL_TASK_ID: ctx?.taskId || "",
    MA_MAIL_ROLES: JSON.stringify(Object.fromEntries(roster.all().map((m) => [m.id, m.role]))),
  };
}
