import { convertSchemaToJsonSchema, type JSONSchema } from "@tanstack/ai";
import { z } from "zod";

const optionalText = z.string().nullable().optional();
const record = z.record(z.string(), z.unknown());

const jiraUser = z.looseObject({
  account_id: optionalText,
  display_name: z.string(),
  name: optionalText,
  email: optionalText,
  avatar_url: optionalText,
  key: z.string().optional(),
});
const jiraNamed = z.looseObject({ name: z.string(), id: z.string().optional() });
const jiraStatus = z.looseObject({
  name: z.string(),
  category: z.string().optional(),
  color: z.string().optional(),
});
const jiraComment = z.looseObject({
  id: z.string(),
  body: z.string(),
  author: jiraUser.optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
});
const jiraAttachment = z.looseObject({
  filename: z.string(),
  size: z.number(),
  url: z.string().nullable(),
  content_type: z.string().optional(),
  author: jiraUser.optional(),
});
const jiraLinkedIssue = z.looseObject({
  id: z.string(),
  key: z.string(),
  fields: z
    .looseObject({
      summary: z.string(),
      status: jiraStatus.optional(),
      priority: jiraNamed.optional(),
      issuetype: jiraNamed.optional(),
    })
    .optional(),
});
const jiraIssueLink = z.looseObject({
  id: z.string(),
  type: z.looseObject({ name: z.string(), inward: z.string(), outward: z.string() }).optional(),
  inward_issue: jiraLinkedIssue.optional(),
  outward_issue: jiraLinkedIssue.optional(),
});
const jiraIssue = z.looseObject({
  id: z.string(),
  key: z.string(),
  summary: z.string().optional(),
  url: z.string().optional(),
  browse_url: z.string().optional(),
  description: z.string().optional(),
  status: jiraStatus.optional(),
  issue_type: jiraNamed.optional(),
  priority: jiraNamed.optional(),
  project: z.looseObject({ key: z.string(), name: z.string() }).optional(),
  resolution: jiraNamed.optional(),
  duedate: z.string().optional(),
  resolutiondate: z.string().optional(),
  parent: record.optional(),
  subtasks: z.array(record).optional(),
  assignee: jiraUser.optional(),
  reporter: jiraUser.optional(),
  labels: z.array(z.string()).optional(),
  components: z.array(z.string()).optional(),
  fix_versions: z.array(z.string()).optional(),
  versions: z.array(z.string()).optional(),
  epic_key: z.string().optional(),
  epic_name: z.string().optional(),
  timetracking: record.optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  comments: z.array(jiraComment).optional(),
  attachments: z.array(jiraAttachment).optional(),
  issuelinks: z.array(jiraIssueLink).optional(),
});

const confluenceAttachment = z.looseObject({
  id: z.string().nullable(),
  type: z.string().nullable(),
  status: z.string().nullable(),
  title: z.string().nullable(),
  media_type: z.string().nullable(),
  file_size: z.number().nullable(),
  download_url: z.string().optional(),
  created: z.string().optional(),
  author_display_name: z.string().optional(),
});
const confluencePage = z.looseObject({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  created: z.string(),
  updated: z.string(),
  url: z.string().nullable(),
  subtype: z.string().optional(),
  space: z.looseObject({ key: z.string(), name: z.string() }).optional(),
  author: z.string().optional(),
  version: z.number().optional(),
  attachments: z.array(confluenceAttachment),
  content: z.looseObject({ value: z.string(), format: z.string() }).optional(),
  ancestors: z.array(z.looseObject({ id: z.string(), title: z.string() })).optional(),
});
const confluenceComment = z.looseObject({
  id: z.string(),
  body: z.string(),
  created: z.string(),
  updated: z.string(),
  title: z.string().optional(),
  author: z.string().optional(),
  parent_comment_id: z.string().optional(),
  location: z.string().optional(),
});

export const atlassianOutputs = {
  jira_get_issue: jiraIssue,
  jira_search: z.looseObject({
    total: z.number(),
    start_at: z.number(),
    max_results: z.number(),
    issues: z.array(jiraIssue),
    next_page_token: z.string().optional(),
  }),
  confluence_get_page: z.union([
    z.looseObject({ metadata: confluencePage }),
    z.looseObject({ content: z.looseObject({ value: z.string() }) }),
    z.looseObject({ error: z.string() }),
  ]),
  confluence_search: z.array(confluencePage),
  confluence_get_comments: z.array(confluenceComment),
} satisfies Record<string, z.ZodType>;

const outputSchemas: ReadonlyMap<string, JSONSchema> = new Map(
  Object.entries(atlassianOutputs).map(([name, schema]) => {
    const converted = convertSchemaToJsonSchema(schema);

    if (!converted) {
      throw new Error(`Output schema is unavailable for ${name}`);
    }

    return [name, converted];
  }),
);

export function atlassianOutputSchema(name: string): JSONSchema | undefined {
  return outputSchemas.get(name);
}
