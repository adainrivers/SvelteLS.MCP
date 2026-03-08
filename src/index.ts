import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LspClient } from "./lsp-client.js";
import { registerNavigationTools } from "./tools/navigation.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.js";
import { registerEditingTools } from "./tools/editing.js";
import { registerCodeActionTools } from "./tools/code-actions.js";
import { registerIntelliSenseTools } from "./tools/intellisense.js";
import { registerHierarchyTools } from "./tools/hierarchy.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerSvelteTools } from "./tools/svelte.js";
import { resolve } from "node:path";

async function main(): Promise<void> {
  // Parse project root from CLI args
  const projectRoot = process.argv[2]
    ? resolve(process.argv[2])
    : process.cwd();

  console.error(`[svelte-ls-mcp] Project root: ${projectRoot}`);

  // Create LSP client
  const lsp = new LspClient({ projectRoot });

  // Create MCP server
  const mcpServer = new McpServer({
    name: "svelte-ls",
    version: "1.0.0",
  });

  // Register all tools
  registerNavigationTools(mcpServer, lsp);
  registerDiagnosticsTools(mcpServer, lsp);
  registerEditingTools(mcpServer, lsp);
  registerCodeActionTools(mcpServer, lsp);
  registerIntelliSenseTools(mcpServer, lsp);
  registerHierarchyTools(mcpServer, lsp);
  registerLifecycleTools(mcpServer, lsp);
  registerSvelteTools(mcpServer, lsp);

  // Start LSP client (spawns svelteserver)
  await lsp.start();
  console.error("[svelte-ls-mcp] svelteserver started");

  // Connect MCP transport (stdio)
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("[svelte-ls-mcp] MCP server running on stdio");

  // Graceful shutdown
  const shutdown = async () => {
    console.error("[svelte-ls-mcp] shutting down...");
    await lsp.stop();
    await mcpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[svelte-ls-mcp] Fatal error:", error);
  process.exit(1);
});
