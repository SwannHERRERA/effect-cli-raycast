/**
 * Submitting a form, shared by generated forms, ejected forms (`customView`)
 * and history re-runs: decode → execute → present the outcome, with one run
 * at a time per screen.
 */
import type { Field, Spec } from "@effect-cli-raycast/core"
import { Toast, useNavigation } from "@raycast/api"
import { Data, Effect, Exit, Option, Record, Semaphore } from "effect"
import { useState } from "react"
import { execute } from "./execute.ts"
import { Raycast, type RaycastError } from "./Raycast.ts"
import { ResultView } from "./ResultView.tsx"
import { type InvalidInput, Outcome, type ResultContext, type Services, type Session, Triggers } from "./types.ts"

/** Errors only exist between runs: starting a run clears them. */
export type RunState = Data.TaggedEnum<{
  Idle: { readonly errors: Field.FieldErrors }
  Running: {}
}>
export const RunState = Data.taggedEnum<RunState>()

const noErrors = RunState.Idle({ errors: {} })

export interface Runner {
  readonly state: RunState
  /** Resolves `false` when the values were rejected, the run was cancelled, or one is already running. */
  readonly submit: (
    leaf: Spec.LeafSpec,
    decode: Effect.Effect<Field.FieldValues, InvalidInput, Services>
  ) => Effect.Effect<boolean, never, Services>
  /** Replace every field message (e.g. after "Copy Command Line" rejected the values). */
  readonly showErrors: (errors: Field.FieldErrors) => void
  /** Field-level validation between runs (e.g. on blur); ignored while a run is in flight. */
  readonly setFieldError: (id: Spec.ParamId, error: Option.Option<string>) => void
}

/** Re-running from the result view replaces its content instead of stacking another screen. */
export const rerunOf = (
  session: Session,
  leaf: Spec.LeafSpec,
  context: ResultContext
): Effect.Effect<ResultContext, RaycastError, Services> =>
  execute(session, leaf, context.values, Triggers.Rerun).pipe(
    Effect.map((outcome): ResultContext => outcome.context),
    // A re-run never asks for confirmation, so it cannot be cancelled.
    Effect.catchTag("Cancelled", () => Effect.succeed(context))
  )

/** Tells the user why nothing ran and hands back the messages to show next to each field. */
const rejected = (invalid: InvalidInput) =>
  Raycast.use((raycast) =>
    raycast.toast({ style: Toast.Style.Failure, title: "Check the highlighted fields", message: invalid.message })
  ).pipe(Effect.ignore, Effect.as(invalid.errors))

export const useRunner = (session: Session): Runner => {
  const { push } = useNavigation()
  const [state, setState] = useState<RunState>(noErrors)
  // One permit per screen: a second ⌘↵ while running is ignored, not run twice.
  const [permit] = useState(() => Semaphore.makeUnsafe(1))

  const present = (leaf: Spec.LeafSpec) => (outcome: Outcome) =>
    Outcome.match(outcome, {
      ShowDetail: ({ context }) =>
        Effect.sync(() =>
          push(
            <ResultView
              session={session}
              context={context}
              rerun={Option.some((current: ResultContext) => rerunOf(session, leaf, current))}
            />
          )
        ),
      Delivered: () => Effect.void
    })

  const attempt = (leaf: Spec.LeafSpec, decode: Effect.Effect<Field.FieldValues, InvalidInput, Services>) =>
    decode.pipe(
      Effect.flatMap((values) => execute(session, leaf, values, Triggers.Form)),
      Effect.flatMap(present(leaf)),
      Effect.as(Option.none<Field.FieldErrors>()),
      Effect.catchTags({
        InvalidInput: (invalid) => Effect.map(rejected(invalid), Option.some),
        Cancelled: () => Effect.succeed(Option.none<Field.FieldErrors>()),
        // Raycast itself refused (e.g. the alert could not be shown): nothing ran, nothing to highlight.
        RaycastError: (error) =>
          Effect.logError("Run.raycastFailed", error).pipe(Effect.as(Option.none<Field.FieldErrors>()))
      })
    )

  return {
    state,
    showErrors: (errors) => setState(RunState.Idle({ errors })),
    setFieldError: (id, error) =>
      setState((current) =>
        RunState.$match(current, {
          Running: () => current,
          Idle: ({ errors }) =>
            RunState.Idle({
              errors: Option.match(error, {
                onNone: () => Record.remove(errors, id),
                onSome: (message) => Record.set(errors, id, message)
              })
            })
        })
      ),
    submit: (leaf, decode) =>
      Effect.acquireUseRelease(
        Effect.sync(() => setState(RunState.Running())),
        () => attempt(leaf, decode),
        (_, exit) =>
          Effect.sync(() =>
            setState(
              Exit.match(exit, {
                onSuccess: (errors) => RunState.Idle({ errors: Option.getOrElse(errors, () => ({})) }),
                onFailure: () => noErrors
              })
            )
          )
      ).pipe(
        permit.withPermitsIfAvailable(1),
        Effect.map((ran) => Option.exists(ran, Option.isNone))
      )
  }
}

/** The message for a field rejected by the last submission. */
export const errorOf = (state: RunState, id: Spec.ParamId): Option.Option<string> =>
  RunState.$match(state, {
    Idle: ({ errors }) => Record.get(errors, id),
    Running: () => Option.none()
  })
