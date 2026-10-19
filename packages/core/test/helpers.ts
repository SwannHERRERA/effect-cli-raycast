import { Effect, Option, Record } from "effect"
import { Field, Introspect, Spec } from "#src/index"
import { acme } from "./fixture.ts"

export const spec = Effect.runSync(Introspect.fromCommand(acme, { version: "1.0.0" }))

export const leaf = (path: string): Spec.LeafSpec => Option.getOrThrow(Spec.findLeaf(spec, Spec.pathOf(spec, path)))

/** What a Raycast form submits: the given widget values, every other field at its initial value. */
export const submit = (target: Spec.LeafSpec, raw: Readonly<Record<string, unknown>>) =>
  Field.decodeLeaf(target, (param) => {
    const widget = Field.defaultWidget(param)
    const value = Record.get(raw, param.id).pipe(
      Option.getOrElse(() => Field.toWidget(widget, Field.initialTokens(param, [])))
    )
    return Field.decode(Field.widgetCodec(param, widget), value)
  })
