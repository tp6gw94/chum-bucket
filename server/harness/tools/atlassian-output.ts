import { z } from "zod";

const named = z.looseObject({ name: z.string().optional() });

const jiraUser = z.looseObject({
  display_name: z.string().optional(),
  email: z.string().optional(),
  account_id: z.string().optional(),
});

const jiraIssue = z.looseObject({
  id: z.string().optional(),
  key: z.string(),
  summary: z.string().optional(),
  description: z.string().nullable().optional(),
  status: named.extend({ category: z.string().optional() }).optional(),
  issue_type: named.optional(),
  priority: named.optional(),
  assignee: jiraUser.nullable().optional(),
  reporter: jiraUser.nullable().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  browse_url: z.string().optional(),
});

const jiraSearch = z.looseObject({
  total: z.number().optional(),
  start_at: z.number().optional(),
  max_results: z.number().optional(),
  issues: z.array(jiraIssue),
});

const confluencePage = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  type: z.string().optional(),
  url: z.string().nullable().optional(),
  space: z.looseObject({ key: z.string().optional(), name: z.string().optional() }).optional(),
  author: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  version: z.number().optional(),
  content: z.looseObject({ value: z.string().optional() }).optional(),
});

const confluenceComment = z.looseObject({
  id: z.string().optional(),
  body: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  author: z.string().optional(),
});

export const atlassianOutputSchemas = new Map<string, z.ZodType>([
  ["jira_get_issue", jiraIssue],
  ["jira_search", jiraSearch],
  ["confluence_search", z.array(confluencePage)],
  [
    "confluence_get_page",
    z.looseObject({
      metadata: confluencePage.optional(),
      content: z.looseObject({ value: z.string().optional() }).optional(),
      error: z.string().optional(),
    }),
  ],
  ["confluence_get_comments", z.array(confluenceComment)],
]);
