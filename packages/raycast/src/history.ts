/**
 * Run history and last-used values, persisted through a `KeyValueStore`
 * (Raycast `LocalStorage` in the extension). Values are stored as field tokens,
 * the same representation every input surface decodes to; secret and
 * preference-backed fields are never written.
 */
import { Field, Runner, Spec } from "@effect-cli-raycast/core"
import { Array as Arr, Context, Effect, Layer, Option, Record, Schema, Semaphore } from "effect"
import { KeyValueStore } from "effect/persistence"

export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

/** Run ids are React keys and history identities, so they must not collide across runs. */
export const newRunId: Effect.Effect<RunId> = Effect.sync(() => RunId.make(crypto.randomUUID()))

export const HistoryEntry = Schema.Struct({
  id: RunId,
  path: Spec.PathKey,
  commandLine: Schema.String,
  values: Field.FieldValues,
  exitCode: Runner.ExitCode,
  duration: Schema.Duration,
  at: Schema.DateTimeUtc
})
export interface HistoryEntry extends Schema.Schema.Type<typeof HistoryEntry> {}

const Entries = Schema.Array(HistoryEntry)

export const PREFIX = "effect-cli-raycast:"
export const HISTORY_KEY = "history"
const lastKey = (path: Spec.PathKey) => `last:${path}`

const isStorable = (param: Spec.ParamSpec): boolean => Spec.isFormField(param) && !Spec.isSecret(param)

/** The subset of a run's values that may be persisted. */
export const storable = (leaf: Spec.LeafSpec, values: Field.FieldValues): Field.FieldValues =>
  Record.fromEntries(
    leaf.fields.filter(isStorable).flatMap((param) =>
      Record.get(values, param.id).pipe(
        Option.map((tokens) => [param.id, tokens] as const),
        Option.toArray
      )
    )
  )

export interface HistoryStore {
  readonly load: Effect.Effect<ReadonlyArray<HistoryEntry>>
  /** Newest first, capped at `max`. */
  readonly push: (
    entry: HistoryEntry,
    max: number
  ) => Effect.Effect<void, KeyValueStore.KeyValueStoreError | Schema.SchemaError>
  readonly clear: Effect.Effect<void, KeyValueStore.KeyValueStoreError>
  readonly loadLastValues: (path: Spec.PathKey) => Effect.Effect<Option.Option<Field.FieldValues>>
  readonly saveLastValues: (
    path: Spec.PathKey,
    values: Field.FieldValues
  ) => Effect.Effect<void, KeyValueStore.KeyValueStoreError | Schema.SchemaError>
}

export class History extends Context.Service<History, HistoryStore>()("effect-cli-raycast/History") {}

/**
 * Unreadable entries (written by an older version, or corrupted) read as
 * empty: history is a convenience, never a reason to fail a screen.
 */
const orElseEmpty = <A, E>(effect: Effect.Effect<Option.Option<A>, E>) =>
  effect.pipe(
    Effect.tapError((error) => Effect.logWarning("History.unreadable", error)),
    Effect.orElseSucceed(Option.none<A>)
  )

export const layer = Layer.effect(
  History,
  Effect.gen(function* () {
    const store = KeyValueStore.prefix(yield* KeyValueStore.KeyValueStore, PREFIX)
    const entries = KeyValueStore.toSchemaStore(store, Entries)
    const last = KeyValueStore.toSchemaStore(store, Field.FieldValues)
    // `push` reads then writes; overlapping runs (a form and an AI tool) would drop entries.
    const writes = yield* Semaphore.make(1)
    const load = orElseEmpty(entries.get(HISTORY_KEY)).pipe(Effect.map(Option.getOrElse(Arr.empty<HistoryEntry>)))
    return History.of({
      load,
      push: (entry, max) =>
        Effect.flatMap(load, (current) => entries.set(HISTORY_KEY, Arr.prepend(current, entry).slice(0, max))).pipe(
          writes.withPermits(1)
        ),
      clear: entries.remove(HISTORY_KEY).pipe(writes.withPermits(1)),
      loadLastValues: (path) => orElseEmpty(last.get(lastKey(path))),
      saveLastValues: (path, values) => last.set(lastKey(path), values)
    })
  })
)
