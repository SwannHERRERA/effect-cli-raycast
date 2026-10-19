import { assert, describe, it } from "@effect/vitest"
import { Field, Spec } from "@effect-cli-raycast/core"
import { Effect, Option, Ref } from "effect"
import { execute } from "#src/execute"
import { History } from "#src/history"
import * as Inputs from "#src/inputs"
import { type Trigger, Triggers } from "#src/types"
import { makeSession } from "./fakes.ts"

const leafOf = (spec: Spec.CliSpec, path: string) => Option.getOrThrow(Spec.findLeaf(spec, Spec.pathOf(spec, path)))

describe("execute", () => {
  it.effect("asks for confirmation and stops when declined", () =>
    Effect.gen(function* () {
      const { session, calls, services } = yield* makeSession({}, { confirms: false })
      const leaf = leafOf(session.config.spec, "deploy")
      const error = yield* Inputs.fromForm(session, leaf, {
        "acme.deploy.env": "dev",
        "acme.deploy.@services": "api"
      }).pipe(
        Effect.flatMap((values) => execute(session, leaf, values, Triggers.Form)),
        Effect.flip,
        Effect.provide(services)
      )
      assert.strictEqual(error._tag, "Cancelled")
      assert.deepStrictEqual(
        (yield* Ref.get(calls)).map((call) => call._tag),
        ["confirm"]
      )
    })
  )

  it.effect("shows a detail view from a form, copies output for a no-view command, records history", () =>
    Effect.gen(function* () {
      const { session, calls, services } = yield* makeSession({})
      const leaf = leafOf(session.config.spec, "logs")
      const run = (trigger: Trigger) =>
        Inputs.fromForm(session, leaf, { "acme.logs.@service": "api" }).pipe(
          Effect.flatMap((values) => execute(session, leaf, values, trigger)),
          Effect.provide(services)
        )
      assert.strictEqual((yield* run(Triggers.Form))._tag, "ShowDetail")
      assert.strictEqual((yield* run(Triggers.NoView))._tag, "Delivered")
      const recorded = yield* Ref.get(calls)
      assert.isTrue(recorded.some((call) => call._tag === "copy" && call.text.includes("ran logs")))
      const history = yield* History.use((store) => store.load).pipe(Effect.provide(services))
      assert.strictEqual(history.length, 2)
    })
  )

  it.effect("re-running a result keeps the detail view and does not ask again", () =>
    Effect.gen(function* () {
      const { session, calls, services } = yield* makeSession({})
      const leaf = leafOf(session.config.spec, "deploy")
      const outcome = yield* Inputs.fromForm(session, leaf, {
        "acme.deploy.env": "dev",
        "acme.deploy.@services": "api"
      }).pipe(
        Effect.flatMap((values) => execute(session, leaf, values, Triggers.Rerun)),
        Effect.provide(services)
      )
      assert.strictEqual(outcome._tag, "ShowDetail")
      assert.isFalse((yield* Ref.get(calls)).some((call) => call._tag === "copy" || call._tag === "confirm"))
    })
  )
})

describe("inputs", () => {
  it.effect("launch arguments covering every required field run straight away", () =>
    Effect.gen(function* () {
      const { session } = yield* makeSession({})
      const logs = leafOf(session.config.spec, "logs")
      const explicit = Inputs.fromLaunchArguments(session, logs, { service: "api" })
      const expected: Field.FieldValues = { [Spec.ParamId.make("acme.logs.@service")]: ["api"] }
      assert.deepStrictEqual(explicit, expected)
      assert.strictEqual(Inputs.launchOf(logs, explicit), "run")
      assert.strictEqual(Inputs.launchOf(logs, {}), "edit")
    })
  )

  it.effect("rejects form values field by field", () =>
    Effect.gen(function* () {
      const { session, services } = yield* makeSession({})
      const deploy = leafOf(session.config.spec, "deploy")
      const error = yield* Inputs.fromForm(session, deploy, { "acme.deploy.env": "qa" }).pipe(
        Effect.flip,
        Effect.provide(services)
      )
      assert.deepStrictEqual(Object.keys(error.errors).toSorted(), ["acme.deploy.@services", "acme.deploy.env"])
    })
  )
})
