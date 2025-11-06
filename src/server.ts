import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const APOLLO_API_KEY = process.env.APOLLO_API_KEY!;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN!;

if (!APOLLO_API_KEY || !MCP_AUTH_TOKEN) {
  console.error("Missing APOLLO_API_KEY or MCP_AUTH_TOKEN in env");
  process.exit(1);
}

const PROTOCOL_VERSION = "2025-06-18";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use((req, _res, next) => {
  const auth =
    (req.headers.authorization as string | undefined) ||
    (req.headers["x-api-key"] as string | undefined) ||
    (req.query.access_token as string | undefined) ||
    "";
  let bodyPreview = "<empty>";
  try {
    if (typeof req.body === "string") {
      bodyPreview = req.body.slice(0, 160);
    } else if (req.body && typeof req.body === "object") {
      const clone: Record<string, unknown> = { ...req.body };
      if (clone.params && typeof clone.params === "object") {
        clone.params = { ...(clone.params as Record<string, unknown>) };
        if ("apiKey" in (clone.params as Record<string, unknown>)) {
          (clone.params as Record<string, unknown>).apiKey = "***";
        }
      }
      bodyPreview = JSON.stringify(clone).slice(0, 200);
    }
  } catch {
    bodyPreview = "[unserializable]";
  }
  const method =
    req.body && typeof req.body === "object" && "method" in req.body
      ? ` (${String((req.body as Record<string, unknown>).method)})`
      : "";
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path}${method} auth=${
      auth ? "***" : "none"
    } body=${bodyPreview}`
  );
  next();
});

// Simple auth for AgentKit → MCP (accepts Bearer or raw token/header)
app.use((req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const apiKeyHeader = (req.headers["x-api-key"] as string | undefined) || "";
  const prefixes = ["Bearer ", "Token ", "Apikey ", "Api-Key "];
  let tokenCandidate = authHeader.trim();
  for (const prefix of prefixes) {
    if (tokenCandidate.startsWith(prefix)) {
      tokenCandidate = tokenCandidate.slice(prefix.length).trim();
      break;
    }
  }

  if (!tokenCandidate && authHeader.includes(" ")) {
    const parts = authHeader.split(/\s+/);
    tokenCandidate = parts[parts.length - 1]?.trim() || "";
  }

  const provided =
    tokenCandidate ||
    apiKeyHeader.trim() ||
    (req.query.access_token as string | undefined) ||
    "";

  if (provided !== MCP_AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

// Health
app.get("/health", (_req, res) => res.json({ ok: true, service: "apollo-mcp" }));

// Root metadata so clients probing '/' don't get 404
const meta = {
  ok: true,
  service: "apollo-mcp",
  status: "ready",
  protocol: {
    name: "http+json",
    version: PROTOCOL_VERSION
  },
  endpoints: {
    health: "/health",
    listTools: "/tools/list",
    callTool: "/tools/call",
    rpc: "/"
  }
};

app.get("/", (_req, res) => res.json(meta));

/** ---------- Tool schemas ---------- */
const SearchInput = z.object({
  // loose free text
  query: z.string().optional(),
  // structured filters
  title: z.string().optional(),
  company: z.string().optional(),
  location: z.string().optional(),
  seniority_levels: z.array(z.string()).optional(), // e.g. ["cxo","vp","director"]
  page: z.number().int().min(1).default(1),
  per_page: z.number().int().min(1).max(200).default(25)
});

const SearchInputDescription = {
  query: "optional string - free text keywords",
  title: "optional string - job title filter",
  company: "optional string - company/organization name",
  location: "optional string - geo filter (city, state, country)",
  seniority_levels: 'optional string[] - Apollo seniority codes e.g. ["cxo","vp"]',
  page: "optional number - page number (default 1)",
  per_page: "optional number - results per page (1-200, default 25)"
};

const EnrichInput = z.object({
  email: z.string().email().optional(),
  linkedin_url: z.string().url().optional(),
  apollo_person_id: z.string().optional()
}).refine(
  (v) => !!(v.email || v.linkedin_url || v.apollo_person_id),
  { message: "Provide email, linkedin_url, or apollo_person_id" }
);

const EnrichInputDescription = {
  email: "optional string - person's email address",
  linkedin_url: "optional string - LinkedIn profile URL",
  apollo_person_id: "optional string - Apollo person id",
  required: "one of email, linkedin_url, or apollo_person_id must be provided"
};

const SearchInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Free text keywords" },
    title: { type: "string", description: "Job title filter" },
    company: { type: "string", description: "Company/organization name" },
    location: { type: "string", description: "Geo filter (city/state/country)" },
    seniority_levels: {
      type: "array",
      description: "Apollo seniority codes e.g. ['cxo','vp']",
      items: { type: "string" }
    },
    page: {
      type: "integer",
      minimum: 1,
      default: 1,
      description: "Page number (1-indexed)"
    },
    per_page: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 25,
      description: "Results per page"
    }
  }
};

const EnrichInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email", description: "Person email" },
    linkedin_url: { type: "string", format: "uri", description: "LinkedIn profile URL" },
    apollo_person_id: { type: "string", description: "Apollo person id" }
  },
  anyOf: [
    { required: ["email"] },
    { required: ["linkedin_url"] },
    { required: ["apollo_person_id"] }
  ],
  description: "Provide email, linkedin_url, or apollo_person_id"
};

type SearchInputType = z.infer<typeof SearchInput>;
type EnrichInputType = z.infer<typeof EnrichInput>;

async function runApolloSearch(input: SearchInputType) {
  const payload: Record<string, unknown> = {
    q_keywords: input.query,
    title: input.title,
    organization_name: input.company,
    location: input.location,
    seniority_levels: input.seniority_levels,
    page: input.page,
    per_page: input.per_page
  };

  const data = await apolloPost("/people/search", payload);
  const list = (data.people || data.contacts || []).map(simplifyPerson);
  const paging = data.pagination || {
    page: input.page,
    per_page: input.per_page,
    total_entries: data.total || list.length
  };

  return { count: list.length, paging, contacts: list };
}

async function runApolloEnrich(input: EnrichInputType) {
  const payload: Record<string, unknown> = {};
  if (input.email) payload.email = input.email;
  if (input.linkedin_url) payload.linkedin_url = input.linkedin_url;
  if (input.apollo_person_id) payload.id = input.apollo_person_id;

  const data = await apolloPost("/people/enrich", payload);
  const person = data.person || data;
  return { contact: simplifyPerson(person), raw: data };
}

interface ToolDefinition<T> {
  name: string;
  description: string;
  summary: Record<string, string>;
  schema: Record<string, unknown>;
  parse: (value: unknown) => T;
  run: (input: T) => Promise<unknown>;
}

const TOOL_DEFINITIONS: ToolDefinition<unknown>[] = [
  {
    name: "apollo_search",
    description: "Search contacts in Apollo (people.search) with pagination.",
    summary: SearchInputDescription,
    schema: SearchInputSchema,
    parse: (value) => SearchInput.parse(value),
    run: (input) => runApolloSearch(input as SearchInputType)
  },
  {
    name: "apollo_enrich",
    description: "Enrich a person by email / LinkedIn / Apollo ID (people.enrich).",
    summary: EnrichInputDescription,
    schema: EnrichInputSchema,
    parse: (value) => EnrichInput.parse(value),
    run: (input) => runApolloEnrich(input as EnrichInputType)
  }
];

const TOOL_MAP = new Map<string, ToolDefinition<unknown>>(
  TOOL_DEFINITIONS.map((tool) => [tool.name, tool])
);

/** ---------- Apollo helpers ---------- */
const APOLLO = "https://api.apollo.io/v1";

async function apolloPost(path: string, body: any) {
  const res = await fetch(`${APOLLO}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Api-Key": APOLLO_API_KEY
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Apollo ${res.status}: ${JSON.stringify(json).slice(0, 800)}`);
  }
  return json;
}

function simplifyPerson(p: any) {
  const name = p.name || [p.first_name, p.last_name].filter(Boolean).join(" ");
  return {
    id: p.id,
    name,
    title: p.title,
    company: p.organization?.name || p.employer || p.company,
    email: p.email || null,
    email_status: p.email_status,
    city: p.city || p.location_city,
    state: p.state || p.location_state,
    country: p.country || p.location_country,
    linkedin_url: p.linkedin_url
  };
}

/** ---------- Tools ---------- */

// 1) List tools for AgentKit
const listTools = (_req: express.Request, res: express.Response) => {
  res.json({
    ok: true,
    service: "apollo-mcp",
    version: "1.0.0",
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.summary,
      input_schema: tool.schema
    }))
  });
};

app.post("/tools/list", listTools);
app.get("/tools/list", listTools);

// 2) Invoke a tool
app.post("/tools/call", async (req, res) => {
  try {
    const { name, args } = req.body as { name: string; args: any };

    const tool = TOOL_MAP.get(name);
    if (!tool) {
      return res.status(400).json({ ok: false, error: `Unknown tool: ${name}` });
    }
    const input = tool.parse(args);
    const result = await tool.run(input);
    return res.json({ ok: true, result });
  } catch (err: any) {
    return res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

/** ---------- JSON-RPC bridge for AgentKit ---------- */
type JsonRpcId = string | number | null | undefined;
interface JsonRpcRequest {
  jsonrpc?: string;
  method?: string;
  params?: any;
  id?: JsonRpcId;
}

const SERVER_INFO = { name: "apollo-mcp", version: "1.0.0" };

function jsonRpcSuccess(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

async function handleJsonRpc(request: JsonRpcRequest) {
  const { method, params, id } = request;
  if (!method || typeof method !== "string") {
    return jsonRpcError(id, -32600, "Invalid request");
  }

  if (method === "initialize") {
    return jsonRpcSuccess(id, {
      serverInfo: SERVER_INFO,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {
          list: true,
          call: true
        }
      }
    });
  }

  if (method === "tools.list") {
    return jsonRpcSuccess(id, {
      tools: TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.schema,
        metadata: { summary: tool.summary }
      }))
    });
  }

  if (method === "tools.call") {
    const toolName =
      params?.name ||
      params?.tool?.name ||
      params?.identifier ||
      params?.toolName;
    const rawArgs = params?.arguments ?? params?.args ?? params?.toolInput ?? {};
    if (typeof toolName !== "string") {
      return jsonRpcError(id, -32602, "Missing tool name");
    }
    const tool = TOOL_MAP.get(toolName);
    if (!tool) {
      return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
    }
    try {
      const input = tool.parse(rawArgs);
      const result = await tool.run(input);
      return jsonRpcSuccess(id, {
        content: [
          {
            type: "json",
            json: {
              tool: toolName,
              result
            }
          }
        ]
      });
    } catch (err: any) {
      return jsonRpcError(
        id,
        -32602,
        err?.message || "Invalid tool arguments",
        err?.issues || err
      );
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

app.post("/", async (req, res) => {
  const body = req.body as JsonRpcRequest | undefined;
  if (!body || typeof body !== "object") {
    return res.status(400).json(jsonRpcError(null, -32600, "Invalid request body"));
  }
  try {
    const response = await handleJsonRpc(body);
    res.json(response);
  } catch (err: any) {
    res
      .status(500)
      .json(jsonRpcError(body.id, -32603, err?.message || "Internal error"));
  }
});

app.listen(PORT, () => {
  console.log(`apollo-mcp listening on :${PORT}`);
});
