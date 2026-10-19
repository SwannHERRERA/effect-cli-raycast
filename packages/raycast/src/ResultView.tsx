import { Runner } from "@effect-cli-raycast/core"
import { Action, ActionPanel, Color, Detail, Icon } from "@raycast/api"
import { Array as Arr, Duration, Effect, Match, Option, Result, Schema, String as Str } from "effect"
import { useState } from "react"
import { runAction } from "./hooks.ts"
import { codeBlock } from "./markdown.ts"
import { type ResultContext, type Services, type Session, Shortcuts } from "./types.ts"

const SECTION_SEPARATOR = "\n\n"

const PrettyJson = Schema.fromJsonString(Schema.Unknown, { space: 2 })
const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const printJson = Schema.encodeUnknownResult(PrettyJson)

/** JSON output is re-indented; anything that does not parse is shown verbatim. */
const jsonBlock = (stdout: string): string =>
  parseJson(stdout).pipe(
    Result.flatMap(printJson),
    Result.match({
      onSuccess: (pretty) => codeBlock(pretty, Option.some("json")),
      onFailure: () => codeBlock(stdout, Option.none())
    })
  )

const bodyOf = (session: Session, stdout: string): Option.Option<string> =>
  Option.liftPredicate(stdout, Str.isNonEmpty).pipe(
    Option.map((output) =>
      Match.value(session.config.options.output.format).pipe(
        Match.when("markdown", () => output),
        Match.when("json", () => jsonBlock(output)),
        Match.when("code", () => codeBlock(output, Option.none())),
        Match.exhaustive
      )
    )
  )

const stderrOf = (stderr: string): Option.Option<string> =>
  Option.liftPredicate(stderr, Str.isNonEmpty).pipe(
    Option.map((text) => `#### stderr\n${codeBlock(text, Option.none())}`)
  )

export const defaultMarkdown = (session: Session, context: ResultContext): string => {
  const { result } = context
  return [
    `### ${context.leaf.command.title}`,
    Option.getOrElse(bodyOf(session, result.stdout.trimEnd()), () => "_No output._"),
    ...Option.toArray(stderrOf(result.stderr.trimEnd()))
  ].join(SECTION_SEPARATOR)
}

const StatusTag = ({ result }: { readonly result: Runner.RunResult }) =>
  Match.value(Runner.statusOf(result.exitCode)).pipe(
    Match.when("succeeded", () => <Detail.Metadata.TagList.Item text="Success" color={Color.Green} />),
    Match.when("failed", () => <Detail.Metadata.TagList.Item text={`Exit ${result.exitCode}`} color={Color.Red} />),
    Match.exhaustive
  )

export function ResultView(props: {
  readonly session: Session
  readonly context: ResultContext
  /** Present when the run can be repeated from this screen; receives the result currently shown. */
  readonly rerun: Option.Option<(current: ResultContext) => Effect.Effect<ResultContext, unknown, Services>>
}) {
  const { session } = props
  const [context, setContext] = useState(props.context)
  const [running, setRunning] = useState(false)
  const { result } = context
  const stdout = result.stdout.trimEnd()

  /** The spinner shows for exactly as long as the re-run is in flight. */
  const rerunAction = Option.map(
    props.rerun,
    (rerun) => () =>
      runAction(
        session,
        Effect.acquireUseRelease(
          Effect.sync(() => setRunning(true)),
          () => rerun(context).pipe(Effect.tap((next) => Effect.sync(() => setContext(next)))),
          () => Effect.sync(() => setRunning(false))
        )
      )
  )

  return Option.match(Option.fromUndefinedOr(session.ui.renderResult), {
    onSome: (render) => <>{render(context)}</>,
    onNone: () => (
      <Detail
        isLoading={running}
        navigationTitle={context.leaf.command.path.join(" ")}
        markdown={Option.fromUndefinedOr(session.ui.formatOutput).pipe(
          Option.match({ onNone: () => defaultMarkdown(session, context), onSome: (format) => format(context) })
        )}
        metadata={
          <Detail.Metadata>
            <Detail.Metadata.TagList title="Status">
              <StatusTag result={result} />
            </Detail.Metadata.TagList>
            <Detail.Metadata.Label title="Duration" text={Duration.format(result.duration)} />
            <Detail.Metadata.Label title="Runner" text={session.config.options.runner._tag} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.Label title="Command" text={context.commandLine} />
          </Detail.Metadata>
        }
        actions={
          <ActionPanel>
            <Action.CopyToClipboard title="Copy Output" content={stdout} shortcut={Shortcuts.copyOutput} />
            <Action.CopyToClipboard
              title="Copy Command Line"
              content={context.commandLine}
              shortcut={Shortcuts.copyCommandLine}
            />
            <Action.Paste title="Paste Output" content={stdout} />
            {Option.toArray(rerunAction).map((onAction) => (
              <Action
                key="rerun"
                title="Run Again"
                icon={Icon.ArrowClockwise}
                shortcut={Shortcuts.runAgain}
                onAction={onAction}
              />
            ))}
            {Arr.filter([result.stderr.trimEnd()], Str.isNonEmpty).map((stderr) => (
              <Action.CopyToClipboard
                key="stderr"
                title="Copy Stderr"
                content={stderr}
                shortcut={Shortcuts.copyStderr}
              />
            ))}
          </ActionPanel>
        }
      />
    )
  })
}
