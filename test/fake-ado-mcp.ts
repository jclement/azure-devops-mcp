/**
 * A tiny stdio MCP server used in tests in place of Microsoft's
 * `npx @azure-devops/mcp`. It exposes a `whoami` tool that reports the org it
 * was launched with and the tail of the PAT it received via PERSONAL_ACCESS_TOKEN.
 *
 * The isolation tests use this to prove that the child a user's request reaches
 * holds *that user's* PAT and no other.
 *
 * Launched as: bun test/fake-ado-mcp.ts <org>
 * with PERSONAL_ACCESS_TOKEN = base64("<email>:<pat>") in the environment.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const org = process.argv[2] ?? "unknown";

function decodePat(): { email: string; patTail: string } | null {
  const raw = process.env.PERSONAL_ACCESS_TOKEN;
  if (!raw) return null;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return { email: "", patTail: decoded.slice(-4) };
  return { email: decoded.slice(0, idx), patTail: decoded.slice(idx + 1).slice(-4) };
}

const server = new Server({ name: "fake-ado-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "whoami",
      description: "Report the org and PAT identity this child was launched with.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "echo",
      description: "Echo back the provided message.",
      inputSchema: { type: "object", properties: { message: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "whoami") {
    const pat = decodePat();
    return { content: [{ type: "text", text: JSON.stringify({ org, pat }) }] };
  }
  if (req.params.name === "echo") {
    return { content: [{ type: "text", text: String((req.params.arguments as { message?: string })?.message ?? "") }] };
  }
  return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
