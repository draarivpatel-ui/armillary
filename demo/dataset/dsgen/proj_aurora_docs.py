"""aurora-docs: filler sessions for the TypeScript React docs site (OpenAPI 3.1 viewer, Vite, vitest, Playwright).

Nine sessions across claude-code, cline, opencode, cursor-cli, github-copilot-cli and aider. The owner's hero
Cline session (the copy button) lives elsewhere. File contents stay consistent from session to session in time order:
9/28 CodeSnippet copy button and curl helpers, 9/30 OpenAPI embed and body validator, 10/01 ARIA tabs,
10/02 collections migration and rate limiter, 10/04 Copy as curl, 10/06 flaky e2e fix, 10/07 search index, 10/08 signing.
"""

from .model import Sess, asst, at, bash, edit, grep, ls, read, todo, user, write

P = "aurora-docs"


def F(s):
    """File text: no leading blank line, one trailing newline."""
    return s.strip("\n") + "\n"


def D(s):
    """Snippet text for an edit: no leading or trailing blank lines."""
    return s.strip("\n")


# ---------------------------------------------------------------------------
# 1. claude-code: embed the playground into the OpenAPI viewer with body validation
# ---------------------------------------------------------------------------

def _claude_embed():
    op_panel_v0 = F(r"""
import type { Operation } from "./groupByTag";
import { SchemaTable } from "./SchemaTable";

export function OperationPanel({ op }: { op: Operation }) {
  return (
    <article className="oa-op" id={`op-${op.id}`}>
      <header>
        <span className={`oa-method oa-method-${op.method}`}>{op.method.toUpperCase()}</span>
        <code>{op.path}</code>
      </header>
      <p>{op.summary}</p>
      <SchemaTable schema={op.requestBody?.schema} title="Request body" />
      <SchemaTable schema={op.responses["200"]?.schema} title="Response" />
    </article>
  );
}
""")
    playground_v0 = F(r"""
import { useEffect, useState } from "react";
import { CodeSnippet } from "./CodeSnippet";
import { TabSwitcher } from "./TabSwitcher";
import "../styles/playground.css";

type Props = {
  method: string;
  baseUrl: string;
  path: string;
  initialBody?: string;
};

const TABS = [
  { id: "body", label: "Body" },
  { id: "headers", label: "Headers" },
];

export function ApiPlayground({ method, baseUrl, path, initialBody = "" }: Props) {
  const [body, setBody] = useState(initialBody);
  const [tab, setTab] = useState("body");
  const [status, setStatus] = useState<string | null>(null);
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState(false);

  // a different operation means the old response no longer applies
  useEffect(() => {
    setStatus(null);
    setPayload("");
  }, [method, baseUrl, path]);

  async function send() {
    setBusy(true);
    try {
      const res = await fetch(baseUrl + path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : body,
      });
      setStatus(`${res.status} ${res.statusText}`);
      setPayload(await res.text());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pg">
      <div className="pg-header">
        <span className={`pg-badge pg-badge-${method.toLowerCase()}`}>{method}</span>
        <code>{path}</code>
        <button onClick={send} disabled={busy}>
          Send
        </button>
      </div>
      <TabSwitcher tabs={TABS} active={tab} onChange={setTab} />
      {tab === "body" ? (
        <textarea
          aria-label="Request body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      ) : (
        <pre className="pg-headers">content-type: application/json</pre>
      )}
      <div className="pg-response" data-testid="response-status">
        {status}
      </div>
      <CodeSnippet code={payload} lang="json" />
    </div>
  );
}
""")
    validate_ts = F(r"""
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { OpenAPIV3_1 } from "openapi-types";

export type BodyIssue = { path: string; message: string };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

export function makeBodyValidator(schema: OpenAPIV3_1.SchemaObject) {
  const check = ajv.compile(schema);
  return function validateBody(raw: string): BodyIssue[] {
    if (raw.trim() === "") return [];
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return [{ path: "", message: `Body is not valid JSON: ${(err as Error).message}` }];
    }
    if (check(data)) return [];
    return (check.errors ?? []).map((e) => ({
      path: e.instancePath || "/",
      message: e.message ?? "is invalid",
    }));
  };
}
""")
    validate_test = F(r"""
import { describe, expect, it } from "vitest";
import { makeBodyValidator } from "./validateBody";

const petSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, example: "Biscuit" },
    tag: { type: ["string", "null"] },
    age: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
} as const;

describe("makeBodyValidator", () => {
  const validate = makeBodyValidator(petSchema);

  it("accepts a valid pet body", () => {
    expect(validate('{"name":"Biscuit","age":3}')).toEqual([]);
  });

  it("accepts null for a 3.1 type array", () => {
    expect(validate('{"name":"Biscuit","tag":null}')).toEqual([]);
  });

  it("reports the path of a wrong type", () => {
    expect(validate('{"name":"Biscuit","age":"three"}')).toEqual([
      { path: "/age", message: "must be integer" },
    ]);
  });

  it("reports malformed JSON without throwing", () => {
    const [issue] = validate('{"name": ');
    expect(issue.path).toBe("");
    expect(issue.message).toMatch(/^Body is not valid JSON/);
  });

  it("treats an empty body as nothing to validate", () => {
    expect(validate("   ")).toEqual([]);
  });
});
""")
    hook_ts = F(r"""
import { useEffect, useState } from "react";

const FALLBACK_BASE_URL = "http://localhost:4010";

/** The sandbox host comes from a config file that each docs environment can override. */
export function useSandboxBaseUrl(): { baseUrl: string; ready: boolean } {
  const [state, setState] = useState({ baseUrl: FALLBACK_BASE_URL, ready: false });
  useEffect(() => {
    let cancelled = false;
    fetch("/sandbox/config.json")
      .then((r) => r.json())
      .then((cfg: { baseUrl: string }) => {
        if (!cancelled) setState({ baseUrl: cfg.baseUrl, ready: true });
      })
      .catch(() => {
        if (!cancelled) setState({ baseUrl: FALLBACK_BASE_URL, ready: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
""")
    panel_v1 = D(r"""
import { useMemo } from "react";
import { ApiPlayground } from "../components/ApiPlayground";
import type { Operation } from "./groupByTag";
import { SchemaTable } from "./SchemaTable";
import { useSandboxBaseUrl } from "./useSandboxBaseUrl";
import { makeBodyValidator } from "./validateBody";

export function OperationPanel({ op }: { op: Operation }) {
  const { baseUrl } = useSandboxBaseUrl();
  const validate = useMemo(() => makeBodyValidator(op.requestBody?.schema), [op]);
  return (
    <article className="oa-op" id={`op-${op.id}`}>
      <header>
        <span className={`oa-method oa-method-${op.method}`}>{op.method.toUpperCase()}</span>
        <code>{op.path}</code>
      </header>
      <p>{op.summary}</p>
      <SchemaTable schema={op.requestBody?.schema} title="Request body" />
      <SchemaTable schema={op.responses["200"]?.schema} title="Response" />
      <ApiPlayground
        method={op.method.toUpperCase()}
        baseUrl={baseUrl}
        path={op.path}
        initialBody={op.requestBody?.exampleJson ?? ""}
        validate={validate}
      />
    </article>
  );
}
""")
    return Sess(
        key="aurora-docs/claude-code/embed-playground-viewer", agent="claude-code", project=P,
        start=at("2026-09-30", "15:05"), minutes=52, model="claude-sonnet-5-5",
        title="Embed the API playground in the OpenAPI viewer", branch="viewer-playground",
        turns=[
            user("The OpenAPI 3.1 viewer only renders docs for each operation. I want the interactive API playground "
                 "embedded under every operation, prefilled from the spec's example, and the request body checked "
                 "against the operation's schema. It's 3.1, so full JSON Schema 2020-12, not the old 3.0 dialect "
                 "with `nullable`."),
            asst("I'll read how an operation is rendered today and what the playground takes as props.", [
                read("src/openapi/OperationPanel.tsx", op_panel_v0),
                read("src/components/ApiPlayground.tsx", playground_v0),
                grep('"ajv', "package.json",
                     'package.json:31:    "ajv": "^8.17.1",\npackage.json:32:    "ajv-formats": "^3.0.1",'),
                write("src/openapi/validateBody.ts", validate_ts),
                write("src/openapi/validateBody.test.ts", validate_test),
                bash("npx vitest run src/openapi/validateBody.test.ts",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 FAIL  src/openapi/validateBody.test.ts [ src/openapi/validateBody.test.ts ]
Error: strict mode: unknown keyword: "example"
 ❯ checkStrictMode node_modules/ajv/lib/compile/util.ts:222:13
 ❯ checkKeywords node_modules/ajv/lib/compile/validate/index.ts:151:7
 ❯ makeBodyValidator src/openapi/validateBody.ts:11:17
 ❯ src/openapi/validateBody.test.ts:16:20

 Test Files  1 failed (1)
      Tests  no tests
   Start at  10:12:07
   Duration  684ms (transform 41ms, setup 0ms, collect 98ms, tests 0ms, environment 0ms, prepare 52ms)
"""), error=True, desc="Run the new validator tests"),
                edit("src/openapi/validateBody.ts",
                     D(r"""
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
"""),
                     D(r"""
const ajv = new Ajv2020({ allErrors: true, strict: true, discriminator: true });
addFormats(ajv);
// OpenAPI annotation keywords that are not part of JSON Schema itself
ajv.addVocabulary(["example", "externalDocs", "xml"]);
""")),
                bash("npx vitest run src/openapi/validateBody.test.ts",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/openapi/validateBody.test.ts (5 tests) 14ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  10:12:39
   Duration  702ms (transform 38ms, setup 0ms, collect 91ms, tests 14ms, environment 0ms, prepare 49ms)
"""), desc="Re-run the validator tests"),
            ]),
            user("Good. Now wire it into the viewer. One thing: don't disable Send when the body is invalid, show the "
                 "problems as a warning. The sandbox's 422 response is useful for readers to see."),
            asst("Wiring it in: a small hook for the sandbox host, the warning list in the playground, and the panel.", [
                write("src/openapi/useSandboxBaseUrl.ts", hook_ts),
                edit("src/components/ApiPlayground.tsx",
                     D(r"""
import { useEffect, useState } from "react";
import { CodeSnippet } from "./CodeSnippet";
import { TabSwitcher } from "./TabSwitcher";
import "../styles/playground.css";

type Props = {
  method: string;
  baseUrl: string;
  path: string;
  initialBody?: string;
};
"""),
                     D(r"""
import { useEffect, useMemo, useState } from "react";
import type { BodyIssue } from "../openapi/validateBody";
import { CodeSnippet } from "./CodeSnippet";
import { TabSwitcher } from "./TabSwitcher";
import "../styles/playground.css";

type Props = {
  method: string;
  baseUrl: string;
  path: string;
  initialBody?: string;
  /** Returns schema problems for the current body; a non-empty list warns but never blocks Send. */
  validate?: (raw: string) => BodyIssue[];
};
""")),
                edit("src/components/ApiPlayground.tsx",
                     D(r"""
          onChange={(e) => setBody(e.target.value)}
        />
      ) : (
        <pre className="pg-headers">content-type: application/json</pre>
      )}
      <div className="pg-response" data-testid="response-status">
"""),
                     D(r"""
          onChange={(e) => setBody(e.target.value)}
          aria-invalid={issues.length > 0}
        />
      ) : (
        <pre className="pg-headers">content-type: application/json</pre>
      )}
      {issues.length > 0 && (
        <ul className="pg-issues" role="status">
          {issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <code>{issue.path || "body"}</code> {issue.message}
            </li>
          ))}
        </ul>
      )}
      <div className="pg-response" data-testid="response-status">
""")),
                edit("src/openapi/OperationPanel.tsx", D(op_panel_v0), panel_v1),
                bash("npx tsc --noEmit",
                     "src/openapi/OperationPanel.tsx(10,52): error TS2345: Argument of type 'SchemaObject | undefined' "
                     "is not assignable to parameter of type 'SchemaObject'.\n"
                     "  Type 'undefined' is not assignable to type 'SchemaObject'.\n",
                     error=True, desc="Type check"),
                edit("src/openapi/OperationPanel.tsx",
                     "  const validate = useMemo(() => makeBodyValidator(op.requestBody?.schema), [op]);",
                     D(r"""
  const bodySchema = op.requestBody?.schema;
  const validate = useMemo(
    () => (bodySchema ? makeBodyValidator(bodySchema) : undefined),
    [bodySchema],
  );
""")),
                bash("npx tsc --noEmit && npx vitest run src/openapi src/components/ApiPlayground.test.tsx",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/openapi/validateBody.test.ts (5 tests) 13ms
 ✓ src/openapi/groupByTag.test.ts (4 tests) 6ms
 ✓ src/components/ApiPlayground.test.tsx (6 tests) 212ms

 Test Files  3 passed (3)
      Tests  15 passed (15)
   Start at  10:19:44
   Duration  1.31s (transform 112ms, setup 0ms, collect 487ms, tests 231ms, environment 902ms, prepare 120ms)
"""), desc="Type check, then run the affected tests"),
            ]),
            user("Nice, type check and tests are clean. Can you write the PR description? Keep it short."),
            asst("""**Embed the interactive API playground in the OpenAPI viewer**

- Every operation in `OpenApiViewer` now ends with an `ApiPlayground`, prefilled from the spec's example body and pointed at the sandbox host from `/sandbox/config.json` (falls back to `http://localhost:4010`).
- New `src/openapi/validateBody.ts` compiles the operation's request schema with Ajv's 2020-12 build, so 3.1 features like `type: ["string", "null"]` validate correctly. Annotation keywords from OpenAPI (`example`, `externalDocs`, `xml`) are registered so strict mode stays on.
- Invalid bodies show a warning list under the editor and set `aria-invalid`, but Send stays enabled so readers can see the sandbox's 422.

```ts
const ajv = new Ajv2020({ allErrors: true, strict: true, discriminator: true });
addFormats(ajv);
ajv.addVocabulary(["example", "externalDocs", "xml"]);
```

**Tests:** 5 new unit tests for the validator (valid, null via type array, wrong type path, malformed JSON, empty body). I did not add a component test for the warning list, so that part is only covered by the type check.

**Worth knowing:** the base URL now arrives asynchronously, which resets the response pane when it changes. It is fine for readers, but anything that clicks Send immediately after load should wait for the page to settle.""")
        ],
    )


# ---------------------------------------------------------------------------
# 2. claude-code: flaky Playwright spec (Send button vs response pane)
# ---------------------------------------------------------------------------

def _claude_flaky():
    spec = F(r"""
import { test, expect } from "@playwright/test";

const PETS = [{ id: 1, name: "Biscuit", tag: "corgi" }];

test.describe("playground", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/sandbox/config.json", (route) =>
      route.fulfill({ json: { baseUrl: "http://localhost:4011" } }),
    );
    await page.goto("/docs/pets/list-pets");
  });

  test("sends a request and shows the response", async ({ page }) => {
    await page.route("**/v1/pets", (route) =>
      route.fulfill({ status: 200, json: PETS }),
    );
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("response-status")).toContainText("200 OK");
  });

  test("warns about an invalid body but still sends", async ({ page }) => {
    await page.goto("/docs/pets/create-pet");
    await page.getByLabel("Request body").fill('{"name": 42}');
    await expect(page.getByRole("status")).toContainText("must be string");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  test("switches between the Body and Headers tabs", async ({ page }) => {
    await page.getByRole("tab", { name: "Headers" }).click();
    await expect(page.locator(".pg-headers")).toContainText("content-type");
  });
});
""")
    return Sess(
        key="aurora-docs/claude-code/flaky-playground-spec", agent="claude-code", project=P,
        start=at("2026-10-06", "19:20"), minutes=41, model="claude-sonnet-5-5",
        title="Stabilise the flaky playground e2e spec", branch="main",
        turns=[
            user("this flaky test in e2e/playground.spec.ts is back, \"sends a request and shows the response\". fails "
                 "maybe 1 in 4 on CI, never on my laptop. retries=2 hides it but I'd rather it was actually fixed\n\n"
                 "Error: expect(locator).toContainText(expected)\n"
                 "Locator: getByTestId('response-status')\n"
                 "Expected substring: \"200 OK\"\n"
                 "Received string:    \"\"\n"
                 "Timeout: 5000ms"),
            asst("The response pane is empty after the click, so something clears it or the click never sends. I'll read "
                 "the spec and the component, then reproduce it under load.", [
                read("e2e/playground.spec.ts", spec),
                read("src/components/ApiPlayground.tsx", F(r"""
export function ApiPlayground({ method, baseUrl, path, initialBody = "", validate }: Props) {
  const [body, setBody] = useState(initialBody);
  const [tab, setTab] = useState("body");
  const [status, setStatus] = useState<string | null>(null);
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState(false);
  const issues = useMemo(() => validate?.(body) ?? [], [validate, body]);

  // a different operation means the old response no longer applies
  useEffect(() => {
    setStatus(null);
    setPayload("");
  }, [method, baseUrl, path]);

  async function send() {
    setBusy(true);
    try {
      const res = await sandboxFetch(baseUrl + path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : body,
      });
      setStatus(`${res.status} ${res.statusText}`);
      setPayload(await res.text());
    } finally {
      setBusy(false);
    }
  }
"""), start=24, limit=28),
                bash("npx playwright test e2e/playground.spec.ts -g \"sends a request\" --repeat-each=20 --workers=4",
                     F(r"""
Running 20 tests using 4 workers

  1) [chromium] › e2e/playground.spec.ts:13:3 › playground › sends a request and shows the response (repeat:7)

    Error: expect(locator).toContainText(expected)

    Locator: getByTestId('response-status')
    Expected substring: "200 OK"
    Received string:    ""
    Timeout: 5000ms

    Call log:
      - expect.toContainText with timeout 5000ms
      - waiting for getByTestId('response-status')
      -   locator resolved to <div class="pg-response" data-testid="response-status"></div>
      -   unexpected value ""

      16 |     );
      17 |     await page.getByRole("button", { name: "Send" }).click();
    > 18 |     await expect(page.getByTestId("response-status")).toContainText("200 OK");
         |                                                       ^
      19 |   });

  3 failed
    [chromium] › e2e/playground.spec.ts:13:3 › playground › sends a request and shows the response (repeat:7)
    [chromium] › e2e/playground.spec.ts:13:3 › playground › sends a request and shows the response (repeat:12)
    [chromium] › e2e/playground.spec.ts:13:3 › playground › sends a request and shows the response (repeat:16)
  17 passed (24.6s)
"""), error=True, desc="Reproduce under parallel load"),
                read("src/openapi/useSandboxBaseUrl.ts", F(r"""
const FALLBACK_BASE_URL = "http://localhost:4010";

/** The sandbox host comes from a config file that each docs environment can override. */
export function useSandboxBaseUrl(): { baseUrl: string; ready: boolean } {
  const [state, setState] = useState({ baseUrl: FALLBACK_BASE_URL, ready: false });
  useEffect(() => {
    let cancelled = false;
    fetch("/sandbox/config.json")
      .then((r) => r.json())
      .then((cfg: { baseUrl: string }) => {
        if (!cancelled) setState({ baseUrl: cfg.baseUrl, ready: true });
      })
"""), start=6, limit=12),
            ]),
            user("so it's the config fetch racing the click? make it robust, I don't want to just bump the timeout"),
            asst("Yes, that's the race. The playground renders with the fallback host, the click lands, then the config "
                 "arrives with a different `baseUrl` and the reset effect wipes the response that just came back. I'll "
                 "keep Send disabled until the host is known, and make the spec wait for that instead of guessing.", [
                edit("src/components/ApiPlayground.tsx",
                     "  /** Returns schema problems for the current body; a non-empty list warns but never blocks Send. */",
                     D(r"""
  /** False while the sandbox host is still loading; Send stays disabled so a response is never reset mid-flight. */
  ready?: boolean;
  /** Returns schema problems for the current body; a non-empty list warns but never blocks Send. */
""")),
                edit("src/components/ApiPlayground.tsx",
                     'export function ApiPlayground({ method, baseUrl, path, initialBody = "", validate }: Props) {',
                     'export function ApiPlayground({ method, baseUrl, path, initialBody = "", validate, ready = true }: Props) {'),
                edit("src/components/ApiPlayground.tsx",
                     "        <button onClick={send} disabled={busy}>",
                     "        <button onClick={send} disabled={busy || !ready}>"),
                edit("src/openapi/OperationPanel.tsx",
                     "  const { baseUrl } = useSandboxBaseUrl();",
                     "  const { baseUrl, ready } = useSandboxBaseUrl();"),
                edit("src/openapi/OperationPanel.tsx",
                     "        baseUrl={baseUrl}\n        path={op.path}",
                     "        baseUrl={baseUrl}\n        ready={ready}\n        path={op.path}"),
                edit("e2e/playground.spec.ts",
                     D(r"""
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("response-status")).toContainText("200 OK");
"""),
                     D(r"""
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByTestId("response-status")).toContainText("200 OK");
""")),
                bash("npx playwright test e2e/playground.spec.ts -g \"sends a request\" --repeat-each=20 --workers=4",
                     "Running 20 tests using 4 workers\n\n  20 passed (11.3s)\n", desc="Repeat the test 20 times in parallel"),
                bash("npx playwright test e2e/playground.spec.ts && npx tsc --noEmit",
                     "Running 3 tests using 3 workers\n\n  3 passed (4.1s)\n", desc="Whole spec file, then type check"),
            ]),
            user("good. write me the commit message body, mention why we didn't just raise the timeout"),
            asst("""Here's a body you can paste under the subject line.

```
Disable Send until the sandbox host is known

The playground renders with a fallback host and swaps in the host from
/sandbox/config.json a moment later. The response reset effect depends on
baseUrl, so a click that landed before the swap had its response cleared
as soon as the config arrived. That only happens when CI is slow enough for
the click to beat the config fetch, which is why it was a flaky test.

- ApiPlayground takes a `ready` prop and disables Send while it is false
- OperationPanel passes the flag from useSandboxBaseUrl
- the spec asserts Send is enabled before clicking, so it waits on the real
  condition instead of a longer timeout
```

**Verified:** 20 parallel repeats of the failing test pass (3 of 20 failed before), then the whole spec file and `tsc --noEmit` are clean. A longer timeout would not have helped: the response was cleared, not late, so the assertion would have waited the full 5s and failed the same way. The CI retries (`retries: 2`) can stay as a safety net, but this spec shouldn't need them now.""")
        ],
    )


# ---------------------------------------------------------------------------
# 3. cline: accessible ARIA tab switcher
# ---------------------------------------------------------------------------

def _cline_tabs():
    tab_v0 = F(r"""
type Tab = { id: string; label: string };

type Props = {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
};

export function TabSwitcher({ tabs, active, onChange }: Props) {
  return (
    <div className="pg-tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={t.id === active ? "pg-tab pg-tab-active" : "pg-tab"}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
""")
    tab_v1 = F(r"""
import { useRef, type KeyboardEvent } from "react";

type Tab = { id: string; label: string };

type Props = {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  /** Builds matching ids: `${idPrefix}-tab-${id}` and `${idPrefix}-panel-${id}`. */
  idPrefix?: string;
  label?: string;
};

export function TabSwitcher({ tabs, active, onChange, idPrefix = "pg", label = "Request" }: Props) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function move(to: number) {
    const next = tabs[to];
    if (!next) return;
    onChange(next.id);
    refs.current[to]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        move(Math.min(index + 1, tabs.length - 1));
        break;
      case "ArrowLeft":
        e.preventDefault();
        move((index - 1 + tabs.length) % tabs.length);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(tabs.length - 1);
        break;
    }
  }

  return (
    <div className="pg-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${idPrefix}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={selected ? `${idPrefix}-panel-${t.id}` : undefined}
            tabIndex={selected ? 0 : -1}
            className={selected ? "pg-tab pg-tab-active" : "pg-tab"}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
""")
    test = F(r"""
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TabSwitcher } from "./TabSwitcher";

const TABS = [
  { id: "params", label: "Params" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
];

function Harness() {
  const [active, setActive] = useState("params");
  return <TabSwitcher tabs={TABS} active={active} onChange={setActive} />;
}

describe("TabSwitcher", () => {
  it("exposes the ARIA tabs pattern", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Request" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Params" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Params" })).toHaveAttribute("aria-controls", "pg-panel-params");
  });

  it("keeps only the selected tab in the tab order", () => {
    render(<Harness />);
    expect(screen.getByRole("tab", { name: "Params" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Headers" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus and selection with ArrowRight", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("tab", { name: "Params" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Headers" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Headers" })).toHaveAttribute("aria-selected", "true");
  });

  it("wraps from the last tab to the first on ArrowRight", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("tab", { name: "Params" }).focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Params" })).toHaveFocus();
  });

  it("wraps from the first tab to the last on ArrowLeft", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("tab", { name: "Params" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Body" })).toHaveFocus();
  });

  it("jumps with Home and End", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("tab", { name: "Params" }).focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Body" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Params" })).toHaveFocus();
  });
});
""")
    return Sess(
        key="aurora-docs/cline/aria-tab-switcher", agent="cline", project=P,
        start=at("2026-10-01", "16:10"), minutes=34, model="claude-sonnet-5-5",
        title="Make the playground TabSwitcher accessible",
        turns=[
            user("src/components/TabSwitcher.tsx is just a row of buttons with onClick. For the interactive API playground "
                 "(Body / Headers tabs) it needs the real ARIA tabs pattern: roles, arrow key navigation with wrapping, "
                 "Home/End, roving tabindex. No new library please."),
            asst("I'll check where the switcher is used, then rewrite it with the tablist roles and a keyboard handler.", [
                read("src/components/TabSwitcher.tsx", tab_v0),
                grep("TabSwitcher", "src",
                     "src/components/ApiPlayground.tsx:4:import { TabSwitcher } from \"./TabSwitcher\";\n"
                     "src/components/ApiPlayground.tsx:63:      <TabSwitcher tabs={TABS} active={tab} onChange={setTab} />\n"
                     "src/pages/Reference.tsx:9:import { TabSwitcher } from \"../components/TabSwitcher\";\n"
                     "src/pages/Reference.tsx:41:        <TabSwitcher tabs={SECTIONS} active={section} onChange={setSection} />"),
                write("src/components/TabSwitcher.tsx", tab_v1),
                write("src/components/TabSwitcher.test.tsx", test),
                bash("npx vitest run src/components/TabSwitcher.test.tsx",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ❯ src/components/TabSwitcher.test.tsx (6 tests | 1 failed) 248ms
   ✓ TabSwitcher > exposes the ARIA tabs pattern
   ✓ TabSwitcher > keeps only the selected tab in the tab order
   ✓ TabSwitcher > moves focus and selection with ArrowRight
   × TabSwitcher > wraps from the last tab to the first on ArrowRight 41ms
     → expect(element).toHaveFocus()
   ✓ TabSwitcher > wraps from the first tab to the last on ArrowLeft
   ✓ TabSwitcher > jumps with Home and End

 FAIL  src/components/TabSwitcher.test.tsx > TabSwitcher > wraps from the last tab to the first on ArrowRight
Error: expect(element).toHaveFocus()

Expected element with focus:

  <button aria-selected="false" class="pg-tab" id="pg-tab-params" role="tab" tabindex="-1" type="button">Params</button>

Received element with focus:

  <button aria-controls="pg-panel-body" aria-selected="true" class="pg-tab pg-tab-active" id="pg-tab-body" role="tab" tabindex="0" type="button">Body</button>

 ❯ src/components/TabSwitcher.test.tsx:55:50

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
"""), error=True, desc="Run the new TabSwitcher tests"),
            ]),
            user("ArrowRight should wrap like ArrowLeft does, fix that. And ApiPlayground needs a real panel with the ids "
                 "the tabs point at, axe flagged aria-controls last week."),
            asst("The right-arrow branch clamped with `Math.min` instead of wrapping, so it stalled on the last tab. "
                 "Fixing that, then giving the playground a matching tabpanel.", [
                edit("src/components/TabSwitcher.tsx",
                     "        move(Math.min(index + 1, tabs.length - 1));",
                     "        move((index + 1) % tabs.length);"),
                edit("src/components/ApiPlayground.tsx",
                     D(r"""
      <TabSwitcher tabs={TABS} active={tab} onChange={setTab} />
      {tab === "body" ? (
"""),
                     D(r"""
      <TabSwitcher tabs={TABS} active={tab} onChange={setTab} label="Request" />
      <div role="tabpanel" id={`pg-panel-${tab}`} aria-labelledby={`pg-tab-${tab}`} tabIndex={0}>
      {tab === "body" ? (
""")),
                edit("src/components/ApiPlayground.tsx",
                     D(r"""
        <pre className="pg-headers">content-type: application/json</pre>
      )}
"""),
                     D(r"""
        <pre className="pg-headers">content-type: application/json</pre>
      )}
      </div>
""")),
                bash("npx vitest run src/components",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/components/CodeSnippet.test.tsx (2 tests) 19ms
 ✓ src/components/CurlGenerator.test.tsx (3 tests) 87ms
 ✓ src/components/TabSwitcher.test.tsx (6 tests) 233ms
 ✓ src/components/ApiPlayground.test.tsx (6 tests) 241ms

 Test Files  4 passed (4)
      Tests  17 passed (17)
   Start at  11:02:18
   Duration  1.58s (transform 131ms, setup 214ms, collect 602ms, tests 340ms, environment 1.21s, prepare 144ms)
"""), desc="Run all component tests"),
            ]),
            user("did you check this with an actual screen reader?"),
            asst("""No. What I verified is the DOM and the keyboard behaviour in jsdom, not how a screen reader announces it.

**What the 6 tests cover**
- `role="tablist"` with a label, `role="tab"` on each button, `aria-selected` on exactly one
- roving `tabindex`: only the selected tab is reachable with Tab
- ArrowRight and ArrowLeft wrap, Home and End jump, and focus follows selection
- the selected tab's `aria-controls` points at `pg-panel-<id>`, which `ApiPlayground` now renders as a `role="tabpanel"` with `aria-labelledby` pointing back

**What I did not check**
- VoiceOver or NVDA announcements ("Body, tab, 2 of 2, selected")
- the Reference page, which also uses `TabSwitcher` but does not render a matching `tabpanel` yet, so its selected tab points at an id that does not exist

```tsx
aria-controls={selected ? `${idPrefix}-panel-${t.id}` : undefined}
```

Only the selected tab sets `aria-controls`, because inactive panels are not in the DOM. I would do a 5 minute VoiceOver pass on the playground and fix `Reference.tsx` before closing the axe ticket.""")
        ],
    )


# ---------------------------------------------------------------------------
# 4. cline: static search index
# ---------------------------------------------------------------------------

def _cline_search():
    script = F(r"""
import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import MiniSearch from "minisearch";
import { SEARCH_OPTIONS, type TopicDoc } from "../src/search/types";

const REFERENCE_DIR = path.resolve("docs/reference");
const OUT_FILE = path.resolve("public/search-index.json");

async function listMarkdown(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory() ? listMarkdown(path.join(dir, e.name)) : [path.join(dir, e.name)],
    ),
  );
  return nested.flat().filter((f) => f.endsWith(".md") || f.endsWith(".mdx"));
}

function stripMarkdown(src: string): string {
  return src
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function toTopic(file: string): Promise<TopicDoc | null> {
  const { data, content } = matter(await fs.readFile(file, "utf8"));
  if (data.hidden === true) return null;
  if (!data.title) {
    throw new Error(`Topic "${path.relative(process.cwd(), file)}" has no title in frontmatter`);
  }
  const id = path.relative(REFERENCE_DIR, file).replace(/\.mdx?$/, "");
  const headings = [...content.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].trim());
  return {
    id,
    title: String(data.title),
    section: String(data.section ?? "General"),
    headings,
    text: stripMarkdown(content),
  };
}

async function main() {
  const files = (await listMarkdown(REFERENCE_DIR)).sort();
  const topics = (await Promise.all(files.map(toTopic))).filter((t): t is TopicDoc => t !== null);

  const index = new MiniSearch<TopicDoc>(SEARCH_OPTIONS);
  index.addAll(topics);

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  const json = JSON.stringify(index);
  await fs.writeFile(OUT_FILE, json);

  const headingCount = topics.reduce((n, t) => n + t.headings.length, 0);
  const kb = (Buffer.byteLength(json) / 1000).toFixed(1);
  console.log(`indexed ${topics.length} topics, ${headingCount} headings -> public/search-index.json (${kb} kB)`);
}

main().catch((err) => {
  console.error(`build-search-index: ${err.message}`);
  process.exit(1);
});
""")
    return Sess(
        key="aurora-docs/cline/static-search-index", agent="cline", project=P,
        start=at("2026-10-07", "14:35"), minutes=27, model="claude-sonnet-5-5",
        title="Build a static search index for the reference topics",
        turns=[
            user("Need a build step that produces a static search index for the reference topics so the docs search "
                 "works without a server. Read docs/reference/**/*.md, use the same MiniSearch options as "
                 "src/search/types.ts so the client can load it, skip anything with `hidden: true`. Put the script in "
                 "scripts/build-search-index.ts and write the index to public/search-index.json."),
            asst("First I'll see what already exists for building the index, then read the search types the client uses.", [
                bash("npm run build:search",
                     "npm error Missing script: \"build:search\"\nnpm error\nnpm error To see a list of scripts, run:\n"
                     "npm error   npm run\n", error=True, desc="Check whether a search build script already exists"),
                bash("find docs/reference -name '*.md*' | wc -l", "      40\n", desc="Count the reference topics"),
                read("src/search/types.ts", F(r"""
export type TopicDoc = {
  id: string;
  title: string;
  section: string;
  headings: string[];
  text: string;
};

export const SEARCH_OPTIONS = {
  fields: ["title", "headings", "text"],
  storeFields: ["title", "section"],
  searchOptions: { boost: { title: 4, headings: 2 }, prefix: true, fuzzy: 0.2 },
};
""")),
                read("docs/reference/pets-list.md", F(r"""
---
title: List pets
section: Pets
---

# List pets

Returns a page of pets. Use `limit` and `cursor` to paginate.

## Query parameters

| Name | Type | Description |
| --- | --- | --- |
| `limit` | integer | Page size, 1 to 100. Defaults to 25. |
| `cursor` | string | Opaque cursor from the previous page. |

## Example

```bash
curl http://localhost:4010/v1/pets?limit=5
```
"""), limit=22),
                write("scripts/build-search-index.ts", script),
                edit("package.json",
                     '    "build:docs": "vite build --mode docs",',
                     '    "build:docs": "vite build --mode docs",\n    "build:search": "tsx scripts/build-search-index.ts",'),
            ]),
            user("run it and check the size, I want the index under 150 kB"),
            asst("Running the script and checking the output file.", [
                bash("npm run build:search",
                     "\n> aurora-docs@0.9.0 build:search\n> tsx scripts/build-search-index.ts\n\n"
                     "build-search-index: Topic \"docs/reference/auth-keys.md\" has no title in frontmatter\n",
                     error=True, desc="Build the index"),
                bash("grep -n -m3 '^# ' docs/reference/auth-keys.md docs/reference/webhooks.md",
                     "docs/reference/auth-keys.md:1:# Authentication keys\ndocs/reference/webhooks.md:1:# Webhooks\n",
                     desc="See how topics without frontmatter are headed"),
                edit("scripts/build-search-index.ts",
                     D(r"""
  if (!data.title) {
    throw new Error(`Topic "${path.relative(process.cwd(), file)}" has no title in frontmatter`);
  }
"""),
                     D(r"""
  // a few older topics have no frontmatter; fall back to the first h1
  const title = data.title ?? content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!title) {
    throw new Error(`Topic "${path.relative(process.cwd(), file)}" has no title in frontmatter or h1`);
  }
""")),
                edit("scripts/build-search-index.ts",
                     "    title: String(data.title),",
                     "    title: String(title),"),
                bash("npm run build:search",
                     "\n> aurora-docs@0.9.0 build:search\n> tsx scripts/build-search-index.ts\n\n"
                     "indexed 38 topics, 214 headings -> public/search-index.json (87.3 kB)\n",
                     desc="Build the index again"),
                bash("grep -rl 'hidden: true' docs/reference",
                     "docs/reference/changelog-draft.md\ndocs/reference/internal/rate-notes.md\n",
                     desc="List the hidden topics"),
                bash("npx vitest run src/search",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/search/loadIndex.test.ts (3 tests) 21ms
 ✓ src/search/rank.test.ts (4 tests) 9ms

 Test Files  2 passed (2)
      Tests  7 passed (7)
   Start at  09:58:12
   Duration  812ms (transform 46ms, setup 0ms, collect 130ms, tests 30ms, environment 0ms, prepare 61ms)
"""), desc="Run the search tests"),
            ]),
            user("ok. does the script skip the unlisted pages marketing keeps asking about?"),
            asst("""Yes. The index is **87.3 kB**, so it is under your 150 kB budget with room to grow.

- 40 files under `docs/reference`, 2 of them marked `hidden: true` (`changelog-draft.md` and `internal/rate-notes.md`), so **38 topics** were indexed. `toTopic` returns `null` for hidden pages and `main` filters those out before they reach MiniSearch.
- The first run failed: `auth-keys.md` has no frontmatter. I made the title fall back to the first `# ` heading, and the script still fails loudly if neither exists, so a new untitled page cannot slip into the index silently.
- Index options come from `SEARCH_OPTIONS` in `src/search/types.ts`, so the client and the build cannot drift apart.

```json
"build:search": "tsx scripts/build-search-index.ts"
```

I did not add a unit test for the hidden-page rule; the existing `src/search` tests (7) pass but only exercise loading and ranking. It is not wired into `npm run build` yet, so for now the index has to be built by hand before a deploy.""")
        ],
    )


# ---------------------------------------------------------------------------
# 5. opencode: HMAC request signing in the playground
# ---------------------------------------------------------------------------

def _opencode_hmac():
    signing = F(r"""
const encoder = new TextEncoder();

export type SignInput = {
  method: string;
  /** Path plus query string, exactly as sent, e.g. /v1/pets?limit=5 */
  target: string;
  body: string;
  secret: string;
  /** Unix seconds. Injected so tests are deterministic. */
  timestamp: number;
};

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** Canonical string: METHOD, target, timestamp and the SHA-256 of the body, one per line. */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const bodyHash = await sha256Hex(input.body);
  const canonical = [input.method.toUpperCase(), input.target, String(input.timestamp), bodyHash].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical));
  return {
    "x-aurora-timestamp": String(input.timestamp),
    "x-aurora-signature": `v1=${toHex(mac)}`,
  };
}
""")
    test = F(r"""
import { describe, expect, it } from "vitest";
import { sha256Hex, signRequest } from "./signing";

const SECRET = "demo-signing-secret";
const BODY = '{"name":"Biscuit","tag":"corgi"}';

describe("signRequest", () => {
  it("hashes an empty body to the well-known empty digest", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("signs a POST with a body", async () => {
    const headers = await signRequest({
      method: "post",
      target: "/v1/pets",
      body: BODY,
      secret: SECRET,
      timestamp: 1791300000,
    });
    expect(headers["x-aurora-timestamp"]).toBe("1791300000");
    expect(headers["x-aurora-signature"]).toBe(
      "v1=7b9daa830c95e8d72468b5fe85672f21d6317a5850fc187e59968e0c293df753",
    );
  });

  it("signs a GET with the query string and no body", async () => {
    const headers = await signRequest({
      method: "GET",
      target: "/v1/pets?limit=5",
      body: "",
      secret: SECRET,
      timestamp: 1791300000,
    });
    expect(headers["x-aurora-signature"]).toBe(
      "v1=2428f18ae11248cef2257fbc0d7cc608f42638d4748a2167e455e9a4406c2be3",
    );
  });

  it("changes the signature when the body changes", async () => {
    const base = { method: "POST", target: "/v1/pets", secret: SECRET, timestamp: 1791300000 };
    const a = await signRequest({ ...base, body: BODY });
    const b = await signRequest({ ...base, body: BODY.replace("corgi", "beagle") });
    expect(a["x-aurora-signature"]).not.toBe(b["x-aurora-signature"]);
  });
});
""")
    return Sess(
        key="aurora-docs/opencode/hmac-request-signing", agent="opencode", project=P,
        start=at("2026-10-08", "18:00"), minutes=58, model="claude-sonnet-5-5",
        title="Sign sandbox requests with HMAC in the playground",
        turns=[
            user("The sandbox API now rejects unsigned writes. Add HMAC-SHA256 request signing to the interactive API "
                 "playground: a secret field, and when it's set send x-aurora-timestamp and x-aurora-signature. "
                 "Canonical string is METHOD, target (path + query), timestamp, and the sha256 hex of the body, joined "
                 "with newlines. Use WebCrypto, no new deps. Keep the signing in its own module so it's testable."),
            asst("I'll look at where the playground builds its request, then add the signing module with known-answer tests.", [
                grep("sandboxFetch", "src/components/ApiPlayground.tsx",
                     "src/components/ApiPlayground.tsx:3:import { sandboxFetch } from \"../playground/sandboxFetch\";\n"
                     "src/components/ApiPlayground.tsx:42:      const res = await sandboxFetch(baseUrl + path, {"),
                read("src/components/ApiPlayground.tsx", F(r"""
  const [busy, setBusy] = useState(false);
  const issues = useMemo(() => validate?.(body) ?? [], [validate, body]);

  // a different operation means the old response no longer applies
  useEffect(() => {
    setStatus(null);
    setPayload("");
  }, [method, baseUrl, path]);

  async function send() {
    setBusy(true);
    try {
      const res = await sandboxFetch(baseUrl + path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : body,
      });
      setStatus(`${res.status} ${res.statusText}`);
      setPayload(await res.text());
    } finally {
      setBusy(false);
    }
  }
"""), start=29, limit=22),
                write("src/playground/signing.ts", signing),
                write("src/playground/signing.test.ts", test),
                bash("npx vitest run src/playground/signing.test.ts",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ❯ src/playground/signing.test.ts (4 tests | 4 failed) 18ms
   × signRequest > hashes an empty body to the well-known empty digest 4ms
     → Cannot read properties of undefined (reading 'digest')
   × signRequest > signs a POST with a body 2ms
     → Cannot read properties of undefined (reading 'digest')
   × signRequest > signs a GET with the query string and no body 1ms
     → Cannot read properties of undefined (reading 'digest')
   × signRequest > changes the signature when the body changes 1ms
     → Cannot read properties of undefined (reading 'digest')

 FAIL  src/playground/signing.test.ts > signRequest > hashes an empty body to the well-known empty digest
TypeError: Cannot read properties of undefined (reading 'digest')
 ❯ sha256Hex src/playground/signing.ts:18:49
 ❯ src/playground/signing.test.ts:10:18

 Test Files  1 failed (1)
      Tests  4 failed (4)
"""), error=True, desc="Run the signing tests"),
            ]),
            user("is that the jsdom thing? we hit the same missing crypto.subtle in the uploader tests last quarter"),
            asst("Yes, `crypto.subtle` is undefined in the jsdom environment, so the code is fine and the test setup is "
                 "missing it. I'll add Node's WebCrypto to the shared setup file, then wire signing into the playground.", [
                read("src/test/setup.ts", F(r"""
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
""")),
                edit("src/test/setup.ts",
                     D(r"""
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
"""),
                     D(r"""
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, vi } from "vitest";

// jsdom has no crypto.subtle; Node's WebCrypto is the same API the browser provides
if (!globalThis.crypto?.subtle) {
  vi.stubGlobal("crypto", webcrypto);
}
""")),
                bash("npx vitest run src/playground/signing.test.ts",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/playground/signing.test.ts (4 tests) 23ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  13:08:51
   Duration  941ms (transform 44ms, setup 187ms, collect 79ms, tests 23ms, environment 604ms, prepare 52ms)
"""), desc="Run the signing tests again"),
                edit("src/components/ApiPlayground.tsx",
                     "  const [busy, setBusy] = useState(false);\n",
                     D(r"""
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState(() => sessionStorage.getItem(SECRET_KEY) ?? "");
""") + "\n"),
                edit("src/components/ApiPlayground.tsx",
                     D(r"""
      const res = await sandboxFetch(baseUrl + path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : body,
      });
"""),
                     D(r"""
      const requestBody = method === "GET" ? undefined : body;
      const signed = secret
        ? await signRequest({
            method,
            target: path,
            body: requestBody ?? "",
            secret,
            timestamp: Math.floor(Date.now() / 1000),
          })
        : {};
      const res = await sandboxFetch(baseUrl + path, {
        method,
        headers: { "content-type": "application/json", ...signed },
        body: requestBody,
      });
""")),
                edit("src/components/ApiPlayground.tsx",
                     "        <code>{path}</code>\n",
                     D(r"""
        <code>{path}</code>
        <input
          type="password"
          className="pg-secret"
          aria-label="Signing secret"
          placeholder="Signing secret (optional)"
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value);
            sessionStorage.setItem(SECRET_KEY, e.target.value);
          }}
        />
""") + "\n"),
                bash("npx tsc --noEmit",
                     "src/components/ApiPlayground.tsx(8,3): error TS2304: Cannot find name 'SECRET_KEY'.\n"
                     "src/components/ApiPlayground.tsx(46,17): error TS2304: Cannot find name 'signRequest'.\n",
                     error=True, desc="Type check"),
                edit("src/components/ApiPlayground.tsx",
                     'import { CodeSnippet } from "./CodeSnippet";\n',
                     D(r"""
import { signRequest } from "../playground/signing";
import { CodeSnippet } from "./CodeSnippet";
""") + "\n"),
                edit("src/components/ApiPlayground.tsx",
                     "const TABS = [",
                     D(r"""
const SECRET_KEY = "aurora.playground.signing-secret";

const TABS = [
""")),
                bash("npx tsc --noEmit && npx vitest run src/playground src/components/ApiPlayground.test.tsx",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/playground/curl.test.ts (6 tests) 8ms
 ✓ src/playground/migrate.test.ts (5 tests) 7ms
 ✓ src/playground/rateLimiter.test.ts (3 tests) 12ms
 ✓ src/playground/signing.test.ts (4 tests) 22ms
 ✓ src/components/ApiPlayground.test.tsx (6 tests) 226ms

 Test Files  5 passed (5)
      Tests  24 passed (24)
   Start at  13:21:36
   Duration  1.49s (transform 133ms, setup 391ms, collect 540ms, tests 275ms, environment 1.43s, prepare 148ms)
"""), desc="Type check and run the playground tests"),
            ]),
            user("where does the secret live? I don't want it ending up in saved collections or the URL"),
            asst("""It lives in two places only: the component's state and `sessionStorage` under `aurora.playground.signing-secret`, which the browser clears when the tab closes. It never goes into `localStorage`.

- **Saved collections** store method, path, headers and body. Signing happens inside `send()`, after the request is read from state, so `x-aurora-signature` and `x-aurora-timestamp` are never part of a saved request. I did not write a test for that, it follows from how `send()` is structured.
- **URL:** nothing reads or writes it, there is no query parameter involved.
- **Display:** the field is `type="password"`, so screenshots show dots.

```ts
const signed = secret
  ? await signRequest({ method, target: path, body: requestBody ?? "", secret, timestamp: Math.floor(Date.now() / 1000) })
  : {};
```

Two caveats. The first `tsc` run failed because I used `SECRET_KEY` and `signRequest` before importing or declaring them; both are fixed. And the shared test setup now stubs `crypto` with Node's WebCrypto when jsdom lacks it, which any other test touching `crypto.subtle` will pick up. The known-answer signatures in `signing.test.ts` are computed from the canonical string described in the task, so they only prove the playground matches that spec, not that the sandbox accepts it; that needs one real request against the sandbox.""")
        ],
    )


# ---------------------------------------------------------------------------
# 6. opencode: schema migration of saved collections + client-side rate limiter
# ---------------------------------------------------------------------------

def _opencode_collections():
    collections_v0 = F(r"""
export type SavedRequestV1 = { name: string; method: string; url: string; body?: string };
export type CollectionsV1 = { version: 1; items: SavedRequestV1[] };

const KEY = "aurora.playground.collections";

export function loadCollections(): CollectionsV1 {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CollectionsV1) : { version: 1, items: [] };
  } catch {
    return { version: 1, items: [] };
  }
}

export function saveCollections(c: CollectionsV1): void {
  localStorage.setItem(KEY, JSON.stringify(c));
}
""")
    collections_v1 = F(r"""
import { migrate } from "./migrate";

export type SavedRequestV1 = { name: string; method: string; url: string; body?: string };
export type CollectionsV1 = { version: 1; items: SavedRequestV1[] };

export type SavedRequest = {
  id: string;
  name: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};
export type Collection = { id: string; name: string; requests: SavedRequest[] };
export type CollectionsV2 = { version: 2; collections: Collection[] };

const KEY = "aurora.playground.collections";
const EMPTY: CollectionsV2 = { version: 2, collections: [] };

export function loadCollections(): CollectionsV2 {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const migrated = migrate(JSON.parse(raw));
    // write back once so the upgrade only happens on the first load
    saveCollections(migrated);
    return migrated;
  } catch {
    return EMPTY;
  }
}

export function saveCollections(c: CollectionsV2): void {
  localStorage.setItem(KEY, JSON.stringify(c));
}
""")
    menu_v0 = F(r"""
import { loadCollections, type SavedRequestV1 } from "../playground/collections";

export function CollectionsMenu({ onPick }: { onPick: (r: SavedRequestV1) => void }) {
  const collections = loadCollections();
  return (
    <ul className="pg-collections">
      {collections.items.map((item) => (
        <li key={item.name}>
          <button onClick={() => onPick(item)}>{item.name}</button>
        </li>
      ))}
    </ul>
  );
}
""")
    migrate_v0 = F(r"""
import type { CollectionsV1, CollectionsV2, SavedRequest } from "./collections";

const DEFAULT_COLLECTION = { id: "col-1", name: "Saved requests" };

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}

export function migrateV1ToV2(old: CollectionsV1): CollectionsV2 {
  const requests: SavedRequest[] = old.items.map((item, i) => ({
    id: `req-${i + 1}`,
    name: item.name,
    method: item.method.toUpperCase(),
    path: pathOf(item.url),
    headers: {},
    body: item.body ?? "",
  }));
  return { version: 2, collections: requests.length ? [{ ...DEFAULT_COLLECTION, requests }] : [] };
}

export function migrate(raw: unknown): CollectionsV2 {
  const value = raw as { version?: number };
  if (value?.version === 2) return raw as CollectionsV2;
  if (value?.version === 1) return migrateV1ToV2(raw as CollectionsV1);
  return { version: 2, collections: [] };
}
""")
    migrate_test = F(r"""
import { describe, expect, it } from "vitest";
import { migrate, migrateV1ToV2 } from "./migrate";

const v1 = {
  version: 1 as const,
  items: [
    { name: "Create pet", method: "post", url: "http://localhost:4010/v1/pets", body: '{"name":"Biscuit"}' },
    { name: "List pets", method: "GET", url: "/v1/pets?limit=5" },
  ],
};

describe("migrateV1ToV2", () => {
  it("carries name, method and body into a single default collection", () => {
    expect(migrateV1ToV2(v1)).toEqual({
      version: 2,
      collections: [
        {
          id: "col-1",
          name: "Saved requests",
          requests: [
            {
              id: "req-1",
              name: "Create pet",
              method: "POST",
              path: "/v1/pets",
              headers: { "content-type": "application/json" },
              body: '{"name":"Biscuit"}',
            },
            { id: "req-2", name: "List pets", method: "GET", path: "/v1/pets?limit=5", headers: {}, body: "" },
          ],
        },
      ],
    });
  });

  it("keeps the query string and drops the host", () => {
    const [col] = migrateV1ToV2(v1).collections;
    expect(col.requests[1].path).toBe("/v1/pets?limit=5");
  });

  it("returns no collections when there was nothing saved", () => {
    expect(migrateV1ToV2({ version: 1, items: [] }).collections).toEqual([]);
  });
});

describe("migrate", () => {
  it("leaves a v2 document untouched", () => {
    const v2 = { version: 2 as const, collections: [] };
    expect(migrate(v2)).toBe(v2);
  });

  it("falls back to empty for unknown shapes", () => {
    expect(migrate({ version: 7 })).toEqual({ version: 2, collections: [] });
    expect(migrate(null)).toEqual({ version: 2, collections: [] });
  });
});
""")
    limiter = F(r"""
export type RateLimiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Lets at most `limit` tasks start in any `windowMs`; the rest wait their turn in order. */
export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const starts: number[] = [];
  let chain: Promise<void> = Promise.resolve();

  async function waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (starts.length > 0 && now - starts[0] >= windowMs) starts.shift();
      if (starts.length < limit) {
        starts.push(now);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, windowMs - (now - starts[0])));
    }
  }

  return (task) => {
    const slot = chain.then(waitForSlot);
    chain = slot;
    return slot.then(task);
  };
}
""")
    limiter_test = F(r"""
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "./rateLimiter";

describe("createRateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts calls immediately while under the limit", async () => {
    const limit = createRateLimiter(2, 1000);
    const task = vi.fn(async () => "ok");
    await Promise.all([limit(task), limit(task)]);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("delays the call that exceeds the limit until the window has passed", async () => {
    const limit = createRateLimiter(2, 1000);
    const started: number[] = [];
    const task = async () => {
      started.push(Date.now());
    };
    const t0 = Date.now();
    const all = Promise.all([limit(task), limit(task), limit(task)]);
    await vi.advanceTimersByTimeAsync(1000);
    await all;
    expect(started.map((t) => t - t0)).toEqual([0, 0, 1000]);
  });

  it("keeps serving later calls after one rejects", async () => {
    const limit = createRateLimiter(1, 100);
    await expect(
      limit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const next = limit(async () => "fine");
    await vi.advanceTimersByTimeAsync(100);
    await expect(next).resolves.toBe("fine");
  });
});
""")
    return Sess(
        key="aurora-docs/opencode/collections-migration-limiter", agent="opencode", project=P,
        start=at("2026-10-02", "15:45"), minutes=38, model="claude-sonnet-5-5",
        title="Migrate saved playground collections to v2",
        turns=[
            user("Saved requests in the playground are stored in localStorage as a flat v1 list. Collections are coming, "
                 "so I need a schema migration to v2: collections that each hold requests with an id, a path instead of "
                 "a full url, and a headers map. Existing users must keep what they saved. Migrate on load and write "
                 "it back."),
            asst("Starting with the storage module and the one component that reads it.", [
                read("src/playground/collections.ts", collections_v0),
                read("src/components/CollectionsMenu.tsx", menu_v0),
                write("src/playground/migrate.ts", migrate_v0),
                write("src/playground/migrate.test.ts", migrate_test),
                edit("src/playground/collections.ts", D(collections_v0), D(collections_v1)),
                edit("src/components/CollectionsMenu.tsx",
                     D(r"""
import { loadCollections, type SavedRequestV1 } from "../playground/collections";

export function CollectionsMenu({ onPick }: { onPick: (r: SavedRequestV1) => void }) {
  const collections = loadCollections();
  return (
    <ul className="pg-collections">
      {collections.items.map((item) => (
        <li key={item.name}>
          <button onClick={() => onPick(item)}>{item.name}</button>
        </li>
      ))}
    </ul>
  );
}
"""),
                     D(r"""
import { loadCollections, type SavedRequest } from "../playground/collections";

export function CollectionsMenu({ onPick }: { onPick: (r: SavedRequest) => void }) {
  const { collections } = loadCollections();
  return (
    <div className="pg-collections">
      {collections.map((col) => (
        <section key={col.id}>
          <h4>{col.name}</h4>
          <ul>
            {col.requests.map((req) => (
              <li key={req.id}>
                <button onClick={() => onPick(req)}>{req.name}</button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
""")),
                bash("npx vitest run src/playground/migrate.test.ts",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ❯ src/playground/migrate.test.ts (5 tests | 1 failed) 17ms
   × migrateV1ToV2 > carries name, method and body into a single default collection 6ms
     → expected { version: 2, collections: [ { …(3) } ] } to deeply equal { version: 2, collections: [ { …(3) } ] }

 FAIL  src/playground/migrate.test.ts > migrateV1ToV2 > carries name, method and body into a single default collection
AssertionError: expected { version: 2, collections: [ { …(3) } ] } to deeply equal { version: 2, collections: [ { …(3) } ] }

- Expected
+ Received

@@ -6,9 +6,7 @@
         "body": "{\"name\":\"Biscuit\"}",
-        "headers": {
-          "content-type": "application/json",
-        },
+        "headers": {},
         "id": "req-1",
         "method": "POST",
         "name": "Create pet",

 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
"""), error=True, desc="Run the migration tests"),
                edit("src/playground/migrate.ts",
                     "    headers: {},\n    body: item.body ?? \"\",",
                     "    // v1 always sent JSON for requests that had a body\n"
                     "    headers: item.body ? { \"content-type\": \"application/json\" } : {},\n"
                     "    body: item.body ?? \"\","),
                bash("npx vitest run src/playground/migrate.test.ts",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/playground/migrate.test.ts (5 tests) 9ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  10:51:03
   Duration  655ms (transform 35ms, setup 0ms, collect 61ms, tests 9ms, environment 0ms, prepare 47ms)
"""), desc="Run the migration tests again"),
            ]),
            user("Good. Separate thing while you're in there: add a client-side rate limiter that throttles requests the "
                 "playground sends to the sandbox. It answers 429 above 5 per second per IP and people mash Send."),
            asst("Adding a small sliding-window limiter, a shared `sandboxFetch` wrapper around it, and pointing the playground at that.", [
                write("src/playground/rateLimiter.ts", limiter),
                write("src/playground/rateLimiter.test.ts", limiter_test),
                write("src/playground/sandboxFetch.ts", F(r"""
import { createRateLimiter } from "./rateLimiter";

// one limiter for the whole page, so several playgrounds share the sandbox's 5 per second budget
const limiter = createRateLimiter(5, 1000);

export function sandboxFetch(input: string, init?: RequestInit): Promise<Response> {
  return limiter(() => fetch(input, init));
}
""")),
                edit("src/components/ApiPlayground.tsx",
                     'import { CodeSnippet } from "./CodeSnippet";\n',
                     'import { sandboxFetch } from "../playground/sandboxFetch";\nimport { CodeSnippet } from "./CodeSnippet";\n'),
                edit("src/components/ApiPlayground.tsx",
                     "      const res = await fetch(baseUrl + path, {",
                     "      const res = await sandboxFetch(baseUrl + path, {"),
                bash("npx tsc --noEmit && npx vitest run src/playground src/components/ApiPlayground.test.tsx",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/playground/curl.test.ts (6 tests) 7ms
 ✓ src/playground/migrate.test.ts (5 tests) 8ms
 ✓ src/playground/rateLimiter.test.ts (3 tests) 11ms
 ✓ src/components/ApiPlayground.test.tsx (6 tests) 219ms

 Test Files  4 passed (4)
      Tests  20 passed (20)
   Start at  11:08:27
   Duration  1.44s (transform 109ms, setup 301ms, collect 455ms, tests 245ms, environment 1.12s, prepare 131ms)
"""), desc="Type check and run the playground tests"),
            ]),
            user("what happens when someone mashes Send now? does it just drop clicks?"),
            asst("""No clicks are dropped, they queue. The `busy` flag already disables the button while a request is in flight, so in practice you only reach the limiter with several playgrounds sending at once, or on a fast sandbox where each reply comes back in a few milliseconds.

How the limiter behaves, from `rateLimiter.test.ts` (fake timers):
- the first 5 calls in a second start immediately
- the 6th waits until the oldest start is 1000 ms old, then runs; later calls keep their order
- a rejected task does not block the ones behind it

```ts
const limiter = createRateLimiter(5, 1000);
export const sandboxFetch = (input: string, init?: RequestInit) =>
  limiter(() => fetch(input, init));
```

**Migration:** `loadCollections()` now returns the v2 shape, migrates v1 data on first load and writes it back, so a second load does no work. v1 requests that had a body get `content-type: application/json` in `headers`, because that is what the old playground always sent. One real failure on the way: my first version dropped that header and the migration test caught it.

**Not done:** the limiter does not react to a 429 that still comes back, for example when two browser tabs share one IP. Retrying with backoff on 429 would be the next step. I also did not add a UI for creating collections, `CollectionsMenu` just lists what the migration produced.""")
        ],
    )


# ---------------------------------------------------------------------------
# 7. cursor-cli: copy buttons on code snippets
# ---------------------------------------------------------------------------

def _cursor_copy():
    snippet_v0 = F(r"""
import { highlight } from "../lib/highlight";

type Props = { code: string; lang?: string };

export function CodeSnippet({ code, lang = "text" }: Props) {
  const html = highlight(code, lang);
  return (
    <figure className="cs">
      <figcaption className="cs-lang">{lang}</figcaption>
      <pre className="cs-pre">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </figure>
  );
}
""")
    snippet_v1 = F(r"""
import { useEffect, useRef, useState } from "react";
import { highlight } from "../lib/highlight";

type Props = { code: string; lang?: string };

export function CodeSnippet({ code, lang = "text" }: Props) {
  const html = highlight(code, lang);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <figure className="cs">
      <figcaption className="cs-lang">{lang}</figcaption>
      <button type="button" className="cs-copy" onClick={copy} disabled={!code}>
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="cs-sr" role="status" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
      <pre className="cs-pre">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </figure>
  );
}
""")
    return Sess(
        key="aurora-docs/cursor-cli/snippet-copy-buttons", agent="cursor-cli", project=P,
        start=at("2026-09-28", "14:30"), minutes=9, model="claude-sonnet-5-5",
        title="Add copy buttons to playground code snippets",
        turns=[
            user("code snippets in the interactive API playground have no copy button, people select the curl by hand. "
                 "add one top right of CodeSnippet that says Copied for a couple of seconds, style it in playground.css"),
            asst("CodeSnippet is small, so the button goes in the component and the positioning in the stylesheet.", [
                read("src/components/CodeSnippet.tsx", snippet_v0),
                edit("src/components/CodeSnippet.tsx", D(snippet_v0), D(snippet_v1)),
                edit("src/styles/playground.css",
                     D(r"""
.cs-lang {
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--pg-fg);
}
"""),
                     D(r"""
.cs {
  position: relative;
}

.cs-lang {
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--pg-fg);
}

.cs-copy {
  position: absolute;
  top: 0.4rem;
  right: 0.5rem;
  padding: 0.15rem 0.55rem;
  font-size: 0.75rem;
  border: 1px solid var(--pg-border);
  border-radius: 4px;
  background: var(--pg-bg);
  color: var(--pg-fg);
  cursor: pointer;
}

.cs-copy:disabled {
  opacity: 0.4;
  cursor: default;
}

.cs-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
""")),
            ]),
            user("does it tell screen readers it copied? we got an a11y bug about that last month"),
            asst("""Yes. The button text flips to "Copied" for 2 seconds, and a visually hidden `role="status"` region with `aria-live="polite"` announces "Copied to clipboard" at the same moment, so a screen reader hears it without focus moving off the button.

```tsx
<span className="cs-sr" role="status" aria-live="polite">
  {copied ? "Copied to clipboard" : ""}
</span>
```

- the region is always in the DOM and only its text changes, which is what makes live regions announce reliably
- the button is disabled when there is no code, so an empty response pane has nothing to copy
- the reset timer is cleared on unmount and on a second click, so rapid clicks do not flip the label early

I have not run this in a browser or with a screen reader, and there is no test for it yet. `navigator.clipboard` needs a secure context, so it works on `localhost` and HTTPS but would throw on a plain HTTP preview over a LAN address.""")
        ],
    )


# ---------------------------------------------------------------------------
# 8. github-copilot-cli: curl generator widget
# ---------------------------------------------------------------------------

def _copilot_curl():
    curl_ts = F(r"""
export type CurlInput = {
  method: string;
  url: string;
  headers?: Array<[string, string]>;
  body?: string;
};

/** Wrap a value in single quotes so the shell sees one literal word. */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `\'`)}'`;
}

export function buildCurl({ method, url, headers = [], body }: CurlInput): string {
  const parts = ["curl"];
  if (method !== "GET") parts.push("-X", method);
  parts.push(shellQuote(url));
  for (const [name, value] of headers) {
    if (!name.trim()) continue;
    parts.push("-H", shellQuote(`${name}: ${value}`));
  }
  if (body && method !== "GET" && method !== "HEAD") {
    parts.push("--data-raw", shellQuote(body));
  }
  return parts.join(" ");
}
""")
    curl_test = F(r"""
import { describe, expect, it } from "vitest";
import { buildCurl, shellQuote } from "./curl";

describe("shellQuote", () => {
  it("leaves simple words alone", () => {
    expect(shellQuote("http://localhost:4010/v1/pets")).toBe("http://localhost:4010/v1/pets");
  });

  it("quotes values with spaces", () => {
    expect(shellQuote("accept: application/json")).toBe("'accept: application/json'");
  });

  it("escapes single quotes", () => {
    expect(shellQuote("O'Brien")).toBe("'O'\\''Brien'");
  });
});

describe("buildCurl", () => {
  it("omits -X for GET", () => {
    expect(buildCurl({ method: "GET", url: "http://localhost:4010/v1/pets?limit=5" })).toBe(
      "curl 'http://localhost:4010/v1/pets?limit=5'",
    );
  });

  it("adds headers and a quoted body for POST", () => {
    expect(
      buildCurl({
        method: "POST",
        url: "http://localhost:4010/v1/pets",
        headers: [["content-type", "application/json"]],
        body: '{"name":"O\'Brien"}',
      }),
    ).toBe(
      "curl -X POST http://localhost:4010/v1/pets -H 'content-type: application/json' --data-raw '{\"name\":\"O'\\''Brien\"}'",
    );
  });

  it("skips headers with an empty name", () => {
    expect(buildCurl({ method: "GET", url: "http://localhost:4010/", headers: [[" ", "x"]] })).toBe(
      "curl http://localhost:4010/",
    );
  });
});
""")
    gen_v0 = F(r"""
import { useMemo, useState } from "react";
import { buildCurl } from "../playground/curl";
import { CodeSnippet } from "./CodeSnippet";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function CurlGenerator({ initialUrl = "http://localhost:4010/v1/pets" }: { initialUrl?: string }) {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState(initialUrl);
  const [headers, setHeaders] = useState<Array<[string, string]>>([["accept", "application/json"]]);
  const [body, setBody] = useState("");

  const command = useMemo(() => buildCurl({ method, url, headers, body }), [method, url, headers, body]);

  function setHeader(i: number, field: 0 | 1, value: string) {
    setHeaders((prev) => prev.map((h, j) => (j === i ? (field === 0 ? [value, h[1]] : [h[0], value]) : h)));
  }

  return (
    <section className="pg-curl" aria-label="curl command generator">
      <div className="pg-curl-row">
        <select aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input aria-label="URL" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      {headers.map(([name, value], i) => (
        <div className="pg-curl-row" key={i}>
          <input aria-label={`Header ${i + 1} name`} value={name} onChange={(e) => setHeader(i, 0, e.target.value)} />
          <input aria-label={`Header ${i + 1} value`} value={value} onChange={(e) => setHeader(i, 1, e.target.value)} />
        </div>
      ))}
      <button type="button" onClick={() => setHeaders([...headers, ["", ""]])}>
        Add header
      </button>
      <textarea aria-label="Body" value={body} onChange={(e) => setBody(e.target.value)} />
      <CodeSnippet code={command} lang="bash" />
    </section>
  );
}
""")
    return Sess(
        key="aurora-docs/github-copilot-cli/curl-generator-widget", agent="github-copilot-cli", project=P,
        start=at("2026-09-28", "19:30"), minutes=31, model="gpt-6.1",
        title="Add a curl generator widget to the playground docs",
        turns=[
            user("add a curl command generator widget for the interactive API playground docs. pick a method, enter a "
                 "url, add headers and a json body, and show the curl command live. shell quoting has to be right, "
                 "bodies will contain single quotes (names like O'Brien)"),
            asst("I'll look at how CodeSnippet renders so the widget can reuse it, then keep the quoting in a small pure module that I can test.", [
                ls("src/components", "ApiPlayground.test.tsx\nApiPlayground.tsx\nCodeSnippet.test.tsx\nCodeSnippet.tsx\nTabSwitcher.tsx\n"),
                read("src/components/CodeSnippet.tsx",
                     F(r"""
import { useEffect, useRef, useState } from "react";
import { highlight } from "../lib/highlight";

type Props = { code: string; lang?: string };

export function CodeSnippet({ code, lang = "text" }: Props) {
  const html = highlight(code, lang);
  const [copied, setCopied] = useState(false);
""")),
                write("src/playground/curl.ts", curl_ts),
                write("src/playground/curl.test.ts", curl_test),
                bash("npx vitest run src/playground/curl.test.ts",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ❯ src/playground/curl.test.ts (6 tests | 1 failed) 11ms
   × shellQuote > escapes single quotes 3ms
     → expected "'O\\'Brien'" to be "'O'\\''Brien'" // Object.is equality

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
"""), error=True, desc="Run the curl helper tests"),
                edit("src/playground/curl.ts",
                     "  return `'${value.replace(/'/g, `\\'`)}'`;",
                     "  return `'${value.replace(/'/g, `'\\\\''`)}'`;"),
                bash("npx vitest run src/playground/curl.test.ts",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/playground/curl.test.ts (6 tests) 8ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
"""), desc="Run the curl helper tests again"),
                write("src/components/CurlGenerator.tsx", gen_v0),
            ]),
            user("nice. the Authorization header value shouldn't show in plain text by default, docs readers share "
                 "screenshots. mask it with a Show toggle"),
            asst("Masking any header named Authorization in the editor row, while the generated command keeps the real value so it still works when copied.", [
                edit("src/components/CurlGenerator.tsx",
                     D(r"""
          <input aria-label={`Header ${i + 1} name`} value={name} onChange={(e) => setHeader(i, 0, e.target.value)} />
          <input aria-label={`Header ${i + 1} value`} value={value} onChange={(e) => setHeader(i, 1, e.target.value)} />
"""),
                     D(r"""
          <input aria-label={`Header ${i + 1} name`} value={name} onChange={(e) => setHeader(i, 0, e.target.value)} />
          <input
            aria-label={`Header ${i + 1} value`}
            type={name.toLowerCase() === "authorization" && !revealed ? "password" : "text"}
            value={value}
            onChange={(e) => setHeader(i, 1, e.target.value)}
          />
          {name.toLowerCase() === "authorization" && (
            <button type="button" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>
              {revealed ? "Hide" : "Show"}
            </button>
          )}
""")),
                edit("src/components/CurlGenerator.tsx",
                     '  const [body, setBody] = useState("");\n',
                     '  const [body, setBody] = useState("");\n  const [revealed, setRevealed] = useState(false);\n'),
                edit("src/styles/playground.css",
                     ".pg-header {",
                     D(r"""
.pg-curl {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--pg-border);
}

.pg-curl-row {
  display: flex;
  gap: 0.5rem;
}

.pg-curl-row input {
  flex: 1;
  min-width: 0;
}

.pg-header {
""")),
                write("src/components/CurlGenerator.test.tsx", F(r"""
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CurlGenerator } from "./CurlGenerator";

describe("CurlGenerator", () => {
  it("shows a plain GET command by default", () => {
    render(<CurlGenerator />);
    expect(screen.getByText(/curl/)).toHaveTextContent("-H 'accept: application/json'");
  });

  it("quotes a body that contains a single quote", async () => {
    const user = userEvent.setup();
    render(<CurlGenerator />);
    await user.selectOptions(screen.getByLabelText("Method"), "POST");
    await user.type(screen.getByLabelText("Body"), "O'Brien");
    expect(screen.getByText(/--data-raw/)).toHaveTextContent("--data-raw 'O'\\''Brien'");
  });

  it("masks the Authorization value until Show is pressed", async () => {
    const user = userEvent.setup();
    render(<CurlGenerator />);
    await user.click(screen.getByRole("button", { name: "Add header" }));
    await user.type(screen.getByLabelText("Header 2 name"), "Authorization");
    expect(screen.getByLabelText("Header 2 value")).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByLabelText("Header 2 value")).toHaveAttribute("type", "text");
  });
});
""")),
                bash("npx vitest run src/components/CurlGenerator.test.tsx",
                     F(r"""
 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/components/CurlGenerator.test.tsx (3 tests) 87ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
"""), desc="Run the widget tests"),
            ]),
            user("what happens with a body on a GET? people paste one by accident"),
            asst("""`buildCurl` ignores the body for `GET` and `HEAD`, so the command stays a plain read and the pasted text is simply not included. The textarea still keeps what was typed, so switching to `POST` brings it back.

**What was added**
- `src/playground/curl.ts`: `shellQuote` and `buildCurl`, pure functions with 6 tests
- `src/components/CurlGenerator.tsx`: method select, URL, header rows, body, and a `CodeSnippet` that shows the command live
- Authorization values render as a password field with a Show / Hide toggle; the copied command keeps the real value
- 3 component tests, styles in `playground.css`

```ts
return `'${value.replace(/'/g, `'\\''`)}'`;
```

The quoting bug was mine: the first version escaped a single quote as `\\'`, which is not valid inside single quotes in a shell, and the `O'Brien` test caught it. The fix closes the quote, adds an escaped quote and reopens it.

Not covered: values containing newlines, and non-ASCII header names. The widget is not mounted on any page yet, it still needs an `<CurlGenerator />` in the Authentication guide.""")
        ],
    )


# ---------------------------------------------------------------------------
# 9. aider: Copy as curl in the playground (Sunday evening side work)
# ---------------------------------------------------------------------------

def _aider_curl():
    return Sess(
        key="aurora-docs/aider/copy-as-curl-export", agent="aider", project=P,
        start=at("2026-10-04", "21:10"), minutes=12, model="claude-sonnet-5-5",
        title="Copy as curl button in the playground",
        turns=[
            user("Add a \"Copy as curl\" button to the header of the playground in src/components/ApiPlayground.tsx.\n"
                 "Use buildCurl from ../playground/curl with the current method, url and body, and put the command on the clipboard.\n"
                 "Then run the component tests."),
            asst("I'll add the export next to Send, building the command from the same state the Send handler uses.", [
                edit("src/components/ApiPlayground.tsx",
                     'import { TabSwitcher } from "./TabSwitcher";',
                     'import { buildCurl } from "../playground/curl";\nimport { TabSwitcher } from "./TabSwitcher";'),
                edit("src/components/ApiPlayground.tsx",
                     "  const [busy, setBusy] = useState(false);\n",
                     "  const [busy, setBusy] = useState(false);\n  const [curlCopied, setCurlCopied] = useState(false);\n"),
                edit("src/components/ApiPlayground.tsx",
                     "  return (\n    <div className=\"pg\">",
                     D(r"""
  async function copyCurl() {
    const command = buildCurl({
      method,
      url: baseUrl + path,
      headers: [["content-type", "application/json"]],
      body: method === "GET" ? undefined : body,
    });
    await navigator.clipboard.writeText(command);
    setCurlCopied(true);
    window.setTimeout(() => setCurlCopied(false), 2000);
  }

  return (
    <div className="pg">
""")),
                edit("src/components/ApiPlayground.tsx",
                     D(r"""
        <button onClick={send} disabled={busy}>
          Send
        </button>
"""),
                     D(r"""
        <button onClick={send} disabled={busy}>
          Send
        </button>
        <button type="button" className="pg-copy-curl" onClick={copyCurl}>
          {curlCopied ? "Copied" : "Copy as curl"}
        </button>
""")),
                bash("npm test -- src/components/ApiPlayground.test.tsx",
                     F(r"""
> aurora-docs@0.9.0 test
> vitest run src/components/ApiPlayground.test.tsx

 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ❯ src/components/ApiPlayground.test.tsx (6 tests | 1 failed) 231ms
   × ApiPlayground > renders the header for a GET operation 38ms
     → Snapshot `ApiPlayground > renders the header for a GET operation 1` mismatched

 FAIL  src/components/ApiPlayground.test.tsx > ApiPlayground > renders the header for a GET operation
Error: Snapshot `ApiPlayground > renders the header for a GET operation 1` mismatched

- Expected
+ Received

@@ -9,6 +9,13 @@
     <button>
       Send
     </button>
+    <button
+      class="pg-copy-curl"
+      type="button"
+    >
+      Copy as curl
+    </button>
   </div>

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
""")),
            ]),
            user("the snapshot diff is only the new button, that's expected. update it, and add a test that the clipboard "
                 "gets the curl string for a POST with a body"),
            asst("", [
                edit("src/components/ApiPlayground.test.tsx",
                     D(r"""
    expect(await screen.findByTestId("response-status")).toHaveTextContent("200 OK");
  });
});
"""),
                     D(r"""
    expect(await screen.findByTestId("response-status")).toHaveTextContent("200 OK");
  });

  it("copies the current request as a curl command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <ApiPlayground
        method="POST"
        baseUrl="http://localhost:4010"
        path="/v1/pets"
        initialBody='{"name":"Biscuit"}'
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Copy as curl" }));
    expect(writeText).toHaveBeenCalledWith(
      "curl -X POST http://localhost:4010/v1/pets -H 'content-type: application/json' --data-raw '{\"name\":\"Biscuit\"}'",
    );
  });
});
""")),
                bash("npm test -- src/components/ApiPlayground.test.tsx -u",
                     F(r"""
> aurora-docs@0.9.0 test
> vitest run src/components/ApiPlayground.test.tsx -u

 RUN  v3.2.4 /Users/fictional-dev/projects/aurora-docs

 ✓ src/components/ApiPlayground.test.tsx (7 tests) 244ms

 Snapshots  1 updated
 Test Files  1 passed (1)
      Tests  7 passed (7)
""")),
            ]),
            user("does buildCurl drop the body for GET like the widget does? just answer, no edits"),
            asst("""Yes, it is the same function the widget uses. `buildCurl` only appends `--data-raw` when the method is not `GET` or `HEAD`, so a leftover body on a GET never reaches the command. The playground also passes `undefined` for GET before calling it, so it is covered twice.

For the new button:
- `Copy as curl` builds the command from `method`, `baseUrl + path`, the JSON content-type header and the current body
- the label switches to `Copied` for two seconds
- the component test checks the exact string written to the clipboard for a POST with a body, and the one snapshot now includes the extra button

One gap: the command does not include the signing headers or any custom headers the Headers tab might gain later, because that tab is still a static line of text.""")
        ],
    )


def sessions():
    return [
        _claude_embed(),
        _claude_flaky(),
        _cline_tabs(),
        _cline_search(),
        _opencode_hmac(),
        _opencode_collections(),
        _cursor_copy(),
        _copilot_curl(),
        _aider_curl(),
    ]
