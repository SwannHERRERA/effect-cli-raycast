/**
 * The bridge from effects to React. Screens describe what to load or do as an
 * `Effect`; fibers are interrupted when the screen unmounts, and every
 * failure ends up visible instead of leaving a spinner behind.
 */
import { Toast } from "@raycast/api"
import { Array as Arr, Boolean as Bool, Cause, Data, Effect, Exit, Fiber, Option } from "effect"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Raycast } from "./Raycast.ts"
import type { Services, Session } from "./types.ts"

export type AsyncState<A, E> = Data.TaggedEnum<{
  Loading: {}
  Ready: { readonly value: A }
  Failed: { readonly cause: Cause.Cause<E> }
}>

interface AsyncStateDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: AsyncState<this["A"], this["B"]>
}

export const AsyncState = Data.taggedEnum<AsyncStateDefinition>()

/**
 * Loads `make()` whenever `key` changes or `refresh` runs. A refresh keeps the
 * previous value on screen until the new one arrives, so lists do not flicker.
 * The latest `make` is always used, so it may close over current props.
 */
export const useEffectState = <A, E>(
  session: Session,
  key: string,
  make: () => Effect.Effect<A, E, Services>
): readonly [AsyncState<A, E>, Effect.Effect<void>] => {
  const [state, setState] = useState<AsyncState<A, E>>(AsyncState.Loading())
  const [generation, setGeneration] = useState(0)
  const latest = useRef(make)
  // Refs may only change after render; the load effect below runs after this one.
  useLayoutEffect(() => {
    latest.current = make
  })
  useEffect(() => {
    const fiber = session.runtime.runFork(
      latest.current().pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() =>
            Exit.match(exit, {
              onSuccess: (value) => setState(AsyncState.Ready({ value })),
              // An interrupted load belongs to a screen that is gone or about to reload.
              onFailure: (cause) =>
                Bool.match(Cause.hasInterruptsOnly(cause), {
                  onTrue: () => undefined,
                  onFalse: () => setState(AsyncState.Failed({ cause }))
                })
            })
          )
        )
      )
    )
    return () => void session.runtime.runFork(Fiber.interrupt(fiber))
    // `key` and `generation` are the reload triggers; the effect reads the latest `make` through the ref.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [session, key, generation])
  return [state, Effect.sync(() => setGeneration((n) => n + 1))] as const
}

const MESSAGE_LENGTH = 200
const LINE_BREAK = "\n"

/** The first line of a failure, short enough for a toast. */
export const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const pretty = Cause.pretty(cause)
  return Arr.head(pretty.split(LINE_BREAK))
    .pipe(Option.getOrElse(() => pretty))
    .slice(0, MESSAGE_LENGTH)
}

/** Fire-and-forget from an action handler: failures become a toast, not a silent no-op. */
export const runAction = (session: Session, effect: Effect.Effect<unknown, unknown, Services>): void =>
  void session.runtime.runFork(
    effect.pipe(
      Effect.catchCause((cause) =>
        Bool.match(Cause.hasInterruptsOnly(cause), {
          onTrue: () => Effect.void,
          onFalse: () =>
            Raycast.use((raycast) =>
              raycast.toast({ style: Toast.Style.Failure, title: "Action failed", message: causeMessage(cause) })
            ).pipe(Effect.ignore)
        })
      )
    )
  )
