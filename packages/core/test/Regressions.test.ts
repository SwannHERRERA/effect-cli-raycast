import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Option, Result, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { Config, defineConfig, Field, Manifest, Runner, Source, Spec } from "#src/index"
import { acme } from "./fixture.ts"
import { leaf } from "./helpers.ts"

const resolve = (input: Partial<Config.OptionsInput>) =>
  defineConfig(acme, { version: "1.0.0", runner: Runner.inProcess(acme, { version: "1.0.0" }), ...input }).resolve

describe("Config", () => {
  it.effect("excluding every child of a group does not make the group runnable", () =>
    Effect.gen(function* () {
      const config = yield* resolve({ commands: { exclude: ["db migrate"] } })
      const paths = Spec.leaves(config.spec).map((found) => Spec.pathKey(found.command.path))
      assert.deepStrictEqual(paths, ["deploy", "logs", "fail"])
      assert.isTrue(Option.isNone(Spec.findLeaf(config.spec, ["acme", "db"])))
    })
  )

  it.effect("rejects Raycast command names that collide", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(resolve({ commands: { browserName: "deploy" } }))
      assert.isTrue(Exit.isFailure(exit))
    })
  )

  it.effect("rejects multi-valued flags as preferences", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolve({ preferences: ["label"] }))
      assert.include(error.message, "--label takes several values")
    })
  )
})

describe("Introspect", () => {
  it.effect("drops defaults whose value was mapped away from the typed token", () =>
    Effect.gen(function* () {
      const cli = Command.make("x", {
        lvl: Flag.Literals("lvl", ["low", "high"]).pipe(
          Flag.map((level) => level.length),
          Flag.withDefault(3)
        ),
        plain: Flag.Int("plain").pipe(Flag.withDefault(3))
      })
      const config = yield* defineConfig(cli, { version: "1", runner: Runner.inProcess(cli, { version: "1" }) }).resolve
      const fields = Option.getOrThrow(Spec.findLeaf(config.spec, ["x"])).fields
      assert.deepStrictEqual(fields.map(Spec.defaultTokens), [Option.none(), Option.some(["3"])])
    })
  )
})

describe("Field", () => {
  it("round-trips several tokens through the loose codec", () => {
    const encoded = Schema.encodeSync(Field.LooseTokens)(["a", "b"])
    assert.deepStrictEqual(Schema.decodeUnknownSync(Field.LooseTokens)(encoded), ["a", "b"])
  })

  it("validates dates and restores unreadable ones as empty", () => {
    const since = Option.getOrThrow(Arr.findFirst(leaf("logs").fields, (field) => field.name === "since"))
    assert.deepStrictEqual(Field.validate(since, ["nope"]), Result.fail("Must be a date"))
    assert.isNull(Field.toWidget("date", ["nope"]))
  })
})

describe("Source", () => {
  it("rewrites relative specifiers for a subdirectory", () => {
    assert.strictEqual(Source.fromSubdirectory("./app"), "../app")
    assert.strictEqual(Source.fromSubdirectory("../lib/app"), "../../lib/app")
    assert.strictEqual(Source.fromSubdirectory("my-app"), "my-app")
  })

  it("quotes property keys that are not identifiers", () => {
    assert.strictEqual(Source.propertyKey("dryRun"), "dryRun")
    assert.strictEqual(Source.propertyKey("2fa"), `"2fa"`)
  })
})

describe("Manifest", () => {
  it.effect("keeps the leaf command names stable", () =>
    Effect.gen(function* () {
      const config = yield* resolve({})
      assert.deepStrictEqual(
        Manifest.manifest(config).commands.map((command) => command.name),
        ["browse", "deploy", "logs", "fail", "db-migrate"]
      )
    })
  )
})
