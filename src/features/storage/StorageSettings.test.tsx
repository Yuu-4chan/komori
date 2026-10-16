import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDictionaryStoreSize } from "../dictionary/dictionaryApi";
import { getLibraryStoreSize } from "../library/libraryApi";
import { StorageSettings } from "./StorageSettings";

vi.mock("../dictionary/dictionaryApi", () => ({ getDictionaryStoreSize: vi.fn() }));
vi.mock("../library/libraryApi", () => ({ getLibraryStoreSize: vi.fn() }));
vi.mock("../backup/BackupSettings", () => ({ BackupSettings: () => <h2>Backup</h2> }));

const MiB = 1024 * 1024;
const librarySize = vi.mocked(getLibraryStoreSize);
const dictionarySize = vi.mocked(getDictionaryStoreSize);

const sizeOf = (label: string) => screen.getByText(label).nextElementSibling;

describe("Storage settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    librarySize.mockResolvedValue(1800 * MiB);
    dictionarySize.mockResolvedValue(736 * MiB);
  });

  it("shows each store's size above the backups, with no manual reclaim", async () => {
    render(<StorageSettings />);
    await waitFor(() => expect(sizeOf("Library")).toHaveTextContent("1.8 GB"));
    expect(sizeOf("Dictionaries")).toHaveTextContent("736 MB");
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Disk space", "Backup"]);
    // Removing something gives its space back, so there is nothing left to reclaim by hand.
    expect(screen.queryByRole("button", { name: /Reclaim/ })).not.toBeInTheDocument();
  });

  it("says when a size is unavailable", async () => {
    librarySize.mockRejectedValue(new Error("private path"));
    render(<StorageSettings />);
    await waitFor(() => expect(sizeOf("Dictionaries")).toHaveTextContent("736 MB"));
    expect(sizeOf("Library")).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/private path/)).not.toBeInTheDocument();
  });
});
