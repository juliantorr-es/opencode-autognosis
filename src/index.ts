import { systemTools } from "./system-tools.js";

export default function plugin() {
  const tools = systemTools();
  
  return {
    tools: {
      ...tools,
    },
    // Registering the slash command to point to the tool execution
    commands: {
      autognosis_init: {
        description: "Initialize or check the Autognosis environment",
        execute: async (args: any, context: any) => {
          // This calls the tool implementation directly
          return await tools.autognosis_init.execute(args || {});
        }
      }
    }
  };
}