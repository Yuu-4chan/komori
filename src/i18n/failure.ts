import type { MessageKey } from "./i18n";
import { en } from "./messages/en";

/**
 * A native failure in the interface language. Native code names the failures a user can act
 * on with a `failure.…` message key; anything else, such as an unexpected I/O or storage
 * error, is shown as it came.
 */
export function failureText(message: string, t: (key: MessageKey) => string): string {
  return message.startsWith("failure.") && Object.hasOwn(en, message)
    ? t(message as MessageKey)
    : message;
}
