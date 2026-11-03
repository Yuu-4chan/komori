import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";

import { AppShell } from "./components/layout/AppShell";
import { DictionaryPage } from "./pages/DictionaryPage";
import { LibraryPage } from "./pages/LibraryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StatisticsPage } from "./pages/StatisticsPage";
import { getStartupBook } from "./features/startup/startupApi";
import { useLibraryImportController, LibraryImportContext } from "./features/library/libraryImport";
import { useStarterDictionaryNotifications } from "./features/dictionary/useStarterDictionaries";
import { UpdatesProvider } from "./features/updates/updates";
import { refreshReaderFonts } from "./features/reader/readerFonts";

function StartupRoute() {
  const [book, setBook] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const timeout = setTimeout(() => {
      if (active) {
        active = false;
        setBook(null);
      }
    }, 2000);
    void getStartupBook().then(
      (id) => {
        if (active) setBook(id);
      },
      () => {
        if (active) setBook(null);
      },
    );
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, []);
  if (book === undefined) return <div className="page" aria-busy="true" />;
  return <Navigate replace to={book ? `/reader/${book}` : "/library"} />;
}

// The Reader carries EPUB.js and its ZIP reader; load them only when a book is opened.
const ReaderPage = lazy(() =>
  import("./pages/ReaderPage").then((module) => ({ default: module.ReaderPage })),
);
const reader = <ReaderPage />;

// On the phone Komori draws its own frame, Library and Settings. The condition is fixed when the
// frontend is built, so the PC build leaves the mobile module out.
const mobile =
  import.meta.env.TAURI_ENV_PLATFORM === "android"
    ? {
        Shell: lazy(() => import("./mobile").then((module) => ({ default: module.MobileShell }))),
        System: lazy(() => import("./mobile").then((module) => ({ default: module.MobileSystem }))),
        Library: lazy(() =>
          import("./mobile").then((module) => ({ default: module.MobileLibraryPage })),
        ),
        Settings: lazy(() =>
          import("./mobile").then((module) => ({ default: module.MobileSettingsPage })),
        ),
      }
    : null;

// `/dictionary?q=<text>` opens the Dictionary page searching that text, as the Reader's lookup
// popup does; each query opens the page afresh.
function DictionaryRoute() {
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
  return <DictionaryPage initialQuery={query} key={query} />;
}

export function App() {
  useStarterDictionaryNotifications();
  const imports = useLibraryImportController();
  const { scanFolders } = imports;
  useEffect(() => {
    void scanFolders();
  }, [scanFolders]);
  // A book waits for the Reader's fonts before its first layout; list them before one opens.
  useEffect(() => {
    void refreshReaderFonts();
  }, []);
  return (
    <LibraryImportContext.Provider value={imports}>
      <UpdatesProvider>
        {/* Router navigations are transitions. While the Reader chunk loads, this boundary,
            already showing a page, keeps that page instead of revealing a fallback, which
            React would hold on screen for at least 300 ms. Only a first render shows it. */}
        <Suspense fallback={<div className="reader-shell" aria-busy="true" />}>
          {mobile ? <mobile.System /> : null}
          <Routes>
            <Route index element={<StartupRoute />} />
            <Route element={mobile ? <mobile.Shell /> : <AppShell />}>
              <Route path="library" element={mobile ? <mobile.Library /> : <LibraryPage />} />
              <Route path="dictionary" element={<DictionaryRoute />} />
              <Route path="statistics" element={<StatisticsPage />} />
              <Route path="settings" element={mobile ? <mobile.Settings /> : <SettingsPage />} />
              <Route path="*" element={<Navigate replace to="/library" />} />
            </Route>
            <Route path="reader" element={reader} />
            <Route path="reader/:catalogId" element={reader} />
          </Routes>
        </Suspense>
      </UpdatesProvider>
    </LibraryImportContext.Provider>
  );
}
