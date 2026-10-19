import { defineConfig, Runner } from "@effect-cli-raycast/core"
import { acme } from "@effect-cli-raycast/core/testing"
import type { Toast } from "@raycast/api"
import { Effect, Layer, ManagedRuntime, Option, Ref } from "effect"
import { KeyValueStore } from "effect/persistence"
import * as History from "#src/history"
import { Raycast } from "#src/Raycast"
import type { Session } from "#src/types"

/** Everything the code under test asked Raycast to do, in order. */
export type Call =
  | { readonly _tag: "confirm"; readonly title: string }
  | { readonly _tag: "toast"; readonly title: string }
  | { readonly _tag: "update"; readonly title: string }
  | { readonly _tag: "hide" }
  | { readonly _tag: "copy"; readonly text: string }
  | { readonly _tag: "paste"; readonly text: string }
  | { readonly _tag: "hud"; readonly text: string }

export const recordingRaycast = (calls: Ref.Ref<ReadonlyArray<Call>>, options: { readonly confirms: boolean }) => {
  const record = (call: Call) => Ref.update(calls, (all) => [...all, call])
  const toast = { hide: () => Promise.resolve() } as unknown as Toast
  return Layer.succeed(Raycast, {
    confirm: (alert) => record({ _tag: "confirm", title: alert.title }).pipe(Effect.as(options.confirms)),
    toast: (shown) => record({ _tag: "toast", title: shown.title }).pipe(Effect.as(toast)),
    updateToast: (_, update) =>
      Option.match(Option.fromUndefinedOr(update.title), {
        onNone: () => Effect.void,
        onSome: (title) => record({ _tag: "update", title })
      }),
    hideToast: () => record({ _tag: "hide" }),
    copy: (text) => record({ _tag: "copy", text }),
    paste: (text) => record({ _tag: "paste", text }),
    hud: (text) => record({ _tag: "hud", text }),
    preference: () => Effect.succeed(Option.none())
  })
}

export const makeSession = (
  input: Partial<Parameters<typeof defineConfig>[1]>,
  options: { readonly confirms: boolean } = { confirms: true }
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([])
    const config = yield* defineConfig(acme, {
      version: "1.0.0",
      runner: Runner.inProcess(acme, { version: "1.0.0" }),
      ...input
    }).resolve
    // One built context, shared by the runtime and the test, so both see the same history store.
    const services = yield* Layer.build(
      Layer.mergeAll(History.layer.pipe(Layer.provide(KeyValueStore.layerMemory)), recordingRaycast(calls, options))
    )
    const session: Session = { config, ui: {}, runtime: ManagedRuntime.make(Layer.succeedContext(services)) }
    return { session, calls, services }
  })
