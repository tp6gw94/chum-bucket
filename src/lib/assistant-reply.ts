import { createParser, type ParseResult } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";

const parser = createParser(openuiLibrary.toJSONSchema(), openuiLibrary.root);
const assignment = /^\$?[A-Za-z_]\w*\s*=(?!=)/;
const rootAssignment = /^root\s*=(?!=)/;
const lineComment = /^\s*(?:\/\/|#)/;
const partialAssignment = /^\$?(?:[A-Za-z_]\w*)?\s*$/;
const fenceStart = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/;
const continuation = /^\s*[?:+\-*/%<>=!&|.,]/;
const closing = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

type SourceRange = Readonly<{ start: number; end: number; source: string }>;
export type AssistantReplySegment = SourceRange &
  (
    | Readonly<{ kind: "text"; warning?: string }>
    | Readonly<{
        kind: "openui";
        response: string;
        isStreaming: boolean;
        errorNames: readonly string[];
      }>
  );

type FrameState = {
  brackets: string[];
  quote: string | null;
  escaped: boolean;
  ambiguous: boolean;
};

type BareState = {
  active: boolean;
  gap: boolean;
};

type ReplyLine = Readonly<{ source: string; start: number; end: number }>;

type ReplyContext = {
  text: string;
  isStreaming: boolean;
  segments: AssistantReplySegment[];
};

export function parseAssistantReply(text: string): ParseResult {
  return parser.parse(text);
}

function emptyFrameState(): FrameState {
  return { brackets: [], quote: null, escaped: false, ambiguous: false };
}

function hasAmbiguousTail(tail: string): boolean {
  return tail !== "" && !continuation.test(tail) && !lineComment.test(tail);
}

function scanQuoted(character: string, line: string, index: number, state: FrameState): boolean {
  if (state.escaped) {
    state.escaped = false;

    return false;
  }

  if (character === "\\") {
    state.escaped = true;

    return false;
  }

  if (character !== state.quote) {
    return false;
  }

  state.quote = null;

  if (state.brackets.length > 0) {
    return false;
  }

  if (hasAmbiguousTail(line.slice(index + 1).trim())) {
    state.ambiguous = true;
  }

  return true;
}

function scanBracket(character: string, line: string, index: number, state: FrameState): boolean {
  if (character === '"' || character === "'") {
    state.quote = character;

    return false;
  }

  if (closing.has(character)) {
    state.brackets.push(closing.get(character)!);

    return false;
  }

  if (!")]}".includes(character)) {
    return false;
  }

  if (state.brackets.pop() !== character) {
    state.ambiguous = true;
  }

  if (state.brackets.length > 0) {
    return false;
  }

  if (hasAmbiguousTail(line.slice(index + 1).trim())) {
    state.ambiguous = true;
  }

  return true;
}

function scanBare(character: string, bare: BareState, state: FrameState) {
  if (/\s/.test(character)) {
    bare.gap = bare.active;

    return;
  }

  if (/[$@\w]/.test(character)) {
    if (bare.gap) {
      state.ambiguous = true;
    }

    bare.active = true;
    bare.gap = false;

    return;
  }

  bare.active = false;
  bare.gap = false;
}

function scanLine(line: string, state: FrameState) {
  const bare: BareState = { active: false, gap: false };

  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;

    if (state.quote !== null) {
      if (scanQuoted(character, line, index, state)) {
        bare.active = true;
      }

      continue;
    }

    if (character === "#" || (character === "/" && line[index + 1] === "/")) {
      break;
    }

    if (state.brackets.length === 0) {
      scanBare(character, bare, state);
    }

    if (scanBracket(character, line, index, state)) {
      bare.active = true;
    }
  }
}

function replyLines(text: string): ReplyLine[] {
  return [...text.matchAll(/[^\n]*\n|[^\n]+$/g)].map((match) => ({
    source: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function replyRange(context: ReplyContext, start: number, end: number): SourceRange {
  return { start, end, source: context.text.slice(start, end) };
}

function addReplyText(context: ReplyContext, start: number, end: number, warning?: string) {
  const previous = context.segments.at(-1);

  if (!warning && previous?.kind === "text" && !previous.warning && previous.end === start) {
    context.segments[context.segments.length - 1] = {
      kind: "text",
      ...replyRange(context, previous.start, end),
    };

    return;
  }

  context.segments.push({
    kind: "text",
    ...replyRange(context, start, end),
    ...(warning ? { warning } : {}),
  });
}

function isUsableFrame(result: ParseResult, state: FrameState, streaming: boolean): boolean {
  if (state.ambiguous || result.root?.statementId !== "root") {
    return false;
  }

  if (result.root.typeName !== openuiLibrary.root) {
    return false;
  }

  return streaming || (!result.meta.incomplete && result.meta.unresolved.length === 0);
}

function frameWarning(response: string, state: FrameState, streaming: boolean) {
  if (streaming && !state.ambiguous) {
    return undefined;
  }

  return rootAssignment.test(response) || /\nroot\s*=/.test(response)
    ? "無法完整解析 UI，原文已保留。"
    : undefined;
}

function addReplyFrame(
  context: ReplyContext,
  start: number,
  end: number,
  response: string,
  open: boolean,
  state: FrameState,
) {
  const result = parseAssistantReply(response);
  const streaming = context.isStreaming && open;

  if (!isUsableFrame(result, state, streaming)) {
    addReplyText(context, start, end, frameWarning(response, state, streaming));

    return;
  }

  context.segments.push({
    kind: "openui",
    ...replyRange(context, start, end),
    response,
    isStreaming: streaming,
    errorNames: [...new Set(result.meta.errors.map((error) => error.component))],
  });
}

function findFenceEnd(lines: ReplyLine[], index: number, marker: string) {
  const endFence = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
  let endIndex = index + 1;

  while (endIndex < lines.length && !endFence.test(lines[endIndex]!.source.trimEnd())) {
    endIndex++;
  }

  return endIndex;
}

function fenceFrameState(response: string, closed: boolean, isStreaming: boolean) {
  const state = emptyFrameState();
  state.ambiguous = !closed && !isStreaming;

  for (const content of response.split("\n")) {
    scanLine(content, state);
  }

  return state;
}

function addFenceSegment(
  context: ReplyContext,
  lines: ReplyLine[],
  index: number,
  fence: RegExpMatchArray,
): number {
  const line = lines[index]!;
  const endIndex = findFenceEnd(lines, index, fence[1]!);
  const closingLine = lines[endIndex];
  const closed = closingLine !== undefined;
  const end = closingLine?.end ?? context.text.length;
  const nextIndex = closed ? endIndex + 1 : lines.length;

  if (fence[2]!.trim() !== "openui-lang") {
    addReplyText(context, line.start, end);

    return nextIndex;
  }

  const response = context.text.slice(line.end, closingLine?.start ?? end);
  const state = fenceFrameState(response, closed, context.isStreaming);

  addReplyFrame(context, line.start, end, response, !closed, state);

  return nextIndex;
}

function isPendingTail(context: ReplyContext, lines: ReplyLine[], index: number): boolean {
  const current = lines[index]!;

  return (
    context.isStreaming &&
    current.end === context.text.length &&
    !current.source.endsWith("\n") &&
    (partialAssignment.test(current.source) || current.source.trim() === "/")
  );
}

function endsFrame(
  context: ReplyContext,
  lines: ReplyLine[],
  index: number,
  hasRoot: boolean,
): boolean {
  const current = lines[index]!;

  if (hasRoot && rootAssignment.test(current.source)) {
    return true;
  }

  if (current.source.trim() === "") {
    return false;
  }

  if (assignment.test(current.source)) {
    return false;
  }

  if (lineComment.test(current.source)) {
    return false;
  }

  return !isPendingTail(context, lines, index);
}

function addAssignmentFrame(context: ReplyContext, lines: ReplyLine[], index: number): number {
  const start = lines[index]!.start;
  const state = emptyFrameState();
  let hasRoot = false;
  let endIndex = index;

  while (endIndex < lines.length) {
    const current = lines[endIndex]!;
    const pending = state.quote !== null || state.brackets.length > 0;

    if (!pending) {
      if (endsFrame(context, lines, endIndex, hasRoot)) {
        break;
      }

      if (rootAssignment.test(current.source)) {
        hasRoot = true;
      }
    }

    scanLine(current.source, state);
    endIndex++;
  }

  const end = lines[endIndex - 1]!.end;

  addReplyFrame(
    context,
    start,
    end,
    context.text.slice(start, end),
    endIndex === lines.length,
    state,
  );

  return endIndex;
}

export function assistantReplySegments(text: string, isStreaming = false): AssistantReplySegment[] {
  const context: ReplyContext = { text, isStreaming, segments: [] };
  const lines = replyLines(text);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const fence = line.source.match(fenceStart);

    if (fence) {
      index = addFenceSegment(context, lines, index, fence);
      continue;
    }

    if (!assignment.test(line.source)) {
      addReplyText(context, line.start, line.end);
      index++;
      continue;
    }

    index = addAssignmentFrame(context, lines, index);
  }

  return context.segments;
}
