import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { systemTools } from "./system-tools.js";

async function main() {
  const server = new McpServer({
    name: "opencode-autognosis",
    version: "0.1.5",
  });

  const tools = systemTools();

  const register = (toolName: string, zodSchema: any) => {
    const toolDef = (tools as any)[toolName];
    server.registerTool(
      toolName,
      {
        description: toolDef.description,
        inputSchema: zodSchema,
      },
      async (args: any) => {
        try {
          const result = await toolDef.execute(args);
          return {
            content: [{ type: "text" as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
          };
        } catch (error: any) {
          return {
            content: [{ type: "text" as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }
      }
    );
  };

  register("fast_search", z.object({
    query: z.string(),
    mode: z.enum(["filename", "content"]).optional().default("filename"),
    path: z.string().optional().default(".")
  }).shape);

  register("structural_search", z.object({
    pattern: z.string(),
    path: z.string().optional().default("."),
    plan_id: z.string().optional()
  }).shape);

  register("read_slice", z.object({
    file: z.string(),
    start_line: z.number(),
    end_line: z.number(),
    plan_id: z.string().optional()
  }).shape);

  register("symbol_query", z.object({
    symbol: z.string()
  }).shape);

  register("jump_to_symbol", z.object({
    symbol: z.string(),
    plan_id: z.string().optional()
  }).shape);

  register("autognosis_init", z.object({
    mode: z.enum(["plan", "apply"]).optional().default("plan"),
    token: z.string().optional()
  }).shape);

  register("brief_fix_loop", z.object({
    symbol: z.string(),
    intent: z.string()
  }).shape);

  register("prepare_patch", z.object({
    plan_id: z.string().optional(),
    message: z.string()
  }).shape);

  register("validate_patch", z.object({
    patch_path: z.string(),
    timeout_ms: z.number().optional().default(30000)
  }).shape);

  register("finalize_plan", z.object({
    plan_id: z.string(),
    outcome: z.string()
  }).shape);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error in Autognosis MCP Server:", error);
  process.exit(1);
});