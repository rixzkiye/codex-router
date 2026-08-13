import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { commandFailure, systemCommandRunner, type CommandRunner } from "./command.js";
import type { ManagedPaths } from "./paths.js";

export type SupportedServiceHost = "linux" | "darwin" | "win32";

export interface ServiceLaunch {
  readonly host: SupportedServiceHost;
  readonly nodeExecutable: string;
  readonly entryScript: string;
  readonly configPath: string;
  readonly controlTokenFile: string;
  readonly port: number;
  readonly startAtLogin: boolean;
}

export interface ManagedServiceStatus {
  readonly state: "running" | "stopped" | "missing" | "attention";
  readonly installed: boolean;
  readonly running: boolean;
  readonly startAtLogin: boolean;
  readonly message: string;
}

export interface ServiceDefinition {
  readonly content: string;
  readonly startCommand: readonly string[];
  readonly stopCommand: readonly string[];
  readonly restartCommand: readonly string[];
  readonly statusCommand: readonly string[];
}

export class UserServiceManager {
  constructor(
    readonly paths: ManagedPaths,
    readonly launch: ServiceLaunch,
    private readonly runner: CommandRunner = systemCommandRunner
  ) {}

  definition(): ServiceDefinition {
    return renderUserService(this.paths, this.launch);
  }

  async install(): Promise<void> {
    const definition = this.definition();
    await mkdir(path.dirname(this.paths.serviceFile), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(this.paths.logFile), { recursive: true, mode: 0o700 });
    await writeFile(this.paths.serviceFile, definition.content, { mode: 0o600 });
    await chmod(this.paths.serviceFile, 0o600);
    if (this.launch.host === "linux") {
      await this.mustRun("systemctl", ["--user", "daemon-reload"]);
      const preference = this.launch.startAtLogin ? "enable" : "disable";
      const result = await this.runner.run("systemctl", ["--user", preference, "codex-router.service"]);
      if (result.code !== 0 && !(!this.launch.startAtLogin && /not loaded|does not exist|not found/i.test(`${result.stderr}\n${result.stdout}`))) {
        throw commandFailure("systemctl", ["--user", preference, "codex-router.service"], result);
      }
    } else if (this.launch.host === "win32") {
      await this.mustRun("schtasks.exe", ["/Create", "/TN", "Codex Router", "/XML", this.paths.serviceFile, "/F"]);
    }
  }

  async status(): Promise<ManagedServiceStatus> {
    if (!(await exists(this.paths.serviceFile))) {
      return { state: "missing", installed: false, running: false, startAtLogin: false, message: "The managed user service is not installed." };
    }
    const definition = this.definition();
    const [status, content] = await Promise.all([
      this.runner.run(definition.statusCommand[0]!, definition.statusCommand.slice(1)),
      readFile(this.paths.serviceFile, "utf8")
    ]);
    const running = status.code === 0;
    let startAtLogin = this.launch.startAtLogin;
    if (this.launch.host === "linux") {
      const enabled = await this.runner.run("systemctl", ["--user", "is-enabled", "codex-router.service"]);
      startAtLogin = enabled.code === 0 && enabled.stdout.trim() === "enabled";
    } else if (this.launch.host === "darwin") {
      startAtLogin = content.includes("<key>RunAtLoad</key><true/>");
    } else {
      startAtLogin = content.includes("<LogonTrigger>");
    }
    const expected = content === definition.content;
    if (!expected) {
      return { state: "attention", installed: true, running, startAtLogin, message: "The managed service definition drifted from the setup manifest." };
    }
    if (!running && !isStoppedStatus(this.launch.host, status)) {
      return {
        state: "attention",
        installed: true,
        running: false,
        startAtLogin,
        message: `The user service manager could not verify Codex Router: ${status.stderr.trim() || status.stdout.trim() || `exit ${status.code}`}`
      };
    }
    return {
      state: running ? "running" : "stopped",
      installed: true,
      running,
      startAtLogin,
      message: running ? "The current-user Codex Router service is running." : "The current-user Codex Router service is installed but stopped."
    };
  }

  async start(options: { startAtLogin?: boolean } = {}): Promise<void> {
    const definition = this.definition();
    if (this.launch.host === "darwin" && (await this.status()).running) return;
    if (this.launch.host === "linux" && options.startAtLogin) {
      await this.mustRun("systemctl", ["--user", "enable", "--now", "codex-router.service"]);
      return;
    }
    const result = await this.runner.run(definition.startCommand[0]!, definition.startCommand.slice(1));
    if (result.code !== 0) throw commandFailure(definition.startCommand[0]!, definition.startCommand.slice(1), result);
  }

  async stop(): Promise<void> {
    const definition = this.definition();
    const result = await this.runner.run(definition.stopCommand[0]!, definition.stopCommand.slice(1));
    if (result.code !== 0 && !isAlreadyStopped(this.launch.host, `${result.stderr}\n${result.stdout}`)) {
      throw commandFailure(definition.stopCommand[0]!, definition.stopCommand.slice(1), result);
    }
  }

  async restart(): Promise<void> {
    const definition = this.definition();
    if (this.launch.host === "win32") await this.stop();
    if (this.launch.host === "darwin" && !(await this.status()).running) {
      await this.start();
      return;
    }
    await this.mustRun(definition.restartCommand[0]!, definition.restartCommand.slice(1));
  }

  async uninstall(): Promise<void> {
    await this.stop();
    if (this.launch.host === "linux") {
      await this.runner.run("systemctl", ["--user", "disable", "codex-router.service"]);
    } else if (this.launch.host === "win32") {
      const result = await this.runner.run("schtasks.exe", ["/Delete", "/TN", "Codex Router", "/F"]);
      if (result.code !== 0 && !/cannot find|does not exist/i.test(`${result.stderr}\n${result.stdout}`)) {
        throw commandFailure("schtasks.exe", ["/Delete", "/TN", "Codex Router", "/F"], result);
      }
    }
    await rm(this.paths.serviceFile, { force: true });
    if (this.launch.host === "linux") await this.mustRun("systemctl", ["--user", "daemon-reload"]);
  }

  logsCommand(follow: boolean): { command: string; args: string[] } {
    if (this.launch.host === "win32") {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-Command", `Get-Content -LiteralPath '${this.paths.logFile.replaceAll("'", "''")}' -Tail 200${follow ? " -Wait" : ""}`]
      };
    }
    return { command: "tail", args: ["-n", "200", ...(follow ? ["-f"] : []), this.paths.logFile] };
  }

  private async mustRun(command: string, args: readonly string[]): Promise<void> {
    const result = await this.runner.run(command, args);
    if (result.code !== 0) throw commandFailure(command, args, result);
  }
}

export function renderUserService(paths: ManagedPaths, launch: ServiceLaunch): ServiceDefinition {
  const webArgs = [
    launch.entryScript,
    "web",
    "--config", launch.configPath,
    "--host", "127.0.0.1",
    "--port", String(launch.port),
    "--control-token-file", launch.controlTokenFile,
    "--log-file", paths.logFile
  ];
  if (launch.host === "linux") {
    return {
      content: [
        "[Unit]",
        "Description=Codex Router",
        "After=network-online.target",
        "",
        "[Service]",
        `ExecStart=${systemdCommand([launch.nodeExecutable, ...webArgs])}`,
        `WorkingDirectory=${systemdQuote(paths.stateRoot)}`,
        "Restart=on-failure",
        "RestartSec=3",
        "NoNewPrivileges=true",
        "PrivateTmp=true",
        "",
        "[Install]",
        "WantedBy=default.target",
        ""
      ].join("\n"),
      startCommand: ["systemctl", "--user", "start", "codex-router.service"],
      stopCommand: ["systemctl", "--user", "stop", "codex-router.service"],
      restartCommand: ["systemctl", "--user", "restart", "codex-router.service"],
      statusCommand: ["systemctl", "--user", "is-active", "codex-router.service"]
    };
  }
  if (launch.host === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    const label = `${domain}/com.rixzkiye.codex-router`;
    return {
      content: [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "<plist version=\"1.0\"><dict>",
        "<key>Label</key><string>com.rixzkiye.codex-router</string>",
        `<key>ProgramArguments</key><array>${[launch.nodeExecutable, ...webArgs].map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>`,
        `<key>WorkingDirectory</key><string>${xml(paths.stateRoot)}</string>`,
        `<key>StandardOutPath</key><string>${xml(paths.logFile)}</string>`,
        `<key>StandardErrorPath</key><string>${xml(paths.logFile)}</string>`,
        `<key>RunAtLoad</key>${launch.startAtLogin ? "<true/>" : "<false/>"}`,
        "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        "</dict></plist>",
        ""
      ].join("\n"),
      startCommand: ["launchctl", "bootstrap", domain, paths.serviceFile],
      stopCommand: ["launchctl", "bootout", label],
      restartCommand: ["launchctl", "kickstart", "-k", label],
      statusCommand: ["launchctl", "print", label]
    };
  }
  const logonTrigger = launch.startAtLogin ? "<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>" : "<Triggers/>";
  return {
    content: [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
      logonTrigger,
      "<Principals><Principal id=\"Author\"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
      `<Actions Context=\"Author\"><Exec><Command>${xml(launch.nodeExecutable)}</Command><Arguments>${xml(webArgs.map(windowsArg).join(" "))}</Arguments><WorkingDirectory>${xml(paths.stateRoot)}</WorkingDirectory></Exec></Actions>`,
      "<Settings><AllowStartOnDemand>true</AllowStartOnDemand><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT3S</Interval><Count>3</Count></RestartOnFailure></Settings>",
      "</Task>",
      ""
    ].join("\n"),
    startCommand: ["schtasks.exe", "/Run", "/TN", "Codex Router"],
    stopCommand: ["schtasks.exe", "/End", "/TN", "Codex Router"],
    restartCommand: ["schtasks.exe", "/Run", "/TN", "Codex Router"],
    statusCommand: [
      "powershell.exe",
      "-NoProfile",
      "-Command",
      "try { if ((Get-ScheduledTask -TaskName 'Codex Router' -ErrorAction Stop).State -eq 'Running') { exit 0 } else { exit 3 } } catch { exit 4 }"
    ]
  };
}

function systemdCommand(args: readonly string[]): string {
  return args.map(systemdQuote).join(" ");
}

function systemdQuote(value: string): string {
  if (/\r|\n/.test(value)) throw new Error("Service arguments cannot contain newlines");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function windowsArg(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
}

function isAlreadyStopped(host: SupportedServiceHost, output: string): boolean {
  if (host === "linux") return /not loaded|inactive|not found/i.test(output);
  if (host === "darwin") return /could not find service|no such process/i.test(output);
  return /not currently running|cannot find|does not exist/i.test(output);
}

function isStoppedStatus(host: SupportedServiceHost, result: { code: number; stdout: string; stderr: string }): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  if (host === "linux") return result.code === 3 || /\b(inactive|failed)\b/i.test(output);
  if (host === "darwin") return isAlreadyStopped(host, output);
  return result.code === 3;
}
