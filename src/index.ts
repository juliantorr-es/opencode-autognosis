import { systemTools } from "./system-tools.js";

export default function plugin() {
  const tools = systemTools();
  
  const initExecutor = async (args: any) => {
    return await tools.autognosis_init.execute(args || {});
  };

  const initMetadata = {
    name: "autognosis_init",
    description: "Initialize or check the Autognosis environment",
    parameters: tools.autognosis_init.parameters,
    execute: initExecutor
  };

  return {
    tools: {
      ...tools,
      // Attempting as a tool with a slash prefix
      "/autognosis_init": initMetadata
    },
    // Pattern 1: Object-based commands
    commands: {
      autognosis_init: initMetadata
    },
    // Pattern 2: Array-based commands
    slashCommands: [initMetadata],
    // Pattern 3: Chat-specific commands
    chatCommands: {
      autognosis_init: initMetadata
    },
    // Pattern 4: Intentions (common in some agent frameworks)
    intentions: [
      {
        ...initMetadata,
        intent: "initialize_autognosis"
      }
    ]
  };
}