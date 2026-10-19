/**
 * TypeScript source fragments for generated files. Literals go through a
 * Schema codec so every emitted string is a valid, escaped TS literal.
 */
import { Array as Arr, Match, Option, Schema, String as Str } from "effect"

const StringLiteral = Schema.fromJsonString(Schema.String)
const BooleanLiteral = Schema.fromJsonString(Schema.Boolean)
const StringArrayLiteral = Schema.fromJsonString(Schema.Array(Schema.String))

/** `deploy` → `"deploy"` */
export const string = (value: string): string => Schema.encodeSync(StringLiteral)(value)

export const boolean = (value: boolean): string => Schema.encodeSync(BooleanLiteral)(value)

/** `["a", "b"]` → `["a","b"]` */
export const stringArray = (values: ReadonlyArray<string>): string => Schema.encodeSync(StringArrayLiteral)(values)

const COMMENT_END = "*/"
const ESCAPED_COMMENT_END = "*\\/"

/** A one-line JSDoc block, or nothing. */
export const jsDoc = (text: Option.Option<string>, indent: string): Array<string> =>
  Option.match(text, {
    onNone: () => [],
    onSome: (doc) => [`${indent}/** ${doc.replaceAll(COMMENT_END, ESCAPED_COMMENT_END)} */`]
  })

const CURRENT_DIR = "./"
const PARENT_DIR = "../"

/** A module specifier as seen from one directory deeper (`./app` → `../app`, `../lib` → `../../lib`). */
export const fromSubdirectory = (specifier: string): string =>
  Match.value(specifier).pipe(
    Match.when(Str.startsWith(CURRENT_DIR), (relative) => `${PARENT_DIR}${relative.slice(CURRENT_DIR.length)}`),
    Match.when(Str.startsWith(PARENT_DIR), (relative) => `${PARENT_DIR}${relative}`),
    Match.orElse((bare) => bare)
  )

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** An object/type property key: bare when it is a valid identifier, quoted otherwise (`2fa` → `"2fa"`). */
export const propertyKey = (name: string): string =>
  Match.value(name).pipe(
    Match.when(
      (key) => IDENTIFIER.test(key),
      (key) => key
    ),
    Match.orElse(string)
  )

const LINE_END = "\n"

export const lines = (...parts: ReadonlyArray<string | ReadonlyArray<string>>): string =>
  Arr.flatten(parts.map((part) => Arr.ensure(part))).join(LINE_END)
