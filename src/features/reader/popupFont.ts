import { useEffect } from "react";
import {
  popupFontFaces,
  popupFontStack,
  type ReaderFontChoice,
  type UploadedFont,
} from "./fontChoices";
import { useReaderFonts } from "./readerFonts";

const styleId = "komori-popup-fonts";

/**
 * The lookup popup's font stack. The popup is in Komori's own window rather than the book's
 * frame, so its Google or uploaded faces are declared once in the document and kept there: font
 * files are served without caching, and each new popup reuses the faces already loaded. The
 * Reader calls it too, so the faces load before its first popup.
 */
export function usePopupFont(choice: ReaderFontChoice): string {
  const { fonts } = useReaderFonts();
  const downloaded = fonts.filter((f) => f.source === "google" && f.available).map((f) => f.id);
  const uploaded = fonts.filter((f) => f.source === "uploaded" && f.available) as UploadedFont[];
  const faces = popupFontFaces(choice, downloaded, uploaded);
  const stack = popupFontStack(choice);
  useEffect(() => {
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.append(style);
    }
    if (style.textContent !== faces) style.textContent = faces;
    for (const weight of [400, 600])
      void document.fonts?.load(`${weight} 16px ${stack}`, "読み").catch(() => undefined);
  }, [faces, stack]);
  return stack;
}
