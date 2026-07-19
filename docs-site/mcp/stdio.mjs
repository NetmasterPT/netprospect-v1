// Servidor MCP (stdio) da base de conhecimento NetProspect — para os agentes (Claude Code, etc.).
// Configurar em .mcp.json:  { "mcpServers": { "netprospect-kb": { "command": "node",
//   "args": ["docs-site/mcp/stdio.mjs"], "env": { "OLLAMA_URL": "...", "QDRANT_URL": "..." } } } }
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { searchDocs, getDoc, listRelated } from './tools.mjs';

const server = new Server({ name: 'netprospect-kb', version: '1.0.0' }, { capabilities: { tools: {} } });

const TOOLS = [
  { name: 'search_docs', description: 'Busca semântica (RAG) na documentação NetProspect. Devolve os chunks mais relevantes com slug/título/score.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'get_doc', description: 'Texto completo de um doc pelo slug (ex.: "docs/reference/http-api", "docs/runbook-server-hel1").',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
  { name: 'list_related', description: 'Docs ligados (wikilinks in/out) a um dado slug — vizinhos no grafo de conhecimento.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  let result;
  if (name === 'search_docs') result = await searchDocs(a.query, a.limit);
  else if (name === 'get_doc') result = getDoc(a.slug);
  else if (name === 'list_related') result = listRelated(a.slug);
  else throw new Error(`tool desconhecido: ${name}`);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

await server.connect(new StdioServerTransport());
console.error('netprospect-kb MCP (stdio) pronto.');
