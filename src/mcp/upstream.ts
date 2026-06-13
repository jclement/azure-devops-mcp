import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ConnectionRow } from "../connections/store.ts";

export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Builds the stdio spawn spec for one connection's Microsoft `@azure-devops/mcp`
 * child. The decrypted PAT is injected ONLY into this child's environment, as
 * base64("<email>:<pat>") in PERSONAL_ACCESS_TOKEN (the format the upstream
 * server's `--authentication pat` mode expects). It is never logged or shared
 * with any other connection's child.
 */
export type SpawnFactory = (conn: ConnectionRow, pat: string) => SpawnSpec;

export interface UpstreamOptions {
  /** Resolves the currently-adopted @azure-devops/mcp version (updater can change it). */
  version: () => string;
  /** Override the launcher (tests point this at a fake stdio MCP server). */
  command?: string;
  /** Extra leading args before the package spec (tests use this for the fake server path). */
  argsPrefix?: string[];
  /** When true, skip the npx package spec entirely (used with a custom command). */
  bare?: boolean;
}

export function defaultSpawnFactory(opts: UpstreamOptions): SpawnFactory {
  return (conn, pat) => {
    const command = opts.command ?? process.env.ADO_MCP_COMMAND ?? "npx";
    const args: string[] = [...(opts.argsPrefix ?? [])];
    if (!opts.bare) {
      args.push("-y", `@azure-devops/mcp@${opts.version()}`, conn.org, "--authentication", "pat");
      // Optional toolset filter to keep the advertised tool count manageable.
      // The exact flag is upstream-versioned; change it here if it drifts.
      if (conn.domains) args.push("--domains", conn.domains);
    }
    const env: Record<string, string> = {
      ...getDefaultEnvironment(),
      PERSONAL_ACCESS_TOKEN: Buffer.from(`${conn.email_label}:${pat}`).toString("base64"),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    return { command, args, env };
  };
}
