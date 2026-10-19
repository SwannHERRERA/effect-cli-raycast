/**
 * The runtime values of `@raycast/api` the tested modules touch. Anything
 * that talks to Raycast goes through the `Raycast` service, which tests replace.
 */
const unavailable = (name: string) => () => Promise.reject(new Error(`${name} is not available in tests`))

export const Toast = { Style: { Animated: "ANIMATED", Success: "SUCCESS", Failure: "FAILURE" } }
export const Alert = { ActionStyle: { Default: "DEFAULT", Destructive: "DESTRUCTIVE", Cancel: "CANCEL" } }
export const Clipboard = { copy: unavailable("Clipboard.copy"), paste: unavailable("Clipboard.paste") }
export const LocalStorage = {
  getItem: unavailable("LocalStorage.getItem"),
  setItem: unavailable("LocalStorage.setItem"),
  removeItem: unavailable("LocalStorage.removeItem"),
  clear: unavailable("LocalStorage.clear"),
  allItems: unavailable("LocalStorage.allItems")
}
export const closeMainWindow = unavailable("closeMainWindow")
export const confirmAlert = unavailable("confirmAlert")
export const showHUD = unavailable("showHUD")
export const showToast = unavailable("showToast")
export const getPreferenceValues = () => ({})
