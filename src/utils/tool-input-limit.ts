import { classifyInboundRequest } from '@modelcontextprotocol/server';

export const MAX_TOOL_INPUT_ELEMENTS = 10_000;

interface ToolInputLimitRejection {
  id: string | number | null;
  message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exceedsElementLimit(value: unknown): boolean {
  let count = 0;
  const pending = [value];

  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      for (const child of node) {
        count += 1;
        if (count > MAX_TOOL_INPUT_ELEMENTS) return true;
        if (child !== null && typeof child === 'object') pending.push(child);
      }
      continue;
    }

    for (const key of Object.keys(node)) {
      count += 1;
      if (count > MAX_TOOL_INPUT_ELEMENTS) return true;
      const child = (node as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }

  return false;
}

function findToolInputLimitRejection(body: unknown): ToolInputLimitRejection | null {
  if (!isObject(body) || body.method !== 'tools/call' || !isObject(body.params)) return null;
  if (!exceedsElementLimit(body.params.arguments)) return null;

  const name = typeof body.params.name === 'string' ? body.params.name : 'unknown';
  return {
    id: typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null,
    message: `Invalid arguments for tool ${name}: arguments contain more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
  };
}

export function rejectOversizedToolInput(
  request: Request,
  body: unknown,
  protocolVersion: string,
): Response | null {
  const route = classifyInboundRequest({
    httpMethod: request.method,
    protocolVersionHeader: request.headers.get('mcp-protocol-version') ?? undefined,
    mcpMethodHeader: request.headers.get('mcp-method') ?? undefined,
    mcpNameHeader: request.headers.get('mcp-name') ?? undefined,
    body,
  });
  if (route.kind !== 'modern' || route.messageKind !== 'request'
    || route.classification.revision !== protocolVersion) return null;

  const rejection = findToolInputLimitRejection(route.message);
  if (!rejection) return null;

  const params = route.message.params as Record<string, unknown> | undefined;
  if (!request.headers.has('mcp-protocol-version') || !request.headers.has('mcp-method')
    || request.headers.get('mcp-name')?.trim() !== params?.name) return null;

  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32602, message: rejection.message },
    id: rejection.id,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
