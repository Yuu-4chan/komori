import { useEffect, useRef, useState } from "react";
import { onLibraryFileDrag, postLibraryFiles } from "./libraryApi";

/** Listen only while the Library is present; cleanup also refuses queued/late events. */
export function useLibraryDrop(
  busy: boolean,
  drop: (dropId: string) => Promise<void>,
  failed: () => void,
) {
  const [dragging, setDragging] = useState<"epub" | "unsupported" | null>(null);
  const current = useRef({ busy, drop, failed });
  current.current = { busy, drop, failed };
  useEffect(() => {
    const stop = onLibraryFileDrag((notice) => {
      if (notice.phase === "enter") {
        setDragging(notice.accepted ? "epub" : "unsupported");
      } else {
        setDragging(null);
        if (notice.phase === "drop" && notice.accepted && notice.dropId && !current.current.busy)
          void current.current.drop(notice.dropId);
      }
    });
    let depth = 0;
    const fileDrag = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!fileDrag(event)) return;
      event.preventDefault();
      depth++;
      const items = Array.from(event.dataTransfer?.items ?? []);
      const accepted = items.some(
        (item) =>
          item.kind === "file" &&
          (!item.type ||
            item.type === "application/epub+zip" ||
            item.type === "application/octet-stream"),
      );
      setDragging(accepted || !items.length ? "epub" : "unsupported");
    };
    const over = (event: DragEvent) => {
      if (!fileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = current.current.busy ? "none" : "copy";
    };
    const leave = () => {
      if (depth > 0 && --depth === 0) {
        depth = 0;
        setDragging(null);
      }
    };
    const receive = (event: DragEvent) => {
      if (!fileDrag(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(null);
      if (current.current.busy) return;
      const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
        /\.epub$/i.test(file.name),
      );
      if (!files.length) return;
      if (files.length > 2000) {
        current.current.failed();
        return;
      }
      try {
        if (!postLibraryFiles(files)) current.current.failed();
      } catch {
        current.current.failed();
      }
    };
    const clear = () => {
      depth = 0;
      setDragging(null);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", receive);
    window.addEventListener("blur", clear);
    return () => {
      stop();
      window.removeEventListener("blur", clear);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", receive);
    };
  }, []);
  return dragging;
}
