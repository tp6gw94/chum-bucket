type Failure = { error: string; code: string; retryable: boolean };

function databaseCode(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown };

    if (typeof record.code === "string" && /^[0-9A-Z]{5}$/.test(record.code)) {
      return record.code;
    }

    current = record.cause;
  }

  return undefined;
}

export function delegationFailure(error: unknown): Failure {
  const code = databaseCode(error);

  if (code === "42P01" || code === "42703") {
    return {
      error:
        "Delegation database schema is not ready. An operator must run pnpm db:migrate before retrying. Repeating delegate_task cannot fix this error.",
      code: "migration_required",
      retryable: false,
    };
  }

  if (code) {
    return {
      error: "Delegation storage request failed.",
      code: "storage_error",
      retryable: ["40001", "40P01"].includes(code),
    };
  }

  return {
    error: error instanceof Error ? error.message.slice(0, 2000) : "Delegation failed",
    code: "delegation_failed",
    retryable: false,
  };
}
