import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Array as Arr, Option, Schema } from "effect"
import { Spec } from "#src/index"
import { leaf, spec } from "./helpers.ts"

const param = (path: string, name: string): Spec.ParamSpec =>
  Option.getOrThrow(Arr.findFirst(leaf(path).fields, (field) => field.name === name))

describe("Introspect", () => {
  it("reflects the command tree", () => {
    const [deploy, logs, , secret, db] = spec.root.children
    assert.strictEqual(spec.root.name, "acme")
    assert.deepStrictEqual(spec.root.description, Option.some("Acme platform CLI"))
    assert.deepStrictEqual(
      spec.root.children.map((child) => child.name),
      ["deploy", "logs", "fail", "secret", "db"]
    )
    assert.deepStrictEqual(db?.group, Option.some("Data"))
    assert.strictEqual(secret?.unlisted, true)
    assert.deepStrictEqual(deploy?.meta, { icon: "rocket.png", confirm: true })
    assert.deepStrictEqual(logs?.shortDescription, Option.some("Tail logs"))
  })

  it("reflects param types, choices, and path types", () => {
    const env = param("deploy", "env")
    assert.strictEqual(env.type._tag, "Choice")
    assert.deepStrictEqual(Spec.choicesOf(env), ["dev", "staging", "prod"])
    assert.deepStrictEqual(env.description, Option.some("Target environment"))
    assert.isTrue(Spec.isRequired(env))
    assert.strictEqual(param("deploy", "force").type._tag, "Boolean")
    assert.deepStrictEqual(param("deploy", "force").aliases, ["f"])
    assert.strictEqual(param("deploy", "token").type._tag, "Secret")
    assert.strictEqual(param("deploy", "label").type._tag, "KeyValue")
    assert.deepStrictEqual(param("deploy", "dir").type, Spec.ParamType.cases.Path.make({ pathType: "directory" }))
    assert.strictEqual(param("logs", "since").type._tag, "Date")
  })

  it("recovers defaults and requiredness by probing an empty parse", () => {
    assert.deepStrictEqual(Spec.defaultTokens(param("deploy", "replicas")), Option.some(["3"]))
    assert.isFalse(Spec.isRequired(param("deploy", "replicas")))
    // A bare `Flag.Boolean` is required by the parser (no implicit `false`).
    assert.isTrue(Spec.isRequired(param("deploy", "force")))
    assert.deepStrictEqual(Spec.defaultTokens(param("logs", "follow")), Option.some(["true"]))
    assert.deepStrictEqual(
      param("deploy", "tag").presence,
      Spec.Presence.cases.Optional.make({ default: Option.none() })
    )
    // Secrets never leak into the spec, even as defaults.
    assert.deepStrictEqual(Spec.defaultTokens(param("deploy", "token")), Option.none())
    const services = param("deploy", "services")
    assert.strictEqual(services.kind, "argument")
    assert.deepStrictEqual(services.multiplicity, Spec.Multiplicity.cases.Variadic.make({ min: 1, max: Option.none() }))
    assert.isTrue(Spec.isRequired(services))
  })

  it("puts ancestors' shared flags first in a leaf's fields", () => {
    const migrate = leaf("db migrate")
    assert.deepStrictEqual(
      migrate.fields.map((field) => field.id),
      ["acme.profile", "acme.db.url", "acme.db.migrate.steps"]
    )
    assert.deepStrictEqual(
      migrate.lineage.map((command) => command.name),
      ["acme", "db", "migrate"]
    )
  })

  it("skips hidden params and unlisted commands", () => {
    assert.deepStrictEqual(
      leaf("secret").fields.map((field) => field.name),
      ["profile"]
    )
    assert.deepStrictEqual(
      Spec.leaves(spec).map((found) => found.command.path.join(" ")),
      ["acme deploy", "acme logs", "acme fail", "acme db migrate"]
    )
  })

  it("encodes the spec to JSON and back", () => {
    const json = Schema.fromJsonString(Spec.CliSpec)
    assert.deepStrictEqual(Schema.decodeSync(json)(Schema.encodeSync(json)(spec)), spec)
  })
})
