/**
 * The run pipeline shared by forms, no-view commands, history re-runs and
 * AI tools: argv → confirm → run (live feedback) → history → output.
 */
import { Argv, Config, type Field, Runner, Spec } from "@effect-cli-raycast/core"
import { Alert, Toast } from "@raycast/api"
import { Array as Arr, DateTime, Duration, Effect, Exit, Match, Option, Ref, Schedule, String as Str } from "effect"
import { History, newRunId, storable } from "./history.ts"
import { Raycast } from "./Raycast.ts"
import { Cancelled, Outcome, type ResultContext, type Session, Shortcuts, Trigger } from "./types.ts"

/** Toasts are repainted at most this often while output streams in. */
const TOAST_REFRESH = Duration.millis(150)
/** Raycast truncates toast messages anyway; keep them to one readable line. */
const TOAST_LINE_LENGTH = 200
const LINE_BREAK = "\n"

const lastLine = (text: string): Option.Option<string> =>
  Arr.last(text.trimEnd().split(LINE_BREAK)).pipe(
    Option.map((line) => line.slice(0, TOAST_LINE_LENGTH)),
    Option.filter(Str.isNonEmpty)
  )

/* -------------------------------------------------------------------------- */
/* Policies per trigger                                                       */
/* -------------------------------------------------------------------------- */

/** Screens that can show a result view: a form, or a result view being re-run in place. */
const hasScreen = (trigger: Trigger): boolean =>
  Trigger.match(trigger, { Form: () => true, Rerun: () => true, NoView: () => false, Api: () => false })

/** A re-run was confirmed when it first ran; programmatic runs have nobody to ask. */
const asksConfirmation = (trigger: Trigger): boolean =>
  Trigger.match(trigger, { Form: () => true, NoView: () => true, Rerun: () => false, Api: () => false })

/** Without a screen, the detail view falls back to the clipboard. */
const outputViewOf = (session: Session, trigger: Trigger): Config.OutputView =>
  Match.value(session.config.options.output.view).pipe(
    Match.when(
      (view) => view === "detail" && !hasScreen(trigger),
      () => "clipboard" as const
    ),
    Match.orElse((view) => view)
  )

/**
 * A HUD closes the Raycast window, so it cannot accompany a pushed detail view;
 * the toast takes over in that case.
 */
const feedbackOf = (session: Session, trigger: Trigger, view: Config.OutputView): Config.FeedbackMode =>
  Match.value(session.config.options.feedback.mode).pipe(
    Match.when(
      () => Trigger.guards.Api(trigger),
      () => "silent" as const
    ),
    Match.when(
      (mode) => mode === "hud" && view === "detail",
      () => "toast" as const
    ),
    Match.orElse((mode) => mode)
  )

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

const confirm = (session: Session, leaf: Spec.LeafSpec, commandLine: string, trigger: Trigger) =>
  Option.match(
    Option.filter(Config.confirmation(session.config, leaf.command), () => asksConfirmation(trigger)),
    {
      onNone: () => Effect.void,
      onSome: (title) =>
        Raycast.use((raycast) =>
          raycast.confirm({
            title,
            message: commandLine,
            primaryAction: { title: "Run", style: Alert.ActionStyle.Destructive }
          })
        ).pipe(
          Effect.filterOrFail(
            (confirmed) => confirmed,
            () => new Cancelled()
          )
        )
    }
  )

/** A spawn failure is reported like a shell would: as a run that never started. */
const notStarted = (error: Runner.RunnerError): Runner.RunResult => ({
  exitCode: Runner.ExitCodes.NotStarted,
  stdout: "",
  stderr: error.message,
  duration: Duration.zero
})

const run = (session: Session, argv: Argv.Argv, options: Runner.RunOptions) =>
  session.config.options.runner
    .run(Argv.toArgs(argv), options)
    .pipe(Effect.catchTag("RunnerError", (error) => Effect.succeed(notStarted(error))))

/**
 * The animated toast is a resource: if the run does not complete (interrupted
 * screen, defect), it is hidden instead of spinning forever.
 */
const progressToast = (leaf: Spec.LeafSpec, commandLine: string) =>
  Raycast.use((raycast) =>
    Effect.acquireRelease(
      raycast.toast({ style: Toast.Style.Animated, title: `Running ${leaf.command.title}…`, message: commandLine }),
      (toast, exit) =>
        Exit.match(exit, {
          onSuccess: () => Effect.void,
          onFailure: () => raycast.hideToast(toast).pipe(Effect.ignore)
        })
    )
  )

/** Runs while the toast shows the latest output line. */
const runWithToast = (session: Session, toast: Toast, argv: Argv.Argv) =>
  Effect.gen(function* () {
    const raycast = yield* Raycast
    const latest = yield* Ref.make(Option.none<string>())
    yield* Ref.getAndSet(latest, Option.none()).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.void, onSome: (message) => raycast.updateToast(toast, { message }) })
      ),
      Effect.repeat(Schedule.spaced(TOAST_REFRESH)),
      Effect.forkScoped
    )
    return yield* run(session, argv, {
      onOutput: (output) =>
        Option.match(lastLine(output.text), {
          onNone: () => Effect.void,
          onSome: (line) => Ref.set(latest, Option.some(line))
        })
    })
  }).pipe(Effect.scoped)

interface Report {
  readonly summary: string
  readonly style: Toast.Style
  readonly mark: string
  readonly line: Option.Option<string>
  /** Only successful output is copied or pasted. */
  readonly deliver: Effect.Effect<void, unknown, Raycast>
}

const deliver = (view: Config.OutputView, output: string): Effect.Effect<void, unknown, Raycast> =>
  Raycast.use((raycast) =>
    Match.value(view).pipe(
      Match.when(
        () => Str.isEmpty(output),
        () => Effect.void
      ),
      Match.when("clipboard", () => raycast.copy(output)),
      Match.when("paste", () => raycast.paste(output)),
      Match.orElse(() => Effect.void)
    )
  )

const reportOf = (leaf: Spec.LeafSpec, result: Runner.RunResult, view: Config.OutputView): Report =>
  Match.value(Runner.statusOf(result.exitCode)).pipe(
    Match.withReturnType<Report>(),
    Match.when("succeeded", () => ({
      summary: [
        `${leaf.command.title} finished in ${Duration.format(result.duration)}`,
        ...Arr.filter(["output copied"], () => view === "clipboard")
      ].join(" · "),
      style: Toast.Style.Success,
      mark: "✓",
      line: lastLine(result.stdout),
      deliver: deliver(view, result.stdout.trimEnd())
    })),
    Match.when("failed", () => ({
      summary: `${leaf.command.title} failed (exit ${result.exitCode})`,
      style: Toast.Style.Failure,
      mark: "✗",
      line: Option.orElse(lastLine(result.stderr), () => lastLine(result.stdout)),
      deliver: Effect.void
    })),
    Match.exhaustive
  )

const announce = (
  session: Session,
  feedback: Config.FeedbackMode,
  toast: Option.Option<Toast>,
  report: Report,
  result: Runner.RunResult
) =>
  Raycast.use((raycast) =>
    Option.match(toast, {
      onSome: (shown) =>
        raycast.updateToast(shown, {
          style: report.style,
          title: report.summary,
          message: Option.getOrUndefined(report.line),
          primaryAction: {
            title: "Copy Output",
            shortcut: Shortcuts.copyOutput,
            onAction: () => void session.runtime.runFork(raycast.copy(`${result.stdout}${result.stderr}`))
          }
        }),
      onNone: () =>
        Match.value(feedback).pipe(
          Match.when("hud", () => raycast.hud(`${report.mark} ${report.summary}`)),
          Match.orElse(() => Effect.void)
        )
    })
  )

const remember = Effect.fnUntraced(function* (session: Session, context: ResultContext) {
  const history = yield* History
  const { options } = session.config
  const path = Spec.pathKey(context.leaf.command.path)
  const values = storable(context.leaf, context.values)
  if (options.form.persistence === "localStorage") yield* history.saveLastValues(path, values)
  if (options.history.enabled) {
    yield* history.push(
      {
        id: yield* newRunId,
        path,
        commandLine: context.commandLine,
        values,
        exitCode: context.result.exitCode,
        duration: context.result.duration,
        at: yield* DateTime.now
      },
      options.history.max
    )
  }
})

/** Side effects the user did not ask to see must not break or delay the run's own feedback. */
const quietly =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) => Effect.logWarning(label, cause)),
      Effect.asVoid
    )

/* -------------------------------------------------------------------------- */
/* Pipeline                                                                   */
/* -------------------------------------------------------------------------- */

export const execute = Effect.fn("execute")(function* (
  session: Session,
  leaf: Spec.LeafSpec,
  values: Field.FieldValues,
  trigger: Trigger
) {
  const argv = Argv.build(leaf, values)
  const commandLine = Argv.commandLine(leaf, argv)
  yield* confirm(session, leaf, commandLine, trigger)

  const view = outputViewOf(session, trigger)
  const feedback = feedbackOf(session, trigger, view)
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const toast = yield* Match.value(feedback).pipe(
        Match.when("toast", () => Effect.map(progressToast(leaf, commandLine), Option.some)),
        Match.orElse(() => Effect.succeed(Option.none<Toast>()))
      )
      const completed = yield* Option.match(toast, {
        onSome: (shown) => runWithToast(session, shown, argv),
        onNone: () => run(session, argv, {})
      })
      const report = reportOf(leaf, completed, view)
      yield* report.deliver.pipe(quietly("Output.undeliverable"))
      yield* announce(session, feedback, toast, report, completed)
      return completed
    })
  )

  const context: ResultContext = { leaf, values, argv, commandLine, result }
  yield* remember(session, context).pipe(quietly("History.unwritable"))
  yield* Option.match(Option.fromUndefinedOr(session.ui.onResult), {
    onNone: () => Effect.void,
    onSome: (onResult) => onResult(context).pipe(quietly("UiOptions.onResult"))
  })
  return Match.value(view).pipe(
    Match.when("detail", () => Outcome.cases.ShowDetail.make({ context })),
    Match.orElse(() => Outcome.cases.Delivered.make({ context }))
  )
})
