import type { MessageKey } from "../../i18n/i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  fontChoiceKey,
  googleFontFiles,
  googleFontUrl,
  validFontFamily,
  validUploadedFont,
  validUploadedId,
  presetFonts,
  type ReaderFontChoice,
  type SystemFontFace,
} from "./fontChoices";
export interface DownloadedFont {
  id: string;
  family: string;
  available: boolean;
  url: string | null;
  /** Included with Komori: available without a download, and never removed. */
  bundled?: boolean;
  source?: "google" | "uploaded";
  familyId?: string;
  weight?: string;
  style?: "normal" | "italic";
}
interface Progress {
  operationId: string;
  id: string;
  completed: number;
  total: number;
}
interface Snapshot {
  fonts: DownloadedFont[];
  pending: string | null;
  completed: number;
  total: number;
  /** What went wrong, as a message of the interface language. */
  error: MessageKey | null;
  loaded: boolean;
}
// The installer's fonts are taken as available before the native listing confirms them, so a
// book opening at once shows them without laying out again.
const included = (f: (typeof googleFontFiles)[number]) => !!f.bundled && isTauri();
let snapshot: Snapshot = {
  fonts: googleFontFiles.map((f) => ({
    ...f,
    source: "google",
    weight: f.weight.split(" ").map(Number).join(" "),
    style: "normal",
    bundled: included(f),
    available: included(f),
    url: included(f) ? googleFontUrl(f.id)! : null,
  })),
  pending: null,
  completed: 0,
  total: 0,
  error: null,
  // Outside the desktop app there is no font list to load.
  loaded: !isTauri(),
};
const observers = new Set<() => void>();
const publish = (patch: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...patch };
  observers.forEach((fn) => fn());
};
function validList(value: DownloadedFont[]): DownloadedFont[] {
  if (!Array.isArray(value)) throw Error("Invalid font listing");
  const google: DownloadedFont[] = googleFontFiles.map((f) => {
    const row = value.find((row) => row?.id === f.id);
    const available = row?.available === true && row.url === googleFontUrl(f.id);
    return {
      id: f.id,
      familyId: f.familyId,
      family: f.family,
      source: "google",
      weight: f.weight.split(" ").map(Number).join(" "),
      style: "normal",
      bundled: available && row!.bundled === true && !!f.bundled,
      available,
      url: available ? row!.url : null,
    };
  });
  const uploads = value
    .filter(
      (f) =>
        f &&
        f.source === "uploaded" &&
        f.available === true &&
        validUploadedFont(f) &&
        f.url === `http://komori-font.localhost/uploaded/${f.id}.ttf`,
    )
    .slice(0, 128);
  return [...google, ...uploads];
}
let loading: Promise<void> | null = null;
let revision = 0;
export async function refreshReaderFonts(): Promise<void> {
  if (!isTauri()) return;
  if (loading) return loading;
  const current = revision;
  loading = invoke<DownloadedFont[]>("list_reader_fonts")
    .then((fonts) => {
      if (current === revision) publish({ fonts: validList(fonts), loaded: true, error: null });
    })
    .catch(() => {
      if (current === revision) publish({ error: "fonts.loadFailed", loaded: true });
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}
export function useReaderFonts() {
  const state = useSyncExternalStore(
    (fn) => {
      observers.add(fn);
      return () => {
        observers.delete(fn);
      };
    },
    () => snapshot,
  );
  useEffect(() => {
    if (!snapshot.loaded) void refreshReaderFonts();
  }, []);
  return state;
}
export async function checkSystemFont(
  family: string,
): Promise<{ family: string; available: boolean; faces?: SystemFontFace[] }> {
  if (!isTauri()) throw Error("System font checks require the desktop app.");
  return invoke("check_system_font", { family });
}
/**
 * Native face names let the script aliases use real local bold/italic faces: none while they
 * are read, as when a font is chosen.
 */
export function useSystemFontFaces(
  choices: readonly ReaderFontChoice[],
): SystemFontFace[] | undefined {
  const families = [
    ...new Set(
      choices.flatMap((c) =>
        c.source === "system"
          ? [c.family]
          : c.source === "preset" && !["serif", "sans-serif", "inter"].includes(c.id)
            ? [presetFonts.find((f) => f.value === c.id)!.label]
            : [],
      ),
    ),
  ]
    .sort()
    .join("\n");
  const [state, setState] = useState<{ key: string; faces: SystemFontFace[] }>({
    key: "",
    faces: [],
  });
  useEffect(() => {
    let current = true;
    void Promise.all(
      families
        ? families.split("\n").map((family) =>
            checkSystemFont(family).then(
              (r) => r.faces ?? [],
              () => [],
            ),
          )
        : [],
    ).then((faces) => {
      if (current) setState({ key: families, faces: faces.flat() });
    });
    return () => {
      current = false;
    };
  }, [families]);
  return state.key === families || !isTauri() ? state.faces : undefined;
}
/** Whether Yu Mincho, once the default Japanese font, is installed: asked once per run. */
let minchoInstalled: Promise<boolean> | null = null;
let minchoMissing: boolean | undefined;

/**
 * The Asian font a book shows. Yu Mincho comes with Windows' Japanese language support; on a
 * computer without it, a saved Yu Mincho shows as the included Zen Old Mincho instead, keeping
 * the saved choice. Any other choice is shown as chosen. None is known until the check answers.
 */
export function useAsianFontFallback(choice: ReaderFontChoice): ReaderFontChoice | undefined {
  const { fonts } = useReaderFonts();
  const isMincho = fontChoiceKey(choice) === fontChoiceKey(minchoFallback.choice) && isTauri();
  const [missing, setMissing] = useState(minchoMissing);
  useEffect(() => {
    if (!isMincho) return;
    let current = true;
    minchoInstalled ??= checkSystemFont(minchoFallback.family).then(
      (font) => font.available,
      // Unknown is not missing: the saved font is kept on a failed check.
      () => true,
    );
    void minchoInstalled.then((installed) => {
      minchoMissing = !installed;
      if (current) setMissing(!installed);
    });
    return () => {
      current = false;
    };
  }, [isMincho]);
  if (!isMincho) return choice;
  if (missing === undefined) return undefined;
  const included = fonts.some((font) => font.id === minchoFallback.id && font.available);
  return missing && included ? { source: "google", id: minchoFallback.id } : choice;
}
const minchoFallback = {
  choice: { source: "preset", id: "yu-mincho" },
  family: "Yu Mincho",
  id: "zen-old-mincho",
} as const;

let systemFonts: Promise<string[]> | null = null;
/** The font families installed on this computer, read once per run. */
export function listSystemFonts(): Promise<string[]> {
  if (!isTauri()) return Promise.reject(Error("Listing fonts requires the desktop app."));
  systemFonts ??= invoke<string[]>("list_system_fonts").then(
    (families) => families.filter((family) => validFontFamily(family)),
    (error: unknown) => {
      systemFonts = null;
      throw error;
    },
  );
  return systemFonts;
}
export async function changeDownloadedFont(id: string, action: "download" | "remove") {
  if (
    snapshot.pending ||
    snapshot.fonts.some((f) => f.id === id && f.bundled) ||
    !(googleFontFiles.some((f) => f.id === id) || (action === "remove" && validUploadedId(id)))
  )
    return;
  if (!isTauri()) {
    publish({ error: "fonts.desktopOnly" });
    return;
  }
  const operationId = crypto.randomUUID();
  revision++;
  publish({ pending: id, completed: 0, total: 0, error: null });
  let unlisten: (() => void) | undefined;
  try {
    if (action === "download")
      unlisten = await listen<Progress>("reader-font-progress", ({ payload }) => {
        if (
          payload.operationId !== operationId ||
          payload.id !== id ||
          !Number.isSafeInteger(payload.completed) ||
          !Number.isSafeInteger(payload.total) ||
          payload.total < 1 ||
          payload.completed < snapshot.completed ||
          payload.completed > payload.total
        )
          return;
        publish({ completed: payload.completed, total: payload.total });
      });
    const fonts = await invoke<DownloadedFont[]>(
      action === "download" ? "download_reader_font" : "remove_reader_font",
      action === "download" ? { id, operationId } : { id },
    );
    publish({ fonts: validList(fonts), loaded: true });
  } catch {
    publish({
      error: action === "download" ? "fonts.downloadFailed" : "fonts.removeFailed",
    });
  } finally {
    unlisten?.();
    publish({ pending: null });
  }
}

export async function importReaderFonts() {
  if (snapshot.pending) return;
  if (!isTauri()) {
    publish({ error: "fonts.desktopOnly" });
    return;
  }
  revision++;
  publish({ pending: "import", completed: 0, total: 0, error: null });
  try {
    const result = await invoke<{ fonts: DownloadedFont[]; failed: number }>("import_reader_fonts");
    publish({
      fonts: validList(result.fonts),
      loaded: true,
      error: result.failed ? "fonts.importFailed" : null,
    });
  } catch {
    publish({ error: "fonts.importFailed" });
  } finally {
    publish({ pending: null });
  }
}
