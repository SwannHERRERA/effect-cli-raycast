import { assert, describe, it } from "@effect/vitest"
import { Runner, Spec } from "@effect-cli-raycast/core"
import { DateTime, Duration, Effect, Layer, Option } from "effect"
import { KeyValueStore } from "effect/persistence"
import * as History from "#src/history"

const entry = (id: string): History.HistoryEntry => ({
  id: History.RunId.make(id),
  path: Spec.PathKey.make("deploy"),
  commandLine: "acme deploy --env=prod api",
  values: { [Spec.ParamId.make("acme.deploy.env")]: ["prod"] },
  exitCode: Runner.ExitCodes.Success,
  duration: Duration.millis(1234),
  at: DateTime.makeUnsafe(Date.UTC(2026, 0, 2))
})

const testLayer = History.layer.pipe(Layer.provideMerge(KeyValueStore.layerMemory))

describe("History", () => {
  it.effect("round-trips entries, newest first, capped at max", () =>
    Effect.gen(function* () {
      const history = yield* History.History
      yield* history.push(entry("1"), 2)
      yield* history.push(entry("2"), 2)
      yield* history.push(entry("3"), 2)
      const loaded = yield* history.load
      assert.deepStrictEqual(
        loaded.map((run) => run.id),
        ["3", "2"]
      )
      assert.deepStrictEqual(loaded[0], entry("3"))
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("keeps every entry when runs finish at the same time", () =>
    Effect.gen(function* () {
      const history = yield* History.History
      yield* Effect.forEach(["a", "b", "c", "d"], (id) => history.push(entry(id), 10), { concurrency: "unbounded" })
      assert.strictEqual((yield* history.load).length, 4)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("treats unreadable history as empty", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore
      const history = yield* History.History
      yield* store.set(`${History.PREFIX}${History.HISTORY_KEY}`, "{not json")
      assert.deepStrictEqual(yield* history.load, [])
      assert.deepStrictEqual(yield* history.loadLastValues(Spec.PathKey.make("deploy")), Option.none())
    }).pipe(Effect.provide(testLayer))
  )
})
