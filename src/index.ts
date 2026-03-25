// @ts-nocheck
import express, { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

const server = new McpServer({
  name: 'confluence-mcp',
  version: '1.0.0',
});

// регистрируем инструменты и храним их в своем registry
type ToolImpl = (args: any) => Promise<any>;

const toolRegistry = new Map<string, ToolImpl>();

function registerTool(
  name: string,
  description: string,
  schema: any,
  impl: ToolImpl
) {
  server.tool(name, description, schema, impl);
  toolRegistry.set(name, impl);
}

registerTool(
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

      return {
        id,
        url,
        type,
        title,
        spaceKey,
        excerpt,
      };
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }
);


registerTool(
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

    const result = {
      id,
      title,
      type,
      spaceKey,
      url,
      bodyHtml: html,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

registerTool(
  'confluence-metadata',
  'Get Confluence metadata such as content types and sample spaces',
  {
    spacesLimit: z.number().int().min(1).max(100).optional()
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

    const result = {
      contentTypes,
      spaces,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// === Streamable HTTP MCP сервер с API-key авторизацией ===

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const app = express();
app.use(express.json());

function apiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!MCP_API_KEY) {
    return res.status(500).json({ error: 'MCP_API_KEY is not configured on the server' });
  }
  const key = req.header('x-api-key') || req.header('X-API-Key');
  if (!key || key !== MCP_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

async function main() {
  const transport = new StreamableHTTPServerTransport({
    // без path/app — SDK сам реализует MCP протокол
  });

  await server.connect(transport);

  // MCP endpoint — полностью передаём запрос в транспорт
  app.post('/mcp', apiKeyMiddleware, async (req: Request, res: Response) => {
    try {
      // очень важно: не менять Accept/Content-Type вручную, Notion сам их задаёт
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // health‑endpoint для проверки
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'confluence-mcp' });
  });

  app.listen(port, () => {
    console.log(`Confluence MCP server listening on port ${port} at /mcp`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
