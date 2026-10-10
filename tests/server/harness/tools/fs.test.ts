import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { read, write, edit } from "../../../../server/harness/tools/fs";

const context = {
  toolCallId: "filesystem-call",
  abortSignal: new AbortController().signal,
  emitCustomEvent: () => {
    throw new Error("Unexpected custom event");
  },
};

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "chum-bucket-fs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("write creates parents and overwrites files that read resolves from process.cwd()", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = relative(process.cwd(), join(directory, "nested", "file.txt"));
  assert.deepEqual(await write.execute!({ path, content: "first\nsecond\n" }, context), {
    content: [{ type: "text", text: `Successfully wrote to ${path}` }],
    details: undefined,
  });
  assert.equal(await readFile(path, "utf8"), "first\nsecond\n");
  assert.deepEqual(await read.execute!({ path }, context), {
    content: [{ type: "text", text: "first\nsecond\n" }],
    details: undefined,
  });
  await write.execute!({ path, content: "replacement" }, context);
  assert.equal(await readFile(path, "utf8"), "replacement");
  assert.deepEqual(await read.execute!({ path }, context), {
    content: [{ type: "text", text: "replacement" }],
    details: undefined,
  });
});

test("read honors native offset, limit, and continuation behavior", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "lines.txt");
  await writeFile(path, "one\ntwo\nthree\nfour");
  assert.deepEqual(await read.execute!({ path, offset: 2, limit: 1 }, context), {
    content: [{ type: "text", text: "two\n\n[2 more lines in file. Use offset=3 to continue.]" }],
    details: undefined,
  });
  assert.deepEqual(await read.execute!({ path, offset: 3 }, context), {
    content: [{ type: "text", text: "three\nfour" }],
    details: undefined,
  });
  await assert.rejects(
    async () => read.execute!({ path, offset: 5 }, context),
    /beyond end of file/,
  );
});

test("edit matches disjoint replacements against the original and preserves BOM and CRLF", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "edit.txt");
  await writeFile(path, "\uFEFFalpha\r\nseparator\r\nomega\r\n");
  const result = z
    .object({
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
      details: z.object({ diff: z.string(), patch: z.string(), firstChangedLine: z.number() }),
    })
    .parse(
      await edit.execute!(
        {
          path,
          edits: [
            { oldText: "alpha", newText: "omega" },
            { oldText: "omega", newText: "final" },
          ],
        },
        context,
      ),
    );
  assert.equal(await readFile(path, "utf8"), "\uFEFFomega\r\nseparator\r\nfinal\r\n");
  assert.deepEqual(result.content, [
    { type: "text", text: `Successfully replaced 2 block(s) in ${path}.` },
  ]);
  assert.equal(result.details.firstChangedLine, 1);
  assert.match(result.details.diff, /-1 alpha/);
  assert.match(result.details.patch, /^-alpha$/m);
  assert.match(result.details.patch, /^\+final$/m);
});

test("edit rejects invalid, ambiguous, overlapping, and partially unmatched edits without mutation", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "unchanged.txt");
  const original = "alpha\nrepeat\nrepeat\nomega\n";
  await writeFile(path, original);
  for (const { edits, error } of [
    { edits: [], error: /at least one replacement/ },
    { edits: [{ oldText: "", newText: "insert" }], error: /must not be empty/ },
    { edits: [{ oldText: "missing", newText: "replacement" }], error: /Could not find/ },
    { edits: [{ oldText: "repeat", newText: "replacement" }], error: /2 occurrences/ },
    { edits: [{ oldText: "alpha", newText: "alpha" }], error: /No changes made/ },
    {
      edits: [
        { oldText: "alpha", newText: "changed" },
        { oldText: "alpha\nrepeat", newText: "overlap" },
      ],
      error: /overlap/,
    },
    {
      edits: [
        { oldText: "alpha", newText: "changed" },
        { oldText: "missing", newText: "replacement" },
      ],
      error: /Could not find/,
    },
  ]) {
    await assert.rejects(async () => edit.execute!({ path, edits }, context), error);
    assert.equal(await readFile(path, "utf8"), original);
  }
});

test("read and edit fail for missing files without creating them", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "missing.txt");
  await assert.rejects(async () => read.execute!({ path }, context), /ENOENT/);
  await assert.rejects(
    async () => edit.execute!({ path, edits: [{ oldText: "old", newText: "new" }] }, context),
    /Could not edit file.*ENOENT/,
  );
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("filesystem input validation rejects malformed calls before any write", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "existing.txt");
  const newPath = join(directory, "uncreated", "new.txt");
  await writeFile(path, "unchanged");
  for (const input of [
    null,
    [],
    {},
    { path },
    { path: 1, content: "replacement" },
    { path, content: 1 },
    { path, content: null },
    { path: newPath, content: false },
  ]) {
    await assert.rejects(async () => write.execute!(input, context), z.ZodError);
    assert.equal(await readFile(path, "utf8"), "unchanged");
  }
  for (const input of [
    null,
    {},
    { path, oldText: "unchanged", newText: "replacement" },
    { path, edits: "[]" },
    { path, edits: { oldText: "unchanged", newText: "replacement" } },
    { path, edits: [{ oldText: "unchanged" }] },
    { path, edits: [{ oldText: 1, newText: "replacement" }] },
    { path, edits: [{ oldText: "unchanged", newText: false }] },
  ]) {
    await assert.rejects(async () => edit.execute!(input, context), z.ZodError);
    assert.equal(await readFile(path, "utf8"), "unchanged");
  }
  for (const input of [{ path: 1 }, { path, offset: "2" }, { path, limit: null }]) {
    await assert.rejects(async () => read.execute!(input, context), z.ZodError);
  }
  await assert.rejects(access(dirname(newPath)), { code: "ENOENT" });
});

test("filesystem tools forward cancellation and leave files and directories unchanged", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "existing.txt");
  const newPath = join(directory, "uncreated", "new.txt");
  await writeFile(path, "unchanged");
  const controller = new AbortController();
  controller.abort();
  const aborted = { ...context, abortSignal: controller.signal };
  await assert.rejects(
    async () => read.execute!({ path }, aborted),
    (error) => {
      assert.equal(error, controller.signal.reason);
      assert.equal((error as DOMException).name, "AbortError");
      return true;
    },
  );
  await assert.rejects(async () => write.execute!({ path, content: "replacement" }, aborted), {
    name: "Error",
    message: "Operation aborted",
  });
  await assert.rejects(async () => write.execute!({ path: newPath, content: "new" }, aborted), {
    name: "Error",
    message: "Operation aborted",
  });
  await assert.rejects(
    async () =>
      edit.execute!({ path, edits: [{ oldText: "unchanged", newText: "changed" }] }, aborted),
    { name: "Error", message: "Operation aborted" },
  );
  const reason = new Error("operator cancelled the filesystem call");
  await assert.rejects(
    async () => read.execute!({ path }, { ...context, abortSignal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
  assert.equal(await readFile(path, "utf8"), "unchanged");
  await assert.rejects(access(dirname(newPath)), { code: "ENOENT" });
});

test("filesystem tools require a real tool call ID before execution", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "existing.txt");
  const newPath = join(directory, "uncreated", "new.txt");
  await writeFile(path, "unchanged");
  const missingId = { abortSignal: context.abortSignal, emitCustomEvent: context.emitCustomEvent };
  await assert.rejects(async () => read.execute!({ path }, missingId), /Missing tool call ID/);
  await assert.rejects(
    async () => write.execute!({ path: newPath, content: "new" }, missingId),
    /Missing tool call ID/,
  );
  await assert.rejects(
    async () => edit.execute!({ path, edits: [{ oldText: "unchanged", newText: "changed" }] }),
    /Missing tool call ID/,
  );
  assert.equal(await readFile(path, "utf8"), "unchanged");
  await assert.rejects(access(dirname(newPath)), { code: "ENOENT" });
});
