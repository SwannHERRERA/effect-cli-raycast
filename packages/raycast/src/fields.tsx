/**
 * Default widget registry: ParamSpec → Raycast `Form.*` item.
 * Every entry can be replaced through `UiOptions.widgets` / `UiOptions.fields`.
 */
import { Field, Include, Spec } from "@effect-cli-raycast/core"
import { Form } from "@raycast/api"
import { Option } from "effect"
import type { WidgetRenderers } from "./types.ts"

/** Optional dropdowns need an explicit "nothing selected" entry. */
const NO_CHOICE = { value: "", title: "—" }

export const defaultWidgets: WidgetRenderers = {
  text: ({ item, defaultValue }) => <Form.TextField {...item} defaultValue={defaultValue} />,
  textarea: ({ item, defaultValue }) => <Form.TextArea {...item} defaultValue={defaultValue} />,
  password: ({ item }) => <Form.PasswordField {...item} storeValue={false} />,
  checkbox: ({ item, defaultValue, param }) => (
    <Form.Checkbox
      {...item}
      label={Option.getOrElse(param.description, () => param.title)}
      defaultValue={defaultValue}
    />
  ),
  dropdown: ({ item, defaultValue, param }) => (
    <Form.Dropdown {...item} defaultValue={defaultValue}>
      {[
        ...Include.when(!Spec.isRequired(param), () => NO_CHOICE),
        ...Spec.choicesOf(param).map((choice) => ({ value: choice, title: choice }))
      ].map((choice) => (
        <Form.Dropdown.Item key={choice.value} value={choice.value} title={choice.title} />
      ))}
    </Form.Dropdown>
  ),
  tags: ({ item, defaultValue, param }) => (
    <Form.TagPicker {...item} defaultValue={[...defaultValue]}>
      {Spec.choicesOf(param).map((choice) => (
        <Form.TagPicker.Item key={choice} value={choice} title={choice} />
      ))}
    </Form.TagPicker>
  ),
  date: ({ item, defaultValue }) => (
    <Form.DatePicker {...item} type={Form.DatePicker.Type.DateTime} defaultValue={defaultValue} />
  ),
  file: ({ item, defaultValue, param }) => (
    <Form.FilePicker
      {...item}
      allowMultipleSelection={Spec.isVariadic(param)}
      canChooseDirectories={Field.pathTypeOf(param) !== "file"}
      canChooseFiles={Field.pathTypeOf(param) !== "directory"}
      defaultValue={[...defaultValue]}
    />
  )
}
