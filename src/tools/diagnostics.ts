import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LspClient, pathToUri } from "../lsp-client.js";
import {
  prepareDocumentRequest,
  formatError,
  textResult,
  ToolResult,
} from "../tool-base.js";
import { basename } from "node:path";

export function registerDiagnosticsTools(
  server: McpServer,
  lsp: LspClient
): void {
  server.registerTool(
    "get_diagnostics",
    {
      title: "Get Diagnostics",
      description:
        "Get compiler errors, warnings, and diagnostics for a file. Opens the document to trigger computation if needed.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        minSeverity: z
          .string()
          .optional()
          .describe(
            "Minimum severity to include: error, warning, info, hint. Default: warning"
          ),
        waitMs: z
          .number()
          .optional()
          .describe(
            "How long to wait for diagnostics (ms). Default: 5000. Increase for large files."
          ),
      }),
    },
    async ({ filePath, minSeverity, waitMs }): Promise<ToolResult> => {
      try {
        const prep = await prepareDocumentRequest(lsp, filePath);
        if ("error" in prep) return textResult(prep.error);

        const diagnostics = await lsp.waitForDiagnostics(
          prep.uri,
          waitMs ?? 5000
        );

        if (!diagnostics || diagnostics.length === 0) {
          return textResult(
            `No diagnostics found in ${basename(filePath)}.`
          );
        }

        const minSev = parseSeverity(minSeverity);
        const lines: string[] = [];
        let count = 0;

        for (const diag of diagnostics) {
          const severity = diag.severity ?? 4;
          if (severity > minSev) continue;

          const sevLabel = severityLabel(severity);
          const line = (diag.range?.start?.line ?? 0) + 1;
          const code =
            typeof diag.code === "object"
              ? (diag.code as any)?.value?.toString() ?? ""
              : diag.code?.toString() ?? "";
          const message = diag.message ?? "";

          let entry = `  [${sevLabel}] ${basename(filePath)}:${line}`;
          if (code) entry += ` ${code}`;
          entry += `: ${message}`;
          lines.push(entry);
          count++;
        }

        if (count === 0) {
          return textResult(
            `No diagnostics at severity '${minSeverity ?? "warning"}' or above in ${basename(filePath)}.`
          );
        }

        return textResult(
          `Found ${count} diagnostic(s) in ${basename(filePath)}:\n\n` +
            lines.join("\n")
        );
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );
}

function parseSeverity(s?: string): number {
  switch (s?.toLowerCase()) {
    case "error":
      return 1;
    case "warning":
      return 2;
    case "info":
    case "information":
      return 3;
    case "hint":
      return 4;
    default:
      return 2; // warning
  }
}

function severityLabel(s: number): string {
  switch (s) {
    case 1:
      return "Error";
    case 2:
      return "Warning";
    case 3:
      return "Info";
    default:
      return "Hint";
  }
}
