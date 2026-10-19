/**
 * `@raycast/api` as a service. Every other module talks to Raycast through it,
 * so the runtime stays in `Effect` until a Raycast entry point, and tests can
 * swap in a recording implementation.
 */
import {
  type Alert,
  Clipboard,
  closeMainWindow,
  confirmAlert,
  getPreferenceValues,
  LocalStorage,
  showHUD,
  showToast,
  type Toast
} from "@raycast/api"
import { Context, Effect, Layer, Option, Record, Schema } from "effect"
import { KeyValueStore } from "effect/persistence"

export class RaycastError extends Schema.TaggedError<RaycastError>()("RaycastError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `Raycast ${this.operation} failed`
  }
}

export type ToastUpdate = Partial<Pick<Toast, "style" | "title" | "message" | "primaryAction">>

export interface RaycastUi {
  readonly confirm: (options: Alert.Options) => Effect.Effect<boolean, RaycastError>
  readonly toast: (options: Toast.Options) => Effect.Effect<Toast, RaycastError>
  /** Raycast toasts are updated by mutation. */
  readonly updateToast: (toast: Toast, update: ToastUpdate) => Effect.Effect<void>
  readonly hideToast: (toast: Toast) => Effect.Effect<void, RaycastError>
  readonly copy: (text: string) => Effect.Effect<void, RaycastError>
  /** Pastes into the app behind Raycast, so the Raycast window is closed first. */
  readonly paste: (text: string) => Effect.Effect<void, RaycastError>
  /** `showHUD` hides the main window itself. */
  readonly hud: (text: string) => Effect.Effect<void, RaycastError>
  /** Extension preferences, keyed by preference name. */
  readonly preference: (name: string) => Effect.Effect<Option.Option<unknown>>
}

export class Raycast extends Context.Service<Raycast, RaycastUi>()("effect-cli-raycast/Raycast") {}

const attempt = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, RaycastError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new RaycastError({ operation, cause }) })

export const layer = Layer.succeed(Raycast, {
  confirm: (options) => attempt("confirmAlert", () => confirmAlert(options)),
  toast: (options) => attempt("showToast", () => showToast(options)),
  updateToast: (toast, update) => Effect.sync(() => void Object.assign(toast, update)),
  hideToast: (toast) => attempt("Toast.hide", () => toast.hide()),
  copy: (text) => attempt("Clipboard.copy", () => Clipboard.copy(text)),
  paste: (text) =>
    attempt("closeMainWindow", () => closeMainWindow()).pipe(
      Effect.andThen(attempt("Clipboard.paste", () => Clipboard.paste(text)))
    ),
  hud: (text) => attempt("showHUD", () => showHUD(text)),
  preference: (name) => Effect.sync(() => Record.get(getPreferenceValues<Record<string, unknown>>(), name))
})

const storageError = (method: string, key?: string) => (cause: unknown) =>
  new KeyValueStore.KeyValueStoreError({ message: `LocalStorage.${method} failed`, method, key, cause })

/** Raycast `LocalStorage` as an Effect `KeyValueStore`. */
export const localStorageLayer = Layer.succeed(
  KeyValueStore.KeyValueStore,
  KeyValueStore.makeStringOnly({
    get: (key) => Effect.tryPromise({ try: () => LocalStorage.getItem<string>(key), catch: storageError("get", key) }),
    set: (key, value) =>
      Effect.tryPromise({ try: () => LocalStorage.setItem(key, value), catch: storageError("set", key) }),
    remove: (key) => Effect.tryPromise({ try: () => LocalStorage.removeItem(key), catch: storageError("remove", key) }),
    clear: Effect.tryPromise({ try: () => LocalStorage.clear(), catch: storageError("clear") }),
    size: Effect.tryPromise({ try: () => LocalStorage.allItems(), catch: storageError("size") }).pipe(
      Effect.map((items) => Object.keys(items).length)
    )
  })
)
