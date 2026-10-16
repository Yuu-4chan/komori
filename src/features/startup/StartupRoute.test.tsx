import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { AppearanceProvider } from "../appearance/AppearanceProvider";
import { getStartupBook } from "./startupApi";
import { scanLibraryFolders } from "../library/libraryApi";
vi.mock("./startupApi", async (original) => ({
  ...(await original<typeof import("./startupApi")>()),
  getStartupBook: vi.fn(),
}));
vi.mock("../library/libraryApi", async (original) => ({
  ...(await original<typeof import("../library/libraryApi")>()),
  scanLibraryFolders: vi.fn(async () => []),
  listLibrary: vi.fn(async () => []),
  getLibraryBook: vi.fn(async () => null),
}));

const ID = "11111111-1111-4111-8111-111111111111";
function Location() {
  return <output aria-label="Route">{useLocation().pathname}</output>;
}
function mount(route = "/") {
  render(
    <MemoryRouter initialEntries={[route]}>
      <AppearanceProvider store={null}>
        <App />
        <Location />
      </AppearanceProvider>
    </MemoryRouter>,
  );
}
describe("Startup destination", () => {
  beforeEach(() => vi.clearAllMocks());
  it("reopens the native last catalog ID and scans folders even without the application shell", async () => {
    vi.mocked(getStartupBook).mockResolvedValue(ID);
    mount();
    await waitFor(() => expect(screen.getByLabelText("Route")).toHaveTextContent(`/reader/${ID}`));
    expect(scanLibraryFolders).toHaveBeenCalledTimes(1);
  });
  it.each([null, "failure"])(
    "opens the Library for disabled/missing/removed state or a failed native read (%s)",
    async (result) => {
      if (result === "failure") vi.mocked(getStartupBook).mockRejectedValue(Error("failed"));
      else vi.mocked(getStartupBook).mockResolvedValue(null);
      mount();
      await waitFor(() => expect(screen.getByLabelText("Route")).toHaveTextContent("/library"));
    },
  );
  it("preserves a direct route", async () => {
    mount("/settings?section=general");
    expect(screen.getByLabelText("Route")).toHaveTextContent("/settings");
    expect(getStartupBook).not.toHaveBeenCalled();
  });
});
