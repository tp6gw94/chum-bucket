import { z } from "zod";

const jiraUser = z.looseObject({
  account_id: z.string().optional(),
  display_name: z.string(),
  email: z.string().optional(),
});

const jiraIssue = z.looseObject({
  id: z.string(),
  key: z.string(),
  summary: z.string().optional(),
  browse_url: z.string().optional(),
  description: z.string().nullable().optional(),
  status: z.looseObject({ name: z.string(), category: z.string().optional() }).optional(),
  issue_type: z.looseObject({ name: z.string() }).optional(),
  priority: z.looseObject({ name: z.string() }).optional(),
  assignee: jiraUser.nullable().optional(),
  reporter: jiraUser.nullable().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  comments: z
    .array(
      z.looseObject({
        id: z.string(),
        body: z.string(),
        author: jiraUser.optional(),
        created: z.string().optional(),
      }),
    )
    .optional(),
});

const confluencePage = z.looseObject({
  id: z.string(),
  title: z.string(),
  type: z.string().optional(),
  url: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  author: z.string().optional(),
  version: z.number().optional(),
  space: z.looseObject({ key: z.string(), name: z.string().optional() }).optional(),
  content: z.looseObject({ value: z.string(), format: z.string().optional() }).optional(),
});

export const atlassianOutputSchemas: ReadonlyMap<string, z.ZodType> = new Map<string, z.ZodType>([
  ["jira_get_issue", jiraIssue],
  [
    "jira_search",
    z.looseObject({
      total: z.number(),
      start_at: z.number().optional(),
      max_results: z.number().optional(),
      issues: z.array(jiraIssue),
      next_page_token: z.string().optional(),
    }),
  ],
  ["confluence_get_page", z.looseObject({ metadata: confluencePage })],
  ["confluence_search", z.array(confluencePage)],
  ["confluence_get_comments", z.array(z.looseObject({ id: z.string() }))],
]);
