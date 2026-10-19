import { Runner, Spec } from "@effect-cli-raycast/core"
import { Action, ActionPanel, Color, Icon, List } from "@raycast/api"
import { Array as Arr, Boolean as Bool, DateTime, Effect, Match, Option } from "effect"
import { CommandForm, emptySeed } from "./CommandForm.tsx"
import { ErrorScreen } from "./ErrorScreen.tsx"
import { History, type HistoryEntry } from "./history.ts"
import { AsyncState, runAction, useEffectState } from "./hooks.ts"
import * as Inputs from "./inputs.ts"
import type { Session } from "./types.ts"
import { useRunner } from "./useRunner.tsx"

/** How many recent runs the browser lists above the commands. */
const RECENT_RUNS = 8
const DEFAULT_SECTION = "Commands"
const HISTORY_KEY = "history"

/** Top-level commands get their group; nested ones are listed under their top-level parent. */
const sectionOf = (leaf: Spec.LeafSpec): string =>
  Option.match(Arr.get(leaf.lineage, 1), {
    onNone: () => DEFAULT_SECTION,
    onSome: (top) =>
      Option.getOrElse(top.group, () =>
        Bool.match(leaf.lineage.length > 2, { onTrue: () => top.title, onFalse: () => DEFAULT_SECTION })
      )
  })

const statusIcon = (entry: HistoryEntry) =>
  Match.value(Runner.statusOf(entry.exitCode)).pipe(
    Match.when("succeeded", () => ({ source: Icon.CheckCircle, tintColor: Color.Green })),
    Match.when("failed", () => ({ source: Icon.XMarkCircle, tintColor: Color.Red })),
    Match.exhaustive
  )

interface RecentRun {
  readonly entry: HistoryEntry
  readonly leaf: Spec.LeafSpec
}

/** Runs of commands that no longer exist are skipped, not shown broken. */
const recentRuns = (session: Session, entries: ReadonlyArray<HistoryEntry>): Array<RecentRun> =>
  Arr.getSomes(
    entries.slice(0, RECENT_RUNS).map((entry) =>
      Option.map(Spec.findLeaf(session.config.spec, Spec.pathOf(session.config.spec, entry.path)), (leaf) => ({
        entry,
        leaf
      }))
    )
  )

const iconOf = (leaf: Spec.LeafSpec) =>
  Option.getOrElse(Option.fromUndefinedOr(leaf.command.meta.icon), () => Icon.Terminal)

export function CommandBrowser(props: { readonly session: Session }) {
  const { session } = props
  const { spec, options } = session.config
  const runner = useRunner(session)

  const [history, reload] = useEffectState(session, HISTORY_KEY, () =>
    Bool.match(options.history.enabled, {
      onTrue: () => History.use((store) => store.load),
      onFalse: () => Effect.succeed(Arr.empty<HistoryEntry>())
    })
  )

  const sections = Arr.groupBy(
    Spec.leaves(spec).filter((leaf) => Arr.isReadonlyArrayNonEmpty(Arr.tailNonEmpty(leaf.lineage))),
    sectionOf
  )

  const runAgain = (run: RecentRun) =>
    runner.submit(run.leaf, Inputs.fromTokens(run.leaf, run.entry.values)).pipe(Effect.andThen(reload))

  const recent = (runs: ReadonlyArray<RecentRun>) =>
    Arr.match(runs, {
      onEmpty: () => [],
      onNonEmpty: (all) => [
        <List.Section key="recent" title="Recent">
          {all.map((run) => (
            <List.Item
              key={run.entry.id}
              icon={statusIcon(run.entry)}
              title={run.entry.commandLine}
              accessories={[{ date: DateTime.toDate(run.entry.at) }]}
              actions={
                <ActionPanel>
                  <Action.Push
                    title="Edit and Run"
                    icon={Icon.Pencil}
                    target={
                      <CommandForm
                        session={session}
                        leaf={run.leaf}
                        seed={{ ...emptySeed, explicit: run.entry.values }}
                      />
                    }
                  />
                  <Action
                    title="Run Again"
                    icon={Icon.ArrowClockwise}
                    onAction={() => runAction(session, runAgain(run))}
                  />
                  <Action.CopyToClipboard title="Copy Command Line" content={run.entry.commandLine} />
                  <Action
                    title="Clear History"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    onAction={() =>
                      runAction(session, History.use((store) => store.clear).pipe(Effect.andThen(reload)))
                    }
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ]
    })

  return AsyncState.$match(history, {
    Failed: ({ cause }) => <ErrorScreen title="Cannot load recent runs" cause={cause} />,
    Loading: () => <List isLoading navigationTitle={spec.root.title} />,
    Ready: ({ value }) => (
      <List navigationTitle={spec.root.title} searchBarPlaceholder="Search commands…">
        {recent(recentRuns(session, value))}
        {Object.entries(sections).map(([title, leaves]) => (
          <List.Section key={title} title={title}>
            {leaves.map((leaf) => (
              <List.Item
                key={leaf.command.path.join(" ")}
                icon={iconOf(leaf)}
                title={Arr.tailNonEmpty(leaf.lineage)
                  .map((command) => command.title)
                  .join(" › ")}
                subtitle={Option.getOrUndefined(
                  Option.orElse(leaf.command.shortDescription, () => leaf.command.description)
                )}
                keywords={[...leaf.command.path, ...Option.toArray(leaf.command.alias)]}
                accessories={[{ text: Spec.pathKey(leaf.command.path), tooltip: leaf.command.path.join(" ") }]}
                actions={
                  <ActionPanel>
                    <Action.Push
                      title="Open Form"
                      icon={Icon.Pencil}
                      target={<CommandForm session={session} leaf={leaf} seed={emptySeed} />}
                      onPop={() => runAction(session, reload)}
                    />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        ))}
      </List>
    )
  })
}
