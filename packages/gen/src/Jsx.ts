/**
 * A tiny JSX syntax tree and its printer. Generated components are built as
 * data, so quoting, nesting and indentation are decided in one place.
 */
import { Source } from "@effect-cli-raycast/core"
import { Array as Arr, Boolean as Bool, Data } from "effect"

export interface Element {
  readonly tag: string
  readonly attributes: ReadonlyArray<Attribute>
  readonly children: ReadonlyArray<Element>
}

export type Attribute = Data.TaggedEnum<{
  /** `title="Deploy"` */
  Text: { readonly name: string; readonly value: string }
  /** `error={form.errorOf("env")}` */
  Expression: { readonly name: string; readonly code: string }
  /** `storeValue` */
  Flag: { readonly name: string }
  /** `actions={<ActionPanel>…</ActionPanel>}`, always printed on its own lines */
  Element: { readonly name: string; readonly element: Element }
}>

export const Attribute = Data.taggedEnum<Attribute>()

export const element = (
  tag: string,
  attributes: ReadonlyArray<Attribute>,
  children: ReadonlyArray<Element> = []
): Element => ({ tag, attributes, children })

export const text = (name: string, value: string): Attribute => Attribute.Text({ name, value })
export const expression = (name: string, code: string): Attribute => Attribute.Expression({ name, code })
export const flag = (name: string): Attribute => Attribute.Flag({ name })
export const nested = (name: string, child: Element): Attribute => Attribute.Element({ name, element: child })

const INDENT = "  "
const SELF_CLOSING = " />"
const OPEN = ">"

/**
 * A JSX string attribute ends at `"`, decodes `&…;` entities and keeps line
 * breaks verbatim; any of those makes the value an expression instead.
 */
const JSX_STRING_UNSAFE = ['"', "&", "\n", "\r"]

const isJsxStringSafe = (value: string): boolean => !JSX_STRING_UNSAFE.some((unsafe) => value.includes(unsafe))

const textValue = (value: string): string =>
  Bool.match(isJsxStringSafe(value), { onTrue: () => `"${value}"`, onFalse: () => `{${Source.string(value)}}` })

const indent = (lines: ReadonlyArray<string>): Array<string> => lines.map((line) => `${INDENT}${line}`)

const isBlock = (attribute: Attribute): boolean => Attribute.$is("Element")(attribute)

const lines = (attribute: Attribute): Array<string> =>
  Attribute.$match(attribute, {
    Text: ({ name, value }) => [`${name}=${textValue(value)}`],
    Expression: ({ name, code }) => [`${name}={${code}}`],
    Flag: ({ name }) => [name],
    Element: ({ name, element: child }) => [`${name}={`, ...indent(print(child)), "}"]
  })

/** Elements carrying nested elements in attributes put one attribute per line. */
const opening = (node: Element, closing: typeof SELF_CLOSING | typeof OPEN): Array<string> =>
  Bool.match(node.attributes.some(isBlock), {
    onTrue: () => [`<${node.tag}`, ...indent(node.attributes.flatMap(lines)), closing.trim()],
    onFalse: () => [[`<${node.tag}`, ...node.attributes.flatMap(lines)].join(" ") + closing]
  })

/** Source lines for an element, without trailing newline. */
export const print = (node: Element): Array<string> =>
  Arr.match(node.children, {
    onEmpty: () => opening(node, SELF_CLOSING),
    onNonEmpty: (children) => [...opening(node, OPEN), ...indent(children.flatMap(print)), `</${node.tag}>`]
  })
