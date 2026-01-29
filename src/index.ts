import { systemTools } from "./system-tools.js";

export default function plugin() {
  const tools = systemTools();
  
  const initExecutor = async (args: any) => {
    return await tools.autognosis_init.execute(args || {});
  };

  return {
    tools: {
      ...tools,
      // Some versions might look for tools with slashes
      "/autognosis_init": {
        ...tools.autognosis_init,
        execute: initExecutor
      }
    },
    // Common keys for slash command registration
    commands: {
      autognosis_init: {
        description: "Initialize or check the Autognosis environment",
        execute: initExecutor
      }
    },
    slashCommands: [
      {
        name: "autognosis_init",
        description: "Initialize or check the Autognosis environment",
        execute: initExecutor
      }
    ]
  };
}
