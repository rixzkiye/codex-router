import os from "node:os";
import path from "node:path";

export interface ManagedPaths {
  readonly configRoot: string;
  readonly configFile: string;
  readonly stateRoot: string;
  readonly databaseFile: string;
  readonly manifestFile: string;
  readonly mcpManifestFile: string;
  readonly controlTokenFile: string;
  readonly serviceFile: string;
  readonly logFile: string;
}

export interface ManagedPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export function managedPaths(options: ManagedPathOptions = {}): ManagedPaths {
  const platform = options.platform ?? process.platform;
  const home = path.resolve(options.home ?? os.homedir());
  const env = options.env ?? process.env;

  if (platform === "darwin") {
    const configRoot = path.join(home, "Library", "Application Support", "codex-router");
    const stateRoot = configRoot;
    return finish(configRoot, stateRoot, path.join(home, "Library", "LaunchAgents", "com.rixzkiye.codex-router.plist"), path.join(home, "Library", "Logs", "codex-router", "router.log"));
  }

  if (platform === "win32") {
    const configRoot = path.resolve(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "codex-router");
    const stateRoot = path.resolve(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "codex-router");
    return finish(configRoot, stateRoot, path.join(stateRoot, "services", "codex-router-task.xml"), path.join(stateRoot, "logs", "router.log"));
  }

  const configRoot = path.resolve(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "codex-router");
  const stateRoot = path.resolve(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "codex-router");
  return finish(configRoot, stateRoot, path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "systemd", "user", "codex-router.service"), path.join(stateRoot, "logs", "router.log"));
}

function finish(configRoot: string, stateRoot: string, serviceFile: string, logFile: string): ManagedPaths {
  return {
    configRoot,
    configFile: path.join(configRoot, "config.json"),
    stateRoot,
    databaseFile: path.join(stateRoot, "router.sqlite"),
    manifestFile: path.join(stateRoot, "setup-manifest.json"),
    mcpManifestFile: path.join(stateRoot, "mcp-manifest.json"),
    controlTokenFile: path.join(stateRoot, "control-token"),
    serviceFile,
    logFile
  };
}
