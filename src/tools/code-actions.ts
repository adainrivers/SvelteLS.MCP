import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LspClient } from "../lsp-client.js";
import {
  prepareDocumentRequest,
  formatWorkspaceEdit,
  applyWorkspaceEdit,
  formatError,
  textResult,
  ToolResult,
} from "../tool-base.js";

export function registerCodeActionTools(
  server: McpServer,
  lsp: LspClient
): void {
  server.registerTool(
    "get_code_actions",
    {
      title: "Get Code Actions",
      description:
        "List available code actions (quick fixes, refactorings) for a line or range in a file.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        startLine: z.number().describe("Start line (1-based)"),
        endLine: z
          .number()
          .optional()
          .describe("End line (1-based). Defaults to startLine"),
        kind: z
          .string()
          .optional()
          .describe(
            "Filter by kind: quickfix, refactor, refactor.extract, refactor.inline, refactor.rewrite, source, source.organizeImports, source.fixAll"
          ),
      }),
    },
    async ({ filePath, startLine, endLine, kind }): Promise<ToolResult> => {
      try {
        const { actions, error } = await fetchCodeActions(
          lsp,
          filePath,
          startLine,
          endLine,
          kind
        );
        if (error) return textResult(error);
        if (!actions || actions.length === 0) {
          return textResult(
            `No code actions available at line ${startLine}` +
              (kind ? ` (kind: ${kind})` : "") +
              "."
          );
        }

        const lines: string[] = [
          `Found ${actions.length} code action(s) at line ${startLine}` +
            (endLine != null && endLine !== startLine
              ? `-${endLine}`
              : "") +
            ":",
          "",
        ];

        for (let i = 0; i < actions.length; i++) {
          const action = actions[i];
          const title = action.title ?? "?";
          const actionKind = action.kind ?? "";
          const isPreferred = action.isPreferred === true;
          const disabled = action.disabled?.reason;

          let entry = `  ${i + 1}. ${title}`;
          if (actionKind) entry += ` [${actionKind}]`;
          if (isPreferred) entry += " (preferred)";
          if (disabled) entry += ` (disabled: ${disabled})`;
          lines.push(entry);
        }

        return textResult(lines.join("\n"));
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );

  server.registerTool(
    "apply_code_action",
    {
      title: "Apply Code Action",
      description:
        "Apply a code action (quick fix, refactoring) by its title. Use get_code_actions first to see available actions.",
      inputSchema: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        startLine: z.number().describe("Start line (1-based)"),
        actionTitle: z
          .string()
          .describe(
            "Title of the code action to apply (case-insensitive partial match)"
          ),
        endLine: z.number().optional().describe("End line (1-based)"),
        kind: z
          .string()
          .optional()
          .describe("Filter by kind: quickfix, refactor, etc."),
      }),
    },
    async ({
      filePath,
      startLine,
      actionTitle,
      endLine,
      kind,
    }): Promise<ToolResult> => {
      try {
        const { actions, error } = await fetchCodeActions(
          lsp,
          filePath,
          startLine,
          endLine,
          kind
        );
        if (error) return textResult(error);
        if (!actions) return textResult("No code actions available.");

        // Find matching action by partial title
        let match = actions.find((a: any) =>
          (a.title ?? "")
            .toLowerCase()
            .includes(actionTitle.toLowerCase())
        );

        // Exact match fallback
        if (!match) {
          match = actions.find(
            (a: any) =>
              (a.title ?? "").toLowerCase() === actionTitle.toLowerCase()
          );
        }

        if (!match) {
          return textResult(
            `No code action matching '${actionTitle}' found. Use get_code_actions to see available actions.`
          );
        }

        if (match.disabled) {
          return textResult(
            `Code action '${match.title}' is disabled: ${match.disabled.reason}.`
          );
        }

        // If action has a direct edit, use it. Otherwise resolve.
        let edit = match.edit;
        if (!edit) {
          const resolved = await lsp.request("codeAction/resolve", match);
          if (!resolved) {
            return textResult(
              `Failed to resolve code action '${match.title}'.`
            );
          }
          edit = resolved.edit;
        }

        if (!edit) {
          if (match.command) {
            return textResult(
              `Code action '${match.title}' requires command execution which is not supported.`
            );
          }
          return textResult(
            `Code action '${match.title}' returned no edits.`
          );
        }

        const matchTitle = match.title ?? actionTitle;
        const applied = await applyWorkspaceEdit(lsp, edit);
        const summary = formatWorkspaceEdit(edit, `Applied '${matchTitle}'`);
        return textResult(
          applied
            ? summary
            : `(dry-run, edits NOT applied)\n\n${summary}`
        );
      } catch (ex) {
        return textResult(formatError(ex));
      }
    }
  );
}

async function fetchCodeActions(
  lsp: LspClient,
  filePath: string,
  startLine: number,
  endLine?: number,
  kind?: string
): Promise<{ actions?: any[]; error?: string }> {
  const prep = await prepareDocumentRequest(lsp, filePath);
  if ("error" in prep) return { error: prep.error };

  // Fetch diagnostics from cache for context
  const cachedDiags = lsp.getCachedDiagnostics(prep.uri);
  const sl = startLine - 1;
  const el = (endLine ?? startLine) - 1;

  const diagnosticsForRange = cachedDiags.filter((d: any) => {
    const diagStart = d.range?.start?.line ?? -1;
    const diagEnd = d.range?.end?.line ?? -1;
    return diagEnd >= sl && diagStart <= el;
  });

  const context: any = { diagnostics: diagnosticsForRange };
  if (kind) context.only = [kind];

  const result = await lsp.request("textDocument/codeAction", {
    textDocument: { uri: prep.uri },
    range: {
      start: { line: sl, character: 0 },
      end: { line: el + 1, character: 0 },
    },
    context,
  });

  return { actions: Array.isArray(result) ? result : [] };
}
