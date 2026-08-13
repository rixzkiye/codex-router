import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
let threadId = "thr_fixture";
let turnId = "turn_fixture";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "fixture", codexHome: "/redacted", platformFamily: "unix", platformOs: "linux" } });
      break;
    case "initialized":
      break;
    case "account/rateLimits/read":
      send({ id: message.id, result: { rateLimits: { primary: { usedPercent: 1 } } } });
      break;
    case "thread/start":
      send({ id: message.id, result: { thread: { id: threadId } } });
      break;
    case "turn/start":
      send({ id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
      if (message.params.input?.some((item) => item.text?.includes("request numeric approval"))) {
        setTimeout(() => send({
          id: 7,
          method: "item/commandExecution/requestApproval",
          params: { threadId, turnId, command: "pnpm test" }
        }), 5);
      }
      break;
    case "turn/steer":
      send({ id: message.id, result: { turnId } });
      break;
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      setTimeout(() => send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } } }), 5);
      break;
    case "thread/read":
      send({ id: message.id, result: { thread: { id: threadId, status: { type: "active" }, turns: [{ id: turnId, status: "inProgress", items: [] }] } } });
      break;
    case "thread/list":
      send({ id: message.id, result: { data: [{ id: threadId, threadSource: "other" }], nextCursor: null } });
      break;
    default:
      if (message.id === 7 && message.result?.decision === "decline") {
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } } });
        break;
      }
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
  }
});
