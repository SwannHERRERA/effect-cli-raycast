import { assert, describe, it } from "@effect/vitest"
import { defineConfig, Manifest, Runner, Spec } from "@effect-cli-raycast/core"
import { acme } from "@effect-cli-raycast/core/testing"
import { Array as Arr, Effect, HashMap, Option } from "effect"
import { eject, ensureEjectable } from "#src/Eject"
import * as Jsx from "#src/Jsx"
import * as Plan from "#src/Plan"

const config = Effect.runSync(
  defineConfig(acme, {
    version: "1.0.0",
    runner: Runner.inProcess(acme, { version: "1.0.0" }),
    preferences: ["url"],
    ai: { tools: false },
    overrides: { logs: { title: "Tail Logs" } }
  }).resolve
)

const plan = (packageJson: Plan.PackageJson, files: Plan.Files) => Plan.plan({ config, packageJson, files })

const applied = (result: Plan.SyncPlan, files: Plan.Files): Plan.Files =>
  HashMap.removeMany(
    HashMap.setMany(
      files,
      result.writes.map((file) => [file.path, file.contents] as const)
    ),
    result.deletes
  )

const names = (entries: ReadonlyArray<Plan.Entry> | undefined) =>
  Option.getOrElse(Option.fromUndefinedOr(entries), Arr.empty<Plan.Entry>).map((entry) => entry.name)

const written = (result: Plan.SyncPlan, path: string) =>
  Option.getOrThrow(Arr.findFirst(result.writes, (file) => file.path === path)).contents

describe("Plan", () => {
  it.effect("generates commands, stubs and preferences from scratch", () =>
    Effect.gen(function* () {
      const result = yield* plan({}, HashMap.empty())
      assert.deepStrictEqual(names(result.packageJson.commands), ["browse", "deploy", "logs", "fail", "db-migrate"])
      assert.deepStrictEqual(
        result.writes.map((file) => file.path),
        ["src/browse.tsx", "src/deploy.tsx", "src/logs.tsx", "src/fail.tsx", "src/db-migrate.tsx"]
      )
      assert.include(written(result, "src/deploy.tsx"), `app.view("deploy")`)
      assert.deepStrictEqual(names(result.packageJson.preferences), ["url"])
      assert.strictEqual(result.packageJson["name"], "acme-raycast")
      const logs = result.packageJson.commands?.find((command) => command.name === "logs")
      assert.strictEqual(logs?.["title"], "Tail Logs")
      assert.deepStrictEqual(logs?.["arguments"], [
        { name: "service", type: "text", placeholder: "Service", required: true }
      ])
      assert.notProperty(result.packageJson, "tools")
    })
  )

  it.effect("is idempotent", () =>
    Effect.gen(function* () {
      const first = yield* plan({}, HashMap.empty())
      const second = yield* plan(first.packageJson, applied(first, HashMap.empty()))
      assert.deepStrictEqual(second.writes, [])
      assert.deepStrictEqual(second.deletes, [])
      assert.deepStrictEqual(second.packageJson, first.packageJson)
    })
  )

  it.effect("keeps the author's package.json keys, in order, without adding defaults", () =>
    Effect.gen(function* () {
      const result = yield* plan({ name: "mine", version: "2.0.0", dependencies: {}, title: "Mine" }, HashMap.empty())
      assert.deepStrictEqual(Object.keys(result.packageJson), [
        "name",
        "version",
        "dependencies",
        "title",
        "commands",
        "preferences"
      ])
    })
  )

  it.effect("never touches ejected or hand-written files and keeps their manifest entries", () =>
    Effect.gen(function* () {
      const first = yield* plan({}, HashMap.empty())
      const files = applied(first, HashMap.empty()).pipe(
        HashMap.set("src/deploy.tsx", "// mine\nexport default function Command() {}"),
        HashMap.set("src/custom.tsx", "export default function Custom() {}")
      )
      const customEntry = { name: "custom", title: "Custom", description: "Mine", mode: "view" }
      const deployEntry = { name: "deploy", title: "My Deploy", description: "Edited", mode: "view" }
      const result = yield* plan(
        {
          ...first.packageJson,
          commands: [
            ...(first.packageJson.commands ?? []).filter((command) => command.name !== "deploy"),
            deployEntry,
            customEntry
          ]
        },
        files
      )
      assert.deepStrictEqual(result.kept, ["src/deploy.tsx"])
      assert.isFalse(result.writes.some((file) => file.path === "src/deploy.tsx"))
      assert.deepStrictEqual(
        result.packageJson.commands?.find((command) => command.name === "deploy"),
        deployEntry
      )
      assert.deepStrictEqual(result.packageJson.commands?.at(-1), customEntry)
    })
  )

  it.effect("treats a hand-written entry under another extension as the user's", () =>
    Effect.gen(function* () {
      const result = yield* plan({}, HashMap.make(["src/deploy.ts", "export default function Command() {}"]))
      assert.deepStrictEqual(result.kept, ["src/deploy.tsx"])
      assert.isFalse(result.writes.some((file) => file.path === "src/deploy.tsx"))
    })
  )

  it.effect("deletes stale generated stubs", () =>
    Effect.gen(function* () {
      const files = HashMap.make(["src/old.tsx", `${Manifest.GENERATED_MARKER}\nexport default 1\n`])
      const result = yield* plan({ commands: [{ name: "old" }] }, files)
      assert.deepStrictEqual(result.deletes, ["src/old.tsx"])
      assert.notInclude(names(result.packageJson.commands), "old")
    })
  )
})

describe("eject", () => {
  const leaf = Option.getOrThrow(Spec.findLeaf(config.spec, ["acme", "db", "migrate"]))

  it("expands every visible, non-preference field into explicit JSX", () => {
    const source = eject(config, leaf)
    assert.isFalse(source.startsWith(Manifest.GENERATED_MARKER))
    assert.include(source, `app.customView("db migrate", (form) => (`)
    assert.include(source, `id="acme.profile"`)
    assert.include(source, `defaultValue="default"`)
    assert.include(source, `id="acme.db.migrate.steps"`)
    assert.include(source, `error={form.errorOf("acme.db.migrate.steps")}`)
    assert.notInclude(source, `id="acme.db.url"`)
  })

  it.effect("refuses commands that have no screen of their own", () =>
    Effect.gen(function* () {
      const browserOnly = {
        ...config,
        options: { ...config.options, commands: { ...config.options.commands, strategy: "browser" as const } }
      }
      const error = yield* Effect.flip(ensureEjectable(browserOnly, leaf))
      assert.strictEqual(error._tag, "NotEjectable")
    })
  )
})

describe("Jsx", () => {
  it("prints strings that JSX would misread as expressions", () => {
    const [line] = Jsx.print(
      Jsx.element("X", [Jsx.text("a", "plain"), Jsx.text("b", "x & y"), Jsx.text("c", "two\nlines")])
    )
    assert.strictEqual(line, `<X a="plain" b={"x & y"} c={"two\\nlines"} />`)
  })
})
