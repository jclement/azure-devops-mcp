import type { ChildSupervisor } from "./supervisor.ts";
import type { SpawnFactory } from "./upstream.ts";

/** The live MCP machinery shared between the /mcp endpoint and the UI's connection tester. */
export interface ProxyRuntime {
  supervisor: ChildSupervisor;
  spawnFactory: SpawnFactory;
  masterKey: Buffer;
  /** Currently-adopted @azure-devops/mcp version. */
  upstreamVersion: () => string;
}
