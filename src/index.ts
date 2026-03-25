// @ts-nocheck
import express, { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import axios from 'axios';

const BASE_URL = process.env.CONFLUENCE_BASE_URL || 'https://confluence.example.com';
const CONFLUENCE_PAT = process.env.CONFLUENCE_PAT || '';
const MCP_API_KEY = process.env.MCP_API_KEY || '';

if (!CONFLUENCE_PAT) {
  console.warn('WARNING: CONFLUENCE_PAT is not set');
}
if (!MCP_API_KEY) {
  console.warn('WARNING: MCP_API_KEY is not set');
}

async function confluenceRequest(
  path: string,
  params?: Record<string, any>
) {
  if (!CONFLUENCE_PAT) {
    throw new Error('CONFLUENCE_PAT is not configured on the server');
  }
  const url = `${BASE_URL}${path}`;
  const response = await axios.get(url, {
    params,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${CONFLUENCE_PAT}`,
    },
  });
  return response.data;
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'confluence-mcp',
    version: '1.0.0',
  });

  server.tool(
    'confluence-search',
    'Search Confluence content via a raw CQL query. The caller must provide a complete, valid CQL string (e.g. text ~ "onboarding" AND space = "ENG" AND type = "page"). The tool returns a list of matching contents with id, url, type, title, spaceKey and excerpt.',
    {
      cql: z
        .string()
        .describe(
          'Full CQL query to execute, e.g. text ~ "onboarding" AND space = "ENG" AND type = "page".'
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max number of results.'),
    },
    async ({ cql, limit = 10 }) => {
      const data = await confluenceRequest('/rest/api/search', {
        cql,
        limit,
        expand: 'content.space,content.version',
      });

      const results = (data.results || []).map((r: any) => {
        const content = r.content || {};
        const id = content.id;
        const title = content.title;
        const type = content.type;
        const spaceKey = content.space?.key;
        const webui = content._links?.webui;
        const url = webui ? `${BASE_URL}${webui}` : undefined;
        const excerpt = r.excerpt;
        return { id, url, type, title, spaceKey, excerpt };
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    'confluence-get-page',
    'Get full Confluence page content by ID',
    {
      id: z.string().describe('Confluence content ID'),
    },
    async ({ id }) => {
      const data = await confluenceRequest(`/rest/api/content/${id}`, {
        expand: 'body.storage,space,version',
      });

      const title = data.title;
      const type = data.type;
      const spaceKey = data.space?.key;
      const webui = data._links?.webui;
      const url = webui ? `${BASE_URL}${webui}` : undefined;
      const html = data.body?.storage?.value || '';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id, title, type, spaceKey, url, bodyHtml: html }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'confluence-metadata',
    'Get Confluence metadata such as content types and sample spaces',
    {
      spacesLimit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('How many spaces to list'),
    },
    async ({ spacesLimit = 20 }) => {
      const spacesData = await confluenceRequest('/rest/api/space', {
        limit: spacesLimit,
      });

      const spaces = (spacesData.results || []).map((s: any) => ({
        key: s.key,
        name: s.name,
        type: s.type,
      }));

      const contentTypes = ['page', 'blogpost', 'attachment', 'comment'];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ contentTypes, spaces }, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

function apiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!MCP_API_KEY) {
    return res.status(500).json({ error: 'MCP_API_KEY is not configured on the server' });
  }
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const apiKey = req.header('x-api-key');
  const provided = bearer || apiKey;
  if (!provided || provided !== MCP_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.post('/mcp', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    res.on('close', () => transport.close());

    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Required by MCP Streamable HTTP spec
app.get('/mcp', (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method Not Allowed' },
      id: null,
    })
  );
});

app.delete('/mcp', (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method Not Allowed' },
      id: null,
    })
  );
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'confluence-mcp' });
});

app.listen(port, () => {
  console.log(`Confluence MCP server listening on port ${port} at /mcp`);
});