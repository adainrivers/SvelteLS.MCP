# SvelteLS.MCP

MCP server that wraps the Svelte Language Server, exposing its LSP capabilities as MCP tools for Claude Code.

## Architecture

```
Claude Code <--MCP/stdio--> SvelteLS.MCP <--LSP/stdio--> svelteserver
```

## Setup

```bash
npm install
npm run build
```

## Usage

```bash
node dist/index.js [path-to-svelte-project]
```

The project path is optional. If omitted, use the `load_project` tool at runtime to set it.

### Claude Code MCP config

#### Windows

```json
{
  "mcpServers": {
    "svelte-ls": {
      "command": "cmd",
      "args": ["/c", "node", "F:\\Shared\\SvelteLS.MCP\\dist\\index.js", "F:\\path\\to\\svelte\\project"]
    }
  }
}
```

#### macOS / Linux

```json
{
  "mcpServers": {
    "svelte-ls": {
      "command": "node",
      "args": ["/path/to/SvelteLS.MCP/dist/index.js", "/path/to/svelte/project"]
    }
  }
}
```

## Tools

### Navigation
- `find_definition` - Go to definition of a symbol
- `find_references` - Find all references to a symbol
- `get_hover` - Get hover documentation and type info
- `go_to_implementation` - Find implementations of an interface/abstract method
- `go_to_type_definition` - Jump to the type definition of a symbol
- `find_document_symbols` - List all symbols in a file
- `find_workspace_symbols` - Search symbols across the workspace

### Diagnostics
- `get_diagnostics` - Get errors, warnings, and diagnostics for a file

### Editing
- `rename_symbol` - Rename a symbol across the workspace
- `format_document` - Format a file or line range

### Code Actions
- `get_code_actions` - List available quick fixes and refactorings
- `apply_code_action` - Apply a code action by title

### IntelliSense
- `get_completion` - Get completion suggestions at a position
- `get_signature_help` - Get method signature overloads and parameter info

### Call Hierarchy
- `incoming_calls` - Find all callers of a function/method
- `outgoing_calls` - Find all calls from a function/method

### Lifecycle
- `load_project` - Load a Svelte project by its root directory
- `restart_lsp` - Restart the Svelte language server

### Svelte-specific
- `get_compiled_code` - Get compiled JS/CSS output for a Svelte component
- `get_component_references` - Find all usages of a Svelte component
- `get_file_references` - Find all files that import a given file

## Environment Variables

- `SVELTELS_TIMEOUT` - LSP request timeout in ms (default: 30000)
- `SVELTELS_SERVER_PATH` - Override path to the svelteserver entry script
