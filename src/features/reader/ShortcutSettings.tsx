import { KeyboardIcon } from "@phosphor-icons/react";
import { Card } from "../../components/ui/Card";
import { useI18n, type MessageKey } from "../../i18n/i18n";
import { useAppearance } from "../appearance/AppearanceProvider";
import { commandShortcuts, escapeReturnWindow } from "./shortcuts";

type Context =
  | "Library"
  | "Application pages"
  | "Reader"
  | "Dictionary popup"
  | "Library selection"
  | "Dictionary selection"
  | "Reader lookup"
  | "Image viewer"
  | "Controls";

const contextNames: Record<Context, MessageKey> = {
  Library: "shortcuts.contextLibrary",
  "Application pages": "shortcuts.contextPages",
  Reader: "shortcuts.contextReader",
  "Dictionary popup": "shortcuts.contextPopup",
  "Library selection": "shortcuts.contextLibrarySelection",
  "Dictionary selection": "shortcuts.contextDictionarySelection",
  "Reader lookup": "shortcuts.contextLookup",
  "Image viewer": "shortcuts.contextImageViewer",
  Controls: "shortcuts.contextControls",
};

interface Row {
  context: Context;
  binding: string;
  action: string;
  availability?: string;
}

export function ShortcutSettings() {
  const appearance = useAppearance();
  const { t } = useI18n();
  const lookupKey = { "shift-enter": "Shift+Enter", "alt-x": "Alt+X", "ctrl-space": "Ctrl+Space" }[
    appearance.readerPopupShortcutPreset
  ];
  const ankiDisabled = !appearance.readerPopupAnkiAction;
  const rows: Row[] = [
    ...commandShortcuts.map((shortcut) => ({
      context: shortcut.context,
      binding: shortcut.binding,
      action: t(`shortcuts.${shortcut.id}`),
      availability:
        shortcut.context === "Dictionary popup" && ankiDisabled
          ? t("shortcuts.ankiDisabled")
          : "availability" in shortcut
            ? t(`shortcuts.${shortcut.id}.availability`)
            : undefined,
    })),
    {
      context: "Library",
      binding: t("shortcuts.keyArrows"),
      action: t("shortcuts.moveBooks"),
      availability: t("shortcuts.moveBooks.availability"),
    },
    {
      context: "Library",
      binding: t("shortcuts.keySpace"),
      action: t("shortcuts.selectBook"),
      availability: t("shortcuts.moveBooks.availability"),
    },
    {
      context: "Library",
      binding: t("shortcuts.keyBookActions"),
      action: t("shortcuts.bookActions"),
      availability: t("shortcuts.moveBooks.availability"),
    },
    {
      context: "Library",
      binding: t("shortcuts.keyEscapeAltLeft"),
      action: t("shortcuts.leaveGroup"),
      availability: t("shortcuts.leaveGroup.availability"),
    },
    {
      context: "Library selection",
      binding: "Ctrl+A / Meta+A",
      action: t("shortcuts.selectAllBooks"),
      availability: t("shortcuts.selectAllBooks.availability"),
    },
    {
      context: "Dictionary selection",
      binding: "Ctrl+A / Meta+A",
      action: t("shortcuts.selectAllDictionaries"),
      availability: t("shortcuts.selectAllDictionaries.availability"),
    },
    {
      context: "Library selection",
      binding: t("shortcuts.keyDelete"),
      action: t("shortcuts.removeSelected"),
      availability: t("shortcuts.removeSelected.availability"),
    },
    {
      context: "Library selection",
      binding: t("shortcuts.keyEscape"),
      action: t("shortcuts.cancelSelection"),
      availability: t("shortcuts.cancelSelection.availability"),
    },
    {
      context: "Reader",
      binding: t("shortcuts.keyLeftRight"),
      action: t("shortcuts.readBackForward"),
      availability: t("shortcuts.readBackForward.availability"),
    },
    {
      context: "Reader",
      binding: t("shortcuts.keyUpDown"),
      action: t("shortcuts.scrollBackForward"),
      availability: t("shortcuts.scrollBackForward.availability"),
    },
    {
      context: "Reader",
      binding: t("shortcuts.keyPageKeys"),
      action: t("shortcuts.pageBackForward"),
      availability: t("shortcuts.pageBackForward.availability"),
    },
    {
      context: "Reader",
      binding: t("shortcuts.keyHomeEnd"),
      action: t("shortcuts.chapterStartNext"),
      availability: t("shortcuts.chapterStartNext.availability"),
    },
    {
      context: "Reader",
      binding: t("shortcuts.keyWheel"),
      action: t("shortcuts.wheel"),
      availability: t("shortcuts.wheel.availability"),
    },
    {
      context: "Reader",
      binding: t("shortcuts.keySpace"),
      action: t("shortcuts.vnSpace"),
      availability: t("shortcuts.vnSpace.availability"),
    },
    {
      context: "Reader",
      binding: t("shortcuts.keyEscapeTwice"),
      action: t("shortcuts.returnToLibrary"),
      availability: t("shortcuts.returnToLibrary.availability", {
        seconds: escapeReturnWindow / 1000,
      }),
    },
    {
      context: "Reader lookup",
      binding: lookupKey,
      action: t("shortcuts.lookupSelection"),
      availability:
        appearance.readerPopupEnabled && appearance.readerPopupKeyboardShortcut
          ? t("shortcuts.lookupSelection.availability")
          : t("shortcuts.disabledInPopup"),
    },
    {
      context: "Reader lookup",
      binding: "Shift",
      action: t("shortcuts.scanPointer"),
      availability:
        appearance.readerPopupEnabled && appearance.readerPopupShiftLookup
          ? t("shortcuts.scanPointer.availability")
          : t("shortcuts.disabledInPopup"),
    },
    {
      context: "Reader lookup",
      binding: t("shortcuts.keyShiftRightClick"),
      action: t("shortcuts.lookupPointer"),
      availability:
        appearance.readerPopupEnabled &&
        appearance.readerPopupClickLookup &&
        appearance.readerPopupMouseTrigger === "shift-right"
          ? t("shortcuts.enabled")
          : t("shortcuts.disabledByClickLookup"),
    },
    {
      context: "Reader lookup",
      binding: t("shortcuts.keyMiddleClick"),
      action: t("shortcuts.lookupPointer"),
      availability:
        appearance.readerPopupEnabled &&
        appearance.readerPopupClickLookup &&
        appearance.readerPopupMouseTrigger === "middle"
          ? t("shortcuts.enabled")
          : t("shortcuts.disabledByClickLookup"),
    },
    {
      context: "Dictionary popup",
      binding: t("shortcuts.keyAltWheel"),
      action: t("shortcuts.nextExpression"),
      availability: t("shortcuts.nextExpression.availability"),
    },
    {
      context: "Dictionary popup",
      binding: t("shortcuts.keyEscape"),
      action: t("shortcuts.dismissLookup"),
      availability:
        appearance.readerPopupCloseBehavior === "escape-outside"
          ? t("shortcuts.enabled")
          : t("shortcuts.disabledByClose"),
    },
    {
      context: "Image viewer",
      binding: t("shortcuts.keyLeftRight"),
      action: t("shortcuts.previousNextImage"),
    },
    { context: "Image viewer", binding: "+ / =, −", action: t("shortcuts.zoom") },
    {
      context: "Image viewer",
      binding: t("shortcuts.keyCtrlWheel"),
      action: t("shortcuts.zoomPointer"),
    },
    { context: "Image viewer", binding: "R", action: t("shortcuts.rotate") },
    { context: "Image viewer", binding: "0", action: t("shortcuts.resetZoom") },
    {
      context: "Image viewer",
      binding: t("shortcuts.keyEscape"),
      action: t("shortcuts.closeViewer"),
    },
    { context: "Controls", binding: "Tab / Shift+Tab", action: t("shortcuts.moveFocus") },
    {
      context: "Controls",
      binding: t("shortcuts.keyEnterSpace"),
      action: t("shortcuts.activate"),
    },
    {
      context: "Controls",
      binding: t("shortcuts.keySelectText"),
      action: t("shortcuts.selectText"),
      availability: t("shortcuts.selectText.availability"),
    },
    {
      context: "Controls",
      binding: t("shortcuts.keyArrowsHomeEnd"),
      action: t("shortcuts.moveOptions"),
    },
    {
      context: "Controls",
      binding: t("shortcuts.keyArrowsHomeEnd"),
      action: t("shortcuts.moveDays"),
      availability: t("shortcuts.moveDays.availability"),
    },
    {
      context: "Controls",
      binding: t("shortcuts.keyOpenSelect"),
      action: t("shortcuts.openSelect"),
    },
    {
      context: "Controls",
      binding: t("shortcuts.keyEscape"),
      action: t("shortcuts.closeMenu"),
    },
    {
      context: "Controls",
      binding: t("shortcuts.keyEscapeSearch"),
      action: t("shortcuts.leaveSearch"),
    },
  ];
  const contexts = [...new Set(rows.map((row) => row.context))];
  return (
    <Card className="settings-card settings-card--wide">
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <KeyboardIcon aria-hidden="true" weight="duotone" />
        </span>
        <div>
          <h2>{t("shortcuts.title")}</h2>
          <p>{t("shortcuts.description")}</p>
        </div>
      </div>
      {contexts.map((context) => (
        <section key={context} className="shortcut-reference">
          <h3>{t(contextNames[context])}</h3>
          <div className="shortcut-reference__table">
            <table>
              {/* Every context's table shares these widths, so the columns line up down the page. */}
              <colgroup>
                <col className="shortcut-reference__keys" />
                <col className="shortcut-reference__action" />
                <col className="shortcut-reference__availability" />
              </colgroup>
              <thead>
                <tr>
                  <th>{t("shortcuts.shortcut")}</th>
                  <th>{t("shortcuts.action")}</th>
                  <th>{t("shortcuts.availability")}</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((row) => row.context === context)
                  .map((row) => (
                    <tr key={row.binding}>
                      <td>
                        <kbd>{row.binding}</kbd>
                      </td>
                      <td>{row.action}</td>
                      <td>
                        {row.availability ??
                          t(
                            context === "Application pages"
                              ? "shortcuts.pagesAvailability"
                              : "shortcuts.focusAvailability",
                          )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </Card>
  );
}
