import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import { getSetting, setSetting } from "./db/index.ts";
import { recordAdmin } from "./audit.ts";
import type { ChildSupervisor } from "./mcp/supervisor.ts";
import { logger } from "./log.ts";

const log = logger("updater");

const KEY_ADOPTED = "ado_mcp_adopted_version";
const KEY_LATEST = "ado_mcp_latest_version";
const KEY_CHECKED = "ado_mcp_checked_at";

/** The version of @azure-devops/mcp children are currently spawned with. */
export function adoptedVersion(db: Database, config: Config): string {
  return getSetting(db, KEY_ADOPTED) ?? config.adoMcpVersion;
}

export function setAdoptedVersion(db: Database, version: string) {
  setSetting(db, KEY_ADOPTED, version);
}

export interface UpstreamStatus {
  adopted: string;
  latest: string | null;
  checkedAt: number | null;
  updateAvailable: boolean;
}

export function upstreamStatus(db: Database, config: Config): UpstreamStatus {
  const adopted = adoptedVersion(db, config);
  const latest = getSetting(db, KEY_LATEST);
  const checkedRaw = getSetting(db, KEY_CHECKED);
  return {
    adopted,
    latest,
    checkedAt: checkedRaw ? Number(checkedRaw) : null,
    updateAvailable: !!latest && latest !== adopted && adopted !== "next",
  };
}

/**
 * Poll npm for the newest @azure-devops/mcp on the tracked dist-tag. Records the
 * result in settings; if ADO_MCP_AUTO_UPDATE is on and a newer version exists,
 * adopts it and recycles all upstream children so they respawn on the new version.
 */
export async function checkForUpdate(db: Database, config: Config, supervisor?: ChildSupervisor): Promise<string | null> {
  let latest: string | null = null;
  try {
    const res = await fetch("https://registry.npmjs.org/@azure-devops/mcp", {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
    const json = (await res.json()) as { "dist-tags"?: Record<string, string> };
    latest = json["dist-tags"]?.[config.adoMcpDistTag] ?? null;
  } catch (err) {
    log.warn(`update check failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
  if (!latest) return null;

  setSetting(db, KEY_LATEST, latest);
  setSetting(db, KEY_CHECKED, String(Math.floor(Date.now() / 1000)));

  const adopted = adoptedVersion(db, config);
  if (config.adoMcpAutoUpdate && latest !== adopted && adopted !== "next") {
    log.info(`auto-adopting @azure-devops/mcp ${adopted} → ${latest}`);
    setAdoptedVersion(db, latest);
    recordAdmin(db, null, "upstream.auto_update", { detail: `${adopted} → ${latest}` });
    await supervisor?.recycleAll();
  }
  return latest;
}

/** Manually adopt a version (from the dashboard) and recycle children. */
export async function adoptVersion(db: Database, version: string, supervisor?: ChildSupervisor) {
  setAdoptedVersion(db, version);
  recordAdmin(db, null, "upstream.adopt", { detail: version });
  await supervisor?.recycleAll();
}
