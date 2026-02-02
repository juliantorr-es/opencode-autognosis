import { unifiedTools } from "./unified-api.js";
import { loadWorkingMemory, loadActiveSet } from "./activeset.js";
import { tui } from "./services/tui.js";
import { codeWatcher } from "./services/watcher.js";
import { Logger } from "./services/logger.js";
import { closeDb, getDb } from "./database.js";
import { stopBackgroundIndexing } from "./performance-optimization.js";

export const AutognosisPlugin = async ({ client }: any) => {
  try {
    // Initialize TUI service for progress streaming
    tui.setClient(client);

    // Start live file watcher
    try {
        codeWatcher.start();
    } catch (e) {
        Logger.log("Main", "Failed to start watcher", e);
    }

    return {
      tool: {
        ...unifiedTools(),
      },

      event: async ({ event }: any) => {
        if (!event) return;

        if (event.type === "session.deleted") {
          Logger.log("Main", "Session deleted, cleaning up resources...");
          try {
            codeWatcher.stop();
            stopBackgroundIndexing();
            getDb().stopAllWorkers();
            closeDb();
            tui.stop();
          } catch (e) {
            Logger.log("Main", "Error during resource cleanup", e);
          }
        }
      },

      "experimental.session.compacting": async (input: { sessionID: string }, output: { context: string[] }) => {
        try {
          const agentName = process.env.AGENT_NAME || `agent-${process.pid}`;
          const memory = await loadWorkingMemory();
          if (memory.current_set) {
            const activeSet = await loadActiveSet(memory.current_set);
            if (activeSet) {
          const profile = getDb().getAgentProfile(agentName);
          const stateBlock = `
[AUTOGNOSIS OPERATIONAL KERNEL]
Worker: ${agentName} | Rank: ${profile.rank.toUpperCase()} | MMR: ${profile.mmr}
Context: ActiveSet ${activeSet.name} loaded.

[STANDING ORDERS]
1. IDENTITY: You are a worker process. Focus on artifact production and evidence verification.
2. TERMINATION: Every task must end in: COMPLETED (with receipts), BLOCKED (missing dependency), NEEDS-DECISION (options for human), or ABORTED (rollback).
3. EVIDENCE: Claims of fact require evidence_ids. No evidence = Dead end.
4. ANTI-SPIRAL: Self-referential narrative or existential speculation triggers immediate MMR penalties and autonomy restriction.

[BOARD DIGEST]
${getDb().getBoardDigest()}

[RECENT TRACES]
${(getDb() as any).db.query("SELECT id, tool_invocation FROM trace_artifacts ORDER BY timestamp DESC LIMIT 3").all().map((t: any) => `- ${t.id}: ${t.tool_invocation}`).join("\n")}
`;
              output.context.push(stateBlock);
            }
          }
        } catch (error) {
          // Fail silently during compaction
        }
      }
    };
  } catch (criticalError) {
    Logger.log("CRITICAL", "Plugin failed to initialize", criticalError);
    return {
        tool: {
            autognosis_status: {
                execute: async () => `Autognosis is in emergency mode due to a crash: ${criticalError}`
            }
        }
    };
  }
};

export default AutognosisPlugin;