import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGateway } from './server.js';

// Runs the gateway over stdio until the client disconnects.
export async function runStdioGateway(opts) {
  const gateway = createGateway(opts);
  // The client closing stdin ends the session as well as an MCP close.
  const closed = new Promise((resolve) => {
    gateway.server.onclose = resolve;
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  await gateway.server.connect(new StdioServerTransport());
  await closed;
  await gateway.close();
}
