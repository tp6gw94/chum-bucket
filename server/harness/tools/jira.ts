import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

const FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "description", "labels"];

async function jiraFetch(path: string, init?: RequestInit): Promise<unknown> {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  const response = await fetch(`${JIRA_BASE_URL}/rest/api/3${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Jira API ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

type AdfNode = { type: string; text?: string; content?: AdfNode[] };

function adfToText(node: AdfNode | null | undefined): string {
  if (!node) {
    return "";
  }

  if (node.text) {
    return node.text;
  }

  const inner = (node.content ?? []).map(adfToText).join(node.type === "doc" ? "\n" : "");

  return ["paragraph", "heading", "listItem"].includes(node.type) ? `${inner}\n` : inner;
}

type JiraIssue = {
  key: string;
  fields: {
    summary: string;
    status?: { name: string };
    issuetype?: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string } | null;
    description?: AdfNode | null;
    labels?: string[];
  };
};

function simplify({ key, fields }: JiraIssue) {
  return {
    key,
    summary: fields.summary,
    status: fields.status?.name,
    type: fields.issuetype?.name,
    priority: fields.priority?.name,
    assignee: fields.assignee?.displayName ?? null,
    labels: fields.labels ?? [],
    description: adfToText(fields.description).trim(),
  };
}

export const getJiraIssue = toolDefinition({
  name: "get_jira_issue",
  description:
    "Read one Jira issue by key (for example FETM-78): summary, status, type, priority, assignee, labels and description.",
  inputSchema: z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/) }),
}).server(async ({ key }) => {
  const query = new URLSearchParams({ fields: FIELDS.join(",") });

  return simplify((await jiraFetch(`/issue/${key}?${query}`)) as JiraIssue);
});

export const searchJiraIssues = toolDefinition({
  name: "search_jira_issues",
  description:
    "Search Jira issues with JQL. The query must include a restriction such as project = FETM or assignee = currentUser().",
  inputSchema: z.object({
    jql: z.string().min(1),
    maxResults: z.number().int().min(1).max(50).default(20),
  }),
}).server(async ({ jql, maxResults }) => {
  const body = (await jiraFetch("/search/jql", {
    method: "POST",
    body: JSON.stringify({ jql, maxResults, fields: FIELDS }),
  })) as { issues: JiraIssue[] };

  return { issues: body.issues.map(simplify) };
});

export const jiraTools = [getJiraIssue, searchJiraIssues];
