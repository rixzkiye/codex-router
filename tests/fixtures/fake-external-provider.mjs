import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const threadId = "external-thread";
let turnCounter = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: { capabilities: { steer: true, interrupt: true, resume: true, approvals: true } }
      });
      break;
    case "initialized":
      break;
    case "agent/start": {
      if (message.params.fencingToken !== 41 || message.params.worktree.mode !== "write") {
        send({ id: message.id, error: { code: -32602, message: "invalid start boundary" } });
        break;
      }
      const turnId = `external-turn-${++turnCounter}`;
      send({ id: message.id, result: { threadId, turnId, acceptedAt: new Date().toISOString() } });
      setTimeout(() => send({
        method: "event",
        params: {
          eventId: "external-command-1",
          type: "command_completed",
          threadId,
          turnId,
          payload: { command: "pnpm test", exitCode: 0, status: "completed" },
          occurredAt: new Date().toISOString()
        }
      }), 5);
      break;
    }
    case "agent/continue": {
      const turnId = `external-turn-${++turnCounter}`;
      send({ id: message.id, result: { threadId, turnId, acceptedAt: new Date().toISOString() } });
      break;
    }
    case "agent/steer":
    case "agent/respond":
      send({ id: message.id, result: {} });
      break;
    case "agent/interrupt":
      send({ id: message.id, result: {} });
      setTimeout(() => send({
        method: "event",
        params: {
          eventId: `external-completed-${message.params.turnId}`,
          type: "turn_completed",
          threadId,
          turnId: message.params.turnId,
          payload: { status: "interrupted", terminalReason: "cancelled" },
          occurredAt: new Date().toISOString()
        }
      }), 5);
      break;
    case "agent/reconcile":
      send({
        id: message.id,
        result: {
          state: "active",
          turnId: message.params.knownTurnId,
          evidence: { source: "fixture" }
        }
      });
      break;
    case "agent/find":
      send({ id: message.id, result: { threadId } });
      break;
    case "agent/terminals":
      send({ id: message.id, result: { clean: true, terminals: [] } });
      break;
    default:
      if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
      }
  }
});
