import { systemTools } from "./system-tools.js";
import { gitWorktreeTools } from "./git-worktree.js";
import { testingTools } from "./testing-infrastructure.js";
import { chunkCardsTools } from "./chunk-cards.js";
import { activeSetTools } from "./activeset.js";
import { moduleSummariesTools } from "./module-summaries.js";
import { performanceTools } from "./performance-optimization.js";

export const AutognosisPlugin = async () => {
  return {
    tool: {
      ...systemTools(),
      ...gitWorktreeTools(),
      ...testingTools(),
      ...chunkCardsTools(),
      ...activeSetTools(),
      ...moduleSummariesTools(),
      ...performanceTools(),
    },
  };
};

export default AutognosisPlugin;