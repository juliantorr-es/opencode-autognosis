import { systemTools } from "./system-tools.js";

/**
 * OpenCode Plugin Entry Point
 */
export default function plugin() {
  const tools = systemTools();

  // Map our internal tool definitions to the format OpenCode expects
  const opencodeTools = Object.entries(tools).reduce((acc, [name, tool]) => {
    acc[name] = {
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
    };
    return acc;
  }, {} as any);

  return {
    // This is the primary key OpenCode looks for to register custom tools
    tools: opencodeTools,
    
    // Fallback/Slash command support
    commands: opencodeTools,
    
    // Explicit slash command registration for /autognosis_init
    slashCommands: [
      {
        name: "autognosis_init",
        description: "Initialize or check the Autognosis environment",
        execute: tools.autognosis_init.execute
      }
    ]
  };
}