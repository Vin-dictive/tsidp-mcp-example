import { buildApp } from "./app.js";

const port = Number(process.env.PORT || 9945);
const bind = process.env.BIND || "100.78.230.18";
if (!process.env.CALLER_TOKEN) {
  throw new Error("CALLER_TOKEN is not set");
}

const server = buildApp().listen(port, bind, () => {
  console.log(`Caller MCP listening on http://${bind}:${port}/mcp`);
});

server.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
