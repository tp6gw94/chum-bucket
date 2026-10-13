import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import * as ast from "typescript/unstable/ast";
import * as is from "typescript/unstable/ast/is";
import { ENTRY_FILES, SOURCE_ROOTS, classifyFile, listSourceFiles } from "./file-policy.mjs";

export interface BoundaryViolation {
  rule: string;
  file: string;
  detail: string;
}

export interface CheckBoundariesOptions {
  rootDir?: string;
  testSeparationOnly?: boolean;
}

interface Edge {
  kind: "import" | "export" | "dynamic" | "require" | "type";
  specifier?: string;
  isLiteral: boolean;
  names: { original: string; local: string }[];
  isNamespace: boolean;
  isDefault: boolean;
  isTypeOnly?: boolean;
  node?: ast.Node;
}

const PRIV = new Set([
  "findStandaloneAdmission",
  "prepareStandaloneClosure",
  "insertStandaloneOperation",
  "closeUnfinishedTesting",
  "selectTestingCancellation",
]);
const JOURNAL_VALUES = new Set([
  "ackDelivery",
  "appendTrustedObservation",
  "appendTrustedReceipt",
  "claimActualTask",
  "ensureTestingCancelDeliveries",
  "listPendingTestingOperations",
  "readStartCancelDeliveries",
]);
const JOURNALS = new Set([
  ...JOURNAL_VALUES,
  "TestingPersistenceError",
  "ActualIoGuard",
  "ActualIoInput",
  "DeliveryRecord",
  "PendingTestingOperation",
  "RoleFailureCode",
  "RoleFrame",
  "TestingAdmission",
  "TestingExecution",
]);

function isTestOnly(p: string): boolean {
  return classifyFile(p).boundary === "test-only";
}

function isProhibitedDomain(t: string): boolean {
  const n = t.replace(/\\/g, "/");

  return (
    /(dbos|@dbos-inc\/)/.test(n) ||
    /^(pg(\/.*)?|drizzle-orm(\/.*)?)$/.test(n) ||
    /\b(pg(\/.*)?|drizzle-orm(\/.*)?)\b/.test(n) ||
    /(\/server\/db(\/.*|\.ts)?$|\/db(\.ts)?$|storage(\.ts)?$|run-store|testing-store|testing-run|testing-child|testing-runtime|agent-loop|harness\/run(\.ts)?$)/.test(
      n,
    )
  );
}

function loadPathsConfig(rootDir: string): Array<{ prefix: string; targetPrefix: string }> {
  const p = path.join(rootDir, "tsconfig.json");

  if (!fs.existsSync(p)) {
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const paths = raw.compilerOptions?.paths || {};

    return Object.entries(paths).map(([k, v]) => ({
      prefix: k.replace(/\*$/, ""),
      targetPrefix: Array.isArray(v) && v[0] ? (v[0] as string).replace(/\*$/, "") : "",
    }));
  } catch {
    return [];
  }
}

function resolveFallback(
  spec: string,
  fromFile: string,
  rootDir: string,
  pathRules: Array<{ prefix: string; targetPrefix: string }>,
): string {
  if (spec.startsWith("node:")) {
    return spec;
  }

  let base = spec;

  if (spec.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else {
    let matched = false;

    for (const rule of pathRules) {
      if (spec.startsWith(rule.prefix)) {
        base = path.resolve(rootDir, rule.targetPrefix + spec.slice(rule.prefix.length));
        matched = true;
        break;
      }
    }

    if (!matched) {
      return spec;
    }
  }

  for (const ext of [
    "",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.mjs",
  ]) {
    const cand = base + ext;

    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return path.normalize(cand);
    }
  }

  return path.normalize(base);
}

export function checkBoundaries(options: CheckBoundariesOptions = {}): {
  ok: boolean;
  violations: readonly BoundaryViolation[];
} {
  const rootDir = fs.realpathSync.native(path.resolve(options.rootDir || process.cwd()));
  const testSeparationOnly = !!options.testSeparationOnly;
  const violations: BoundaryViolation[] = [];
  const sourceFiles = listSourceFiles(rootDir).filter(
    (file) => !isTestOnly(path.relative(rootDir, file)),
  );

  const pathRules = loadPathsConfig(rootDir);
  const api = new API({ cwd: rootDir });

  try {
    const tsconfig = path.join(rootDir, "tsconfig.json");
    const snapshot = api.updateSnapshot(
      fs.existsSync(tsconfig)
        ? { openProjects: [tsconfig], openFiles: sourceFiles }
        : { openFiles: sourceFiles },
    );
    const fileEdges = new Map<string, Edge[]>();
    const fileInlines = new Map<string, string[]>();

    for (const f of sourceFiles) {
      const rel = path.relative(rootDir, f).replace(/\\/g, "/");
      const proj = snapshot.getDefaultProjectForFile(f);
      const src = proj?.program.getSourceFile(f);

      if (!proj || !src) {
        violations.push({
          rule: "unparseable-source",
          file: rel,
          detail: `Cannot load TypeScript AST for ${rel}`,
        });
        continue;
      }

      const reqAliases = new Set<string>(["require"]);
      const requireFactories = new Set<string>(["createRequire"]);
      const moduleNamespaces = new Set<string>();

      for (const statement of src.statements) {
        if (
          !is.isImportDeclaration(statement) ||
          !is.isStringLiteral(statement.moduleSpecifier) ||
          !["module", "node:module"].includes(statement.moduleSpecifier.text)
        ) {
          continue;
        }

        const bindings = statement.importClause?.namedBindings;

        if (bindings && is.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            if ((binding.propertyName ?? binding.name).text === "createRequire") {
              requireFactories.add(binding.name.text);
            }
          }
        } else if (bindings && is.isNamespaceImport(bindings)) {
          moduleNamespaces.add(bindings.name.text);
        }
      }

      function isRequireFactory(expression: ast.Expression): boolean {
        return (
          (is.isIdentifier(expression) && requireFactories.has(expression.text)) ||
          (is.isPropertyAccessExpression(expression) &&
            is.isIdentifier(expression.expression) &&
            moduleNamespaces.has(expression.expression.text) &&
            expression.name.text === "createRequire")
        );
      }

      const edges: Edge[] = [];
      const inlines: string[] = [];

      function forwardedName(expression: ast.Node | undefined): string | undefined {
        if (!expression) {
          return undefined;
        }

        if (is.isIdentifier(expression)) {
          return expression.text;
        }

        if (is.isPropertyAccessExpression(expression) && is.isIdentifier(expression.expression)) {
          return expression.expression.text;
        }

        if (
          is.isCallExpression(expression) ||
          is.isAwaitExpression(expression) ||
          is.isParenthesizedExpression(expression) ||
          is.isAsExpression(expression) ||
          is.isSatisfiesExpression(expression) ||
          is.isNonNullExpression(expression)
        ) {
          return forwardedName(expression.expression);
        }

        if (is.isArrowFunction(expression) || is.isFunctionExpression(expression)) {
          return forwardedName(expression.body);
        }

        if (is.isBlock(expression) && expression.statements.length === 1) {
          const statement = expression.statements[0];

          if (is.isReturnStatement(statement) || is.isExpressionStatement(statement)) {
            return forwardedName(statement.expression);
          }
        }

        return undefined;
      }

      function parse(node: ast.Node) {
        if (
          (is.isVariableStatement(node) ||
            is.isFunctionDeclaration(node) ||
            is.isTypeAliasDeclaration(node)) &&
          node.modifiers?.some((modifier) => modifier.kind === ast.SyntaxKind.ExportKeyword)
        ) {
          const candidates = is.isVariableStatement(node)
            ? node.declarationList.declarations.map((declaration) => declaration.initializer)
            : is.isFunctionDeclaration(node)
              ? [node.body]
              : is.isTypeReferenceNode(node.type)
                ? [node.type.typeName]
                : [];

          for (const candidate of candidates) {
            const name = forwardedName(candidate);

            if (name) {
              inlines.push(name);
            }
          }
        }

        if (
          is.isVariableDeclaration(node) &&
          is.isIdentifier(node.name) &&
          node.initializer &&
          is.isCallExpression(node.initializer)
        ) {
          if (isRequireFactory(node.initializer.expression)) {
            reqAliases.add(node.name.text);
          }
        }

        if (is.isImportDeclaration(node)) {
          const spec =
            node.moduleSpecifier && is.isStringLiteral(node.moduleSpecifier)
              ? node.moduleSpecifier.text
              : undefined;
          const names: { original: string; local: string }[] = [];
          let isNs = false;
          let isDef = false;

          if (node.importClause) {
            if (node.importClause.name) {
              isDef = true;
              names.push({
                original: node.importClause.name.text,
                local: node.importClause.name.text,
              });
            }

            if (node.importClause.namedBindings) {
              if (is.isNamespaceImport(node.importClause.namedBindings)) {
                isNs = true;
                names.push({ original: "*", local: node.importClause.namedBindings.name.text });
              } else if (is.isNamedImports(node.importClause.namedBindings)) {
                for (const el of node.importClause.namedBindings.elements) {
                  names.push({
                    original: el.propertyName ? el.propertyName.text : el.name.text,
                    local: el.name.text,
                  });
                }
              }
            }
          }

          edges.push({
            kind: "import",
            specifier: spec,
            isLiteral: !!spec,
            names,
            isNamespace: isNs,
            isDefault: isDef,
            isTypeOnly: node.importClause?.phaseModifier === ast.SyntaxKind.TypeKeyword,
            node: node.moduleSpecifier,
          });
        } else if (is.isExportDeclaration(node)) {
          if (node.moduleSpecifier && is.isStringLiteral(node.moduleSpecifier)) {
            edges.push({
              kind: "export",
              specifier: node.moduleSpecifier.text,
              isLiteral: true,
              names: [],
              isNamespace: false,
              isDefault: false,
              node: node.moduleSpecifier,
            });
          } else if (node.exportClause && is.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) {
              inlines.push((el.propertyName ?? el.name).text);
            }
          }
        } else if (is.isImportTypeNode(node)) {
          const arg = node.argument;
          const lit =
            is.isLiteralTypeNode(arg) && is.isStringLiteral(arg.literal)
              ? arg.literal
              : is.isStringLiteral(arg)
                ? arg
                : undefined;
          const name = node.qualifier?.getText(src);
          edges.push({
            kind: "type",
            specifier: lit?.text,
            isLiteral: !!lit,
            names: name ? [{ original: name, local: name }] : [],
            isNamespace: !name,
            isDefault: false,
            node: lit,
          });
        } else if (is.isCallExpression(node)) {
          if (node.expression.kind === ast.SyntaxKind.ImportKeyword) {
            const arg = node.arguments[0];
            const lit =
              arg && (is.isStringLiteral(arg) || is.isNoSubstitutionTemplateLiteral(arg))
                ? arg.text
                : undefined;
            edges.push({
              kind: "dynamic",
              specifier: lit,
              isLiteral: !!lit,
              names: [],
              isNamespace: false,
              isDefault: false,
              node: arg,
            });
          } else if (
            (is.isIdentifier(node.expression) &&
              reqAliases.has(node.expression.text) &&
              !requireFactories.has(node.expression.text)) ||
            (is.isCallExpression(node.expression) && isRequireFactory(node.expression.expression))
          ) {
            const arg = node.arguments[0];
            const lit =
              arg && (is.isStringLiteral(arg) || is.isNoSubstitutionTemplateLiteral(arg))
                ? arg.text
                : undefined;
            edges.push({
              kind: "require",
              specifier: lit,
              isLiteral: !!lit,
              names: [],
              isNamespace: false,
              isDefault: false,
              node: arg,
            });
          }
        }

        node.forEachChild((c: ast.Node) => {
          parse(c);

          return undefined;
        });
      }

      parse(src);
      fileEdges.set(f, edges);
      fileInlines.set(f, inlines);
    }

    const graph = new Map<string, Set<string>>();

    for (const [f, edges] of fileEdges.entries()) {
      const rel = path.relative(rootDir, f).replace(/\\/g, "/");
      const proj = snapshot.getDefaultProjectForFile(f);
      const isOwner = rel === "server/harness/run-store.ts";
      const isRoute = rel === "server/testing.ts" || rel.endsWith("/server/testing.ts");
      const aliasMap = new Map<string, string>();
      const targets = new Set<string>();

      for (const e of edges) {
        if (!e.isLiteral) {
          if (!testSeparationOnly) {
            violations.push({ rule: "non-literal-module-load", file: rel, detail: rel });
          }

          continue;
        }

        const spec = e.specifier || "";
        let resolved = "";

        if (e.node && proj) {
          const sym = proj.checker.getSymbolAtLocation(e.node);
          const source = sym?.declarations?.[0]?.resolve(proj)?.getSourceFile();

          if (source) {
            resolved = source.fileName;
          }
        }

        if (!resolved) {
          resolved = resolveFallback(spec, f, rootDir, pathRules);
        }

        if (path.isAbsolute(resolved) && fs.existsSync(resolved)) {
          resolved = fs.realpathSync.native(resolved);
        }

        targets.add(resolved);
        const resolvedRel = path.relative(rootDir, resolved).replace(/\\/g, "/");

        if (
          path.isAbsolute(resolved) &&
          !resolved.includes("/node_modules/") &&
          /\.[cm]?[jt]sx?$/.test(resolved) &&
          !SOURCE_ROOTS.includes(resolvedRel.split("/")[0]) &&
          !ENTRY_FILES.includes(resolvedRel)
        ) {
          violations.push({ rule: "uncontrolled-source-target", file: rel, detail: spec });
        }

        if (
          spec === "node:test" ||
          spec.startsWith("node:test/") ||
          isTestOnly(resolvedRel) ||
          isTestOnly(spec)
        ) {
          violations.push({ rule: "prod-imports-test", file: rel, detail: spec });
        }

        if (testSeparationOnly) {
          continue;
        }

        const isTestingStore = resolved.includes("testing-store") || spec.includes("testing-store");

        if (isTestingStore) {
          for (const n of e.names) {
            aliasMap.set(n.local, n.original);
          }

          if (isOwner) {
            const runtimeCapability =
              !e.isTypeOnly &&
              (e.isNamespace || e.isDefault || e.kind === "dynamic" || e.kind === "require");
            const journalValue =
              e.kind === "import" ? e.names.find((n) => JOURNAL_VALUES.has(n.original)) : undefined;

            if (runtimeCapability || journalValue) {
              violations.push({
                rule: "run-store-journal-reexport",
                file: rel,
                detail:
                  journalValue?.original ?? `${e.kind} import of testing-store in owner ${rel}`,
              });
            }
          }

          if (!isOwner) {
            if (
              e.isNamespace ||
              e.isDefault ||
              e.kind === "dynamic" ||
              e.kind === "require" ||
              e.kind === "export"
            ) {
              violations.push({
                rule: "privileged-api-bypass",
                file: rel,
                detail: `${e.kind} import of testing-store in non-owner ${rel}`,
              });
            }

            for (const n of e.names) {
              if (n.original.includes("InTransaction") || PRIV.has(n.original)) {
                violations.push({
                  rule: "privileged-api-owner-violation",
                  file: rel,
                  detail: n.original,
                });
              }
            }
          }
        }

        if (isRoute) {
          const ok =
            resolved.includes("node_modules") ||
            spec.startsWith("node:") ||
            spec === "hono" ||
            spec === "zod" ||
            resolvedRel.startsWith("shared/") ||
            resolvedRel === "server/harness/testing-service.ts";

          if (!ok) {
            violations.push({ rule: "route-imports-testing-internals", file: rel, detail: spec });
          }
        }

        if (isOwner && e.kind === "export" && isTestingStore) {
          violations.push({ rule: "run-store-journal-reexport", file: rel, detail: spec });
        }
      }

      if (!testSeparationOnly && isOwner) {
        for (const local of fileInlines.get(f) || []) {
          const imported = aliasMap.get(local);

          if (imported || JOURNALS.has(local)) {
            violations.push({
              rule: "run-store-journal-reexport",
              file: rel,
              detail: imported || local,
            });
          }
        }
      }

      graph.set(f, targets);
    }

    if (!testSeparationOnly) {
      for (const f of sourceFiles) {
        const rel = path.relative(rootDir, f).replace(/\\/g, "/");

        if (
          !rel.startsWith("shared/") &&
          !rel.endsWith("testing-domain.ts") &&
          !rel.endsWith("testing-policy.ts")
        ) {
          continue;
        }

        const visited = new Set<string>();
        const queue = [f];

        while (queue.length > 0) {
          const curr = queue.shift()!;

          if (visited.has(curr)) {
            continue;
          }

          visited.add(curr);

          for (const target of graph.get(curr) || []) {
            if (isProhibitedDomain(target)) {
              violations.push({ rule: "domain-transitive-coupling", file: rel, detail: target });
            }

            if (fs.existsSync(target) && !visited.has(target)) {
              queue.push(target);
            }
          }
        }
      }
    }

    snapshot.dispose();
  } finally {
    api.close();
  }

  return { ok: violations.length === 0, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const testSeparationOnly = process.argv.includes("--test-separation-only");
  const res = checkBoundaries({ testSeparationOnly });

  if (!res.ok) {
    for (const v of res.violations) {
      console.error(`[boundary-violation] ${v.rule} in ${v.file}: ${v.detail}`);
    }

    process.exit(1);
  }

  console.log("Boundary check passed.");
}
