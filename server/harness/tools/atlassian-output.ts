import { convertSchemaToJsonSchema, type JSONSchema } from "@tanstack/ai";
import { z } from "zod";

const named = z.looseObject({ name: z.string().optional() }).nullish();

const issue = z.looseObject({
  key: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().nullish(),
  status: named,
  priority: named,
  issue_type: named,
  assignee: z.looseObject({ display_name: z.string().optional() }).nullish(),
  labels: z.array(z.string()).optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
});

const page = z.looseObject({
  id: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  content: z.looseObject({ value: z.string().optional() }).nullish(),
});

const searchResult = z.looseObject({
  total: z.number().optional(),
  issues: z.array(issue).optional(),
});

const outputs = new Map<string, z.ZodType>([
  ["jira_get_issue", issue],
  ["jira_search", searchResult],
  ["confluence_get_page", z.looseObject({ metadata: page.optional() })],
  [
    "confluence_search",
    z.union([z.array(page), z.looseObject({ results: z.array(page).optional() })]),
  ],
  [
    "confluence_get_comments",
    z.array(z.looseObject({ id: z.string().optional(), body: z.string().optional() })),
  ],
]);

export const atlassianOutputSchemas: ReadonlyMap<string, JSONSchema> = new Map(
  [...outputs].flatMap(([name, schema]) => {
    const converted = convertSchemaToJsonSchema(schema);

    return converted ? [[name, converted] as const] : [];
  }),
);
