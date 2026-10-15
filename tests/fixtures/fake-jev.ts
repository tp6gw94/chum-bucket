export type JevPick = (intent: string, criteria: Record<string, string>) => string | undefined;

export function fakeJev(pick: JevPick, requests: { intent: string; keys: string[] }[] = []) {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      state: { intent: string };
      questions: { target: { criteria: Record<string, string> } };
    };
    const { criteria } = body.questions.target;
    const keys = Object.keys(criteria);
    requests.push({ intent: body.state.intent, keys });
    const choice = pick(body.state.intent, criteria);
    const probabilities = Object.fromEntries(
      keys.map((key) => [
        key,
        choice === undefined ? 1 / keys.length : key === choice ? 0.95 : 0.05 / (keys.length - 1),
      ]),
    );

    return new Response(
      JSON.stringify({
        model: "jev-fake",
        answers: {
          target: {
            type: "choice",
            choice: choice ?? "none",
            confidence: choice === undefined ? 0.3 : 0.95,
            probabilities,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  return { apiKey: "test-jev-key", fetch: fetchImpl };
}

export function pickByText(intentPattern: RegExp, text: string): JevPick {
  return (intent, criteria) =>
    intentPattern.test(intent)
      ? Object.keys(criteria).find((key) => key !== "none" && criteria[key]!.includes(text))
      : undefined;
}
