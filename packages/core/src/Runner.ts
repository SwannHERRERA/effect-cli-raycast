/**
 * Two first-class ways to execute a built argv:
 *
 * - `inProcess` imports the Effect command and calls `Command.runWith` with a
 *   headless environment that captures Console / Stdio output.
 * - `exec` spawns an installed binary (absolute path recommended: Raycast does
 *   not inherit your shell PATH).
 *
 * Both return the same `RunResult`, so the UI never cares which one is used.
 */
import {
  Cause,
  Config,
  Console,
  Duration,
  Effect,
  Exit,
  Fiber,
  Formatter,
  Layer,
  Match,
  Option,
  Predicate,
  Queue,
  Schema,
  Sink,
  Stdio,
  Stream,
  Terminal
} from "effect"
import { CliError, CliOutput, Command } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { terminal } from "./Headless.ts"

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

export const ExitCode = Schema.Int.pipe(Schema.brand("ExitCode"))
export type ExitCode = typeof ExitCode.Type

/** Shell conventions, so exec and in-process runs report the same codes. */
export const ExitCodes = {
  Success: ExitCode.make(0),
  Failure: ExitCode.make(1),
  TimedOut: ExitCode.make(124),
  NotStarted: ExitCode.make(127),
  Interrupted: ExitCode.make(130)
} as const

export const isSuccess = (exitCode: ExitCode): boolean => exitCode === ExitCodes.Success

export const Status = Schema.Literals(["succeeded", "failed"])
export type Status = typeof Status.Type

export const Output = Schema.TaggedUnion({
  Stdout: { text: Schema.String },
  Stderr: { text: Schema.String }
})
export type Output = typeof Output.Type

export const RunResult = Schema.Struct({
  exitCode: ExitCode,
  stdout: Schema.String,
  stderr: Schema.String,
  duration: Schema.Duration
})
export interface RunResult extends Schema.Schema.Type<typeof RunResult> {}

export const statusOf = (exitCode: ExitCode): Status =>
  Match.value(exitCode).pipe(
    Match.withReturnType<Status>(),
    Match.when(isSuccess, () => "succeeded"),
    Match.orElse(() => "failed")
  )

export class RunnerError extends Schema.TaggedError<RunnerError>()("RunnerError", {
  reason: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return this.reason
  }
}

export interface RunOptions {
  /** Called for every chunk as it is produced (live toasts / detail views). */
  readonly onOutput?: (output: Output) => Effect.Effect<void>
}

const TypeId = "~effect-cli-raycast/Runner"

export interface Runner {
  readonly [TypeId]: typeof TypeId
  readonly _tag: "InProcess" | "Exec"
  readonly run: (argv: ReadonlyArray<string>, options?: RunOptions) => Effect.Effect<RunResult, RunnerError>
}

export const isRunner = (u: unknown): u is Runner => Predicate.hasProperty(u, TypeId)

/* -------------------------------------------------------------------------- */
/* Output capture                                                             */
/* -------------------------------------------------------------------------- */

// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
export const stripAnsi = (text: string): string => text.replace(ANSI, "")

const stdout = (text: string): Output => Output.cases.Stdout.make({ text })
const stderr = (text: string): Output => Output.cases.Stderr.make({ text })

const clean = (output: Output): Output =>
  Output.match(output, {
    Stdout: ({ text }) => stdout(stripAnsi(text)),
    Stderr: ({ text }) => stderr(stripAnsi(text))
  })

interface Streams {
  readonly stdout: string
  readonly stderr: string
}

const append = (streams: Streams, output: Output): Streams =>
  Output.match(output, {
    Stdout: ({ text }) => ({ ...streams, stdout: streams.stdout + text }),
    Stderr: ({ text }) => ({ ...streams, stderr: streams.stderr + text })
  })

const noOutput = (): Streams => ({ stdout: "", stderr: "" })

/**
 * Runs `body` with an output queue. Producers may be synchronous (the captured
 * `Console`), so they enqueue; a single consumer fiber keeps chunk order,
 * strips ANSI codes and forwards live chunks.
 */
const capture = <E>(
  options: RunOptions | undefined,
  body: (output: Queue.Enqueue<Output, Cause.Done>) => Effect.Effect<ExitCode, E>
): Effect.Effect<RunResult, E> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Output, Cause.Done>()
    const consumer = yield* Stream.fromQueue(queue).pipe(
      Stream.map(clean),
      Stream.tap((output) => options?.onOutput?.(output) ?? Effect.void),
      Stream.runFold(noOutput, append),
      Effect.forkChild
    )
    const [duration, exitCode] = yield* Effect.timed(body(queue)).pipe(Effect.ensuring(Queue.end(queue)))
    const streams = yield* Fiber.join(consumer)
    return { exitCode, ...streams, duration }
  })

/* -------------------------------------------------------------------------- */
/* In-process                                                                 */
/* -------------------------------------------------------------------------- */

/** Node services the command needs besides the captured Stdio / Terminal. */
export const nodeLayer = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
)

type Extra<R> = Exclude<R, Command.Environment>

export type InProcessOptions<R> = {
  readonly version: string
  /** Replaces the Node FileSystem / Path / ChildProcessSpawner layer (e.g. for tests). */
  readonly platformLayer?: Layer.Layer<Exclude<Command.Environment, Stdio.Stdio | Terminal.Terminal>>
} & ([Extra<R>] extends [never]
  ? { readonly layer?: Layer.Layer<never> }
  : { readonly layer: Layer.Layer<Extra<R>, unknown> })

/** Same rendering as Node's console, without colours. */
const renderArg = (arg: unknown): string =>
  Match.value(arg).pipe(
    Match.when(Predicate.isString, (text) => text),
    Match.orElse((value) => Formatter.format(value))
  )

const LINE_END = "\n"

const render = (args: ReadonlyArray<unknown>): string => args.map(renderArg).join(" ") + LINE_END

/** Console methods with no output (timers, counters, grouping) do nothing headless. */
const ignore = () => {}

const capturingConsole = (output: Queue.Enqueue<Output, Cause.Done>): Console.Console => {
  const line =
    (to: (text: string) => Output) =>
    (...args: ReadonlyArray<unknown>): void => {
      Queue.offerUnsafe(output, to(render(args)))
    }
  return {
    assert: (condition, ...args) => {
      if (!condition) line(stderr)(...args)
    },
    clear: ignore,
    count: ignore,
    countReset: ignore,
    debug: line(stdout),
    dir: (item) => line(stdout)(item),
    dirxml: line(stdout),
    error: line(stderr),
    group: line(stdout),
    groupCollapsed: line(stdout),
    groupEnd: ignore,
    info: line(stdout),
    log: line(stdout),
    table: (data) => line(stdout)(data),
    time: ignore,
    timeEnd: ignore,
    timeLog: ignore,
    trace: line(stderr),
    warn: line(stderr)
  }
}

const capturingStdio = (argv: ReadonlyArray<string>, output: Queue.Enqueue<Output, Cause.Done>) => {
  const decoder = new TextDecoder()
  const text = (chunk: string | Uint8Array): string =>
    Match.value(chunk).pipe(
      Match.when(Predicate.isString, (value) => value),
      Match.orElse((bytes) => decoder.decode(bytes))
    )
  const sink = (to: (text: string) => Output) => () =>
    Sink.forEach((chunk: string | Uint8Array) => Queue.offer(output, to(text(chunk))))
  return Stdio.make({ args: Effect.succeed(argv), stdout: sink(stdout), stderr: sink(stderr), stdin: Stream.empty })
}

/** Errors `runWith` already rendered through the formatter. */
const isRendered = (error: unknown): boolean =>
  CliError.isCliError(error) && (error._tag === "ShowHelp" || error._tag === "UserError")

const isOnlyRendered = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.every((reason) => Cause.isFailReason(reason) && isRendered(reason.error))

const exitCodeOf = (output: Queue.Enqueue<Output, Cause.Done>) => (exit: Exit.Exit<unknown, unknown>) =>
  Exit.match(exit, {
    onSuccess: () => Effect.succeed(ExitCodes.Success),
    onFailure: (cause) =>
      Match.value(cause).pipe(
        Match.when(Cause.hasInterruptsOnly, () => Effect.succeed(ExitCodes.Interrupted)),
        Match.when(isOnlyRendered, () => Effect.succeed(ExitCodes.Failure)),
        Match.orElse(() =>
          Queue.offer(output, stderr(Cause.pretty(cause) + LINE_END)).pipe(Effect.as(ExitCodes.Failure))
        )
      )
  })

export const inProcess = <Name extends string, Input, CI, E, R>(
  command: Command.Command<Name, Input, CI, E, R>,
  options: InProcessOptions<R>
): Runner => {
  const layer = options.layer ?? Layer.empty
  const platform = options.platformLayer ?? nodeLayer
  const program = (argv: ReadonlyArray<string>, output: Queue.Enqueue<Output, Cause.Done>) =>
    // TypeScript cannot reduce `Exclude<…>` over the generic `R`; `InProcessOptions<R>`
    // requires a layer for every service beyond `Command.Environment`, so nothing is left.
    Command.runWith(command, { version: options.version, renderErrors: true })(argv).pipe(
      Effect.provideService(Console.Console, capturingConsole(output)),
      Effect.provideService(Stdio.Stdio, capturingStdio(argv, output)),
      Effect.provideService(Terminal.Terminal, terminal),
      Effect.provide(CliOutput.layer(CliOutput.defaultFormatter({ colors: false }))),
      Effect.provide(layer),
      Effect.provide(platform)
    ) as Effect.Effect<void, unknown>
  return {
    [TypeId]: TypeId,
    _tag: "InProcess",
    run: Effect.fn("Runner.inProcess.run")((argv, runOptions) =>
      capture(runOptions, (output) => program(argv, output).pipe(Effect.exit, Effect.flatMap(exitCodeOf(output))))
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Exec                                                                       */
/* -------------------------------------------------------------------------- */

export interface ExecOptions {
  /** Absolute path (recommended) or a name resolved against `PATH`. */
  readonly bin: string
  /** Tokens inserted before the generated argv (e.g. `["run", "cli.ts"]`). */
  readonly prefixArgs?: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  /** Extra directories prepended to PATH. Defaults to Homebrew + /usr/local. */
  readonly pathDirs?: ReadonlyArray<string>
  /** Defaults to 5 minutes. */
  readonly timeout?: Duration.Input
  /** Replaces the Node child-process layer (e.g. for tests). */
  readonly platformLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>
}

/** Raycast starts with a minimal PATH; these are where CLIs usually live on macOS. */
const DEFAULT_PATH_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
const DEFAULT_TIMEOUT: Duration.Input = "5 minutes"
const PATH_SEPARATOR = ":"
/** Asks well-behaved CLIs for plain output; ANSI codes are stripped anyway. */
const PLAIN_OUTPUT_ENV = { NO_COLOR: "1", FORCE_COLOR: "0" }

const searchPath = (options: ExecOptions) =>
  Config.String("PATH").pipe(
    Config.withDefault(SYSTEM_PATH),
    Config.map((inherited) => [...(options.pathDirs ?? DEFAULT_PATH_DIRS), inherited].join(PATH_SEPARATOR))
  )

const decoded = <E>(stream: Stream.Stream<Uint8Array, E>, to: (text: string) => Output) =>
  stream.pipe(Stream.decodeText(), Stream.map(to))

export const exec = (options: ExecOptions): Runner => {
  const spawn = (argv: ReadonlyArray<string>, output: Queue.Enqueue<Output, Cause.Done>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const command = ChildProcess.make(options.bin, [...(options.prefixArgs ?? []), ...argv], {
        cwd: options.cwd,
        env: { PATH: yield* searchPath(options), ...PLAIN_OUTPUT_ENV, ...options.env },
        extendEnv: true
      })
      const child = yield* spawner
        .spawn(command)
        .pipe(
          Effect.mapError(
            (cause) => new RunnerError({ reason: `Failed to start ${options.bin}: ${cause.message}`, cause })
          )
        )
      yield* Stream.merge(decoded(child.stdout, stdout), decoded(child.stderr, stderr)).pipe(
        Stream.runForEach((chunk) => Queue.offer(output, chunk))
      )
      return ExitCode.make(yield* child.exitCode)
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(options.timeout ?? DEFAULT_TIMEOUT),
      Effect.map(Option.getOrElse(() => ExitCodes.TimedOut)),
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(new RunnerError({ reason: `${options.bin} failed while running: ${cause.message}`, cause })),
        ConfigError: (cause) => Effect.fail(new RunnerError({ reason: `Cannot read PATH: ${cause.message}`, cause }))
      }),
      Effect.provide(options.platformLayer ?? nodeLayer)
    )
  return {
    [TypeId]: TypeId,
    _tag: "Exec",
    run: Effect.fn("Runner.exec.run")((argv, runOptions) => capture(runOptions, (output) => spawn(argv, output)))
  }
}
