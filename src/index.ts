import { unifiedTools } from "./unified-api.js";
import { loadWorkingMemory, loadActiveSet } from "./activeset.js";

export const AutognosisPlugin = async () => {
  return {
    tool: {
      ...unifiedTools(),
    },

    "experimental.session.compacting": async (input: { sessionID: string }, output: { context: string[] }) => {
      try {
        const memory = await loadWorkingMemory();
        if (memory.current_set) {
          const activeSet = await loadActiveSet(memory.current_set);
          if (activeSet) {
            const stateBlock = `
[AUTOGNOSIS CONTEXT PRESERVATION]
ActiveSet ID: ${activeSet.id}
ActiveSet Name: ${activeSet.name}
Priority: ${activeSet.priority}
Loaded Chunks: ${activeSet.chunks.join(", ")}
Metadata: ${JSON.stringify(activeSet.metadata)}

The agent is currently focused on these files and symbols. Ensure the summary reflects this active working memory state.
`;
            output.context.push(stateBlock);
          }
        }
      } catch (error) {
        // Fail silently during compaction to avoid breaking the core session
      }
    }
  };
};

export default AutognosisPlugin;