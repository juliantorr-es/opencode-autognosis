import { z } from "zod";

export const SCHEMA_VERSION = "2.1.0";

export const VerificationHookSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  expected_output: z.string().optional()
});

export const ProvenanceSchema = z.object({
  agent_id: z.string(),
  worktree: z.string().optional(),
  branch: z.string().optional(),
  git_hash: z.string().optional()
});

export const ChunkCardSchema = z.object({
  id: z.string(),
  schema_version: z.string().default(SCHEMA_VERSION),
  kernel_sig: z.string().optional(),
  file_path: z.string(),
  chunk_type: z.enum(["summary", "api", "invariant"]),
  content: z.string(),
  parent_id: z.string().optional(),
  verification: z.array(VerificationHookSchema).optional(),
  provenance: ProvenanceSchema.optional(),
  metadata: z.object({
    created_at: z.string(),
    updated_at: z.string(),
    hash: z.string(),
    dependencies: z.array(z.string()),
    symbols: z.array(z.string()),
    calls: z.array(z.object({
      name: z.string(),
      line: z.number()
    })).optional(),
    complexity_score: z.number()
  })
});

export const ChangeSessionSchema = z.object({
  id: z.string(),
  kernel_sig: z.string().optional(),
  token: z.string(),
  base_commit: z.string(),
  worktree_name: z.string().optional(),
  intent: z.string(),
  status: z.enum(["active", "validating", "finalized", "aborted"]),
  files_touched: z.array(z.string()),
  patch_ids: z.array(z.string()),
  verification_results: z.array(z.string()),
  created_at: z.string()
});

export const BoardPostSchema = z.object({
  id: z.string(),
  kernel_sig: z.string().optional(),
  title: z.string(),
  type: z.enum(["proposal", "finding", "question", "decision", "incident"]),
  body: z.string(),
  author: ProvenanceSchema,
  status: z.enum(["open", "resolved", "superseded", "disputed"]),
  evidence_ids: z.array(z.string()),
  created_at: z.string()
});

export const SkillArtifactSchema = z.object({
  id: z.string(),
  kernel_sig: z.string().optional(),
  name: z.string(),
  version: z.string(),
  scope: z.enum(["global", "repo", "worktree", "task"]),
  instructions: z.string(),
  provenance: ProvenanceSchema
});

// Non-canonical / Runtime types
export const BackgroundJobSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "stopped"]),
  progress: z.number(),
  result: z.string().optional(),
  error: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string()
});

export const PerformanceMetricSchema = z.object({
  operation: z.string(),
  duration_ms: z.number(),
  memory_usage_mb: z.number(),
  success: z.boolean(),
  error: z.string().optional()
});

export const JobArtifactSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "stopped"]),
  logs: z.array(z.string()),
  outputs: z.record(z.string(), z.any()),
  final_summary: z.string().optional(),
  provenance: ProvenanceSchema
});

export const TraceArtifactSchema = z.object({
  id: z.string(),
  hook_event: z.string().optional(),
  tool_invocation: z.string().optional(),
  inputs: z.any(),
  outputs: z.any(),
  duration_ms: z.number(),
  artifacts_produced: z.array(z.string()),
  timestamp: z.string()
});

export const PruningMapSchema = z.object({
  artifact_id: z.string(),
  start_turn: z.number(),
  end_turn: z.number(),
  is_eligible: z.boolean().default(true)
});

export const WorkerRegistrySchema = z.object({
  pid: z.number(),
  run_id: z.string(),
  command: z.string(),
  cwd: z.string(),
  start_time: z.string(),
  last_heartbeat: z.string(),
  status: z.enum(["alive", "stale", "terminated"]),
  limits: z.object({
    cpu_throttle: z.number(),
    memory_cap_mb: z.number()
  })
});

export const AgentRank = z.enum([
  "wood", "bronze", "silver", "gold", "platinum", "emerald", "diamond", "master", "challenger"
]);

export const AgentProfileSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  rank: AgentRank.default("bronze"),
  mmr: z.number().default(1000),
  streak: z.number().default(0),
  probation: z.boolean().default(false),
  stats: z.object({
    verified_fixes: z.number().default(0),
    regressions: z.number().default(0),
    evidence_score_avg: z.number().default(0),
    last_verification_at: z.string().optional()
  }),
  allowed_tools: z.array(z.string()),
  created_at: z.string()
});

export const RunEvalSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  agent_id: z.string(),
  score: z.number(),
  breakdown: z.object({
    correctness: z.number(),
    evidence: z.number(),
    safety: z.number(),
    verification: z.number()
  }),
  reasons: z.array(z.string()),
  evidence_ids: z.array(z.string()),
  mmr_delta: z.number(),
  timestamp: z.string()
});

export const BoardReplySchema = z.object({
  id: z.string(),
  post_id: z.string(),
  type: z.enum(["review", "objection", "improvement", "verification"]),
  body: z.string(),
  author: ProvenanceSchema,
  evidence_ids: z.array(z.string()).optional(),
  created_at: z.string()
});

export type ChunkCard = z.infer<typeof ChunkCardSchema>;
export type BackgroundJob = z.infer<typeof BackgroundJobSchema>;
export type PerformanceMetric = z.infer<typeof PerformanceMetricSchema>;
export type ChangeSession = z.infer<typeof ChangeSessionSchema>;
export type JobArtifact = z.infer<typeof JobArtifactSchema>;
export type SkillArtifact = z.infer<typeof SkillArtifactSchema>;
export type TraceArtifact = z.infer<typeof TraceArtifactSchema>;
export type PruningMap = z.infer<typeof PruningMapSchema>;
export type WorkerRegistry = z.infer<typeof WorkerRegistrySchema>;
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type RunEval = z.infer<typeof RunEvalSchema>;
export type BoardPost = z.infer<typeof BoardPostSchema>;
export type BoardReply = z.infer<typeof BoardReplySchema>;