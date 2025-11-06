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

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

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
  endpoints: {
    health: "/health",
    listTools: "/tools/list",
    callTool: "/tools/call"
  }
};

app.get("/", (_req, res) => res.json(meta));
app.post("/", (_req, res) => res.json(meta));

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
    tools: [
      {
        name: "apollo_search",
        description: "Search contacts in Apollo (people.search) with pagination.",
        parameters: SearchInputDescription,
        input_schema: SearchInputSchema
      },
      {
        name: "apollo_enrich",
        description: "Enrich a person by email / LinkedIn / Apollo ID (people.enrich).",
        parameters: EnrichInputDescription,
        input_schema: EnrichInputSchema
      }
    ]
  });
};

app.post("/tools/list", listTools);
app.get("/tools/list", listTools);

// 2) Invoke a tool
app.post("/tools/call", async (req, res) => {
  try {
    const { name, args } = req.body as { name: string; args: any };

    if (name === "apollo_search") {
      const input = SearchInput.parse(args);
      const payload: any = {
        // Apollo’s flexible search fields:
        q_keywords: input.query,               // free text
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
        total: data.total || list.length
      };

      return res.json({ ok: true, result: { count: list.length, paging, contacts: list } });
    }

    if (name === "apollo_enrich") {
      const input = EnrichInput.parse(args);
      const payload: any = {};
      if (input.email) payload.email = input.email;
      if (input.linkedin_url) payload.linkedin_url = input.linkedin_url;
      if (input.apollo_person_id) payload.id = input.apollo_person_id;

      const data = await apolloPost("/people/enrich", payload);
      const person = data.person || data;
      return res.json({ ok: true, result: { contact: simplifyPerson(person), raw: data } });
    }

    return res.status(400).json({ ok: false, error: `Unknown tool: ${name}` });
  } catch (err: any) {
    return res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`apollo-mcp listening on :${PORT}`);
});
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});
