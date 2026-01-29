import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { systemTools } from "./system-tools.js";

async function main() {
  const server = new McpServer({
    name: "opencode-autognosis",
    version: "0.1.3",
  });

  const tools = systemTools();

  // Helper to wrap our existing tool execution into MCP format
  const wrapTool = (toolName: string, zodSchema: any) => {
    server.registerTool(
      toolName,
      {
        description: (tools as any)[toolName].description,
        inputSchema: zodSchema,
      },
      async (args: any) => {
        try {
          const result = await (tools as any)[toolName].execute(args);
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

  // Register tools with proper Zod schemas
  wrapTool("autognosis_init", z.object({
    mode: z.enum(["plan", "apply"]).optional().default("plan"),
    token: z.string().optional()
  }).shape);

  wrapTool("fast_search", z.object({
    query: z.string(),
    mode: z.enum(["filename", "content"]).optional().default("filename"),
    path: z.string().optional()
  }).shape);

  wrapTool("structural_search", z.object({
    pattern: z.string(),
    path: z.string().optional(),
    plan_id: z.string().optional()
  }).shape);

  wrapTool("read_slice", z.object({
    file: z.string(),
    start_line: z.number(),
    end_line: z.number(),
    plan_id: z.string().optional()
  }).shape);

  wrapTool("symbol_query", z.object({
    symbol: z.string()
  }).shape);

  wrapTool("jump_to_symbol", z.object({
    symbol: z.string(),
    plan_id: z.string().optional()
  }).shape);

  wrapTool("brief_fix_loop", z.object({
    symbol: z.string(),
    intent: z.string()
  }).shape);

  wrapTool("prepare_patch", z.object({
    plan_id: z.string().optional(),
    message: z.string()
  }).shape);

  wrapTool("validate_patch", z.object({
    patch_path: z.string(),
    timeout_ms: z.number().optional()
  }).shape);

  wrapTool("finalize_plan", z.object({
    plan_id: z.string(),
    outcome: z.string()
  }).shape);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Autognosis MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
