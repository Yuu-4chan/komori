import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppearanceProvider, useAppearance } from "../features/appearance/AppearanceProvider";
import { AppThemeSettings } from "../features/appearance/AppThemeSettings";
import {
  defaultAppearance,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "../features/appearance/appearancePreferences";
import { ReaderShell } from "../features/reader/ReaderShell";
import type { ReaderRendererFactory } from "../features/reader/renderer";
import { catalogs, i18n, I18nProvider, translatorFor, useI18n } from "./i18n";
import { interfaceLanguageNames, interfaceLanguages, type InterfaceLanguage } from "./languages";
import { en } from "./messages/en";

// The module-level translator follows the last provider rendered; start each test in English.
afterEach(() => {
  render(<I18nProvider language="en">{null}</I18nProvider>).unmount();
  document.documentElement.lang = "";
});

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();
const pluralBase = (key: string) => /^(.*)_(zero|one|two|few|many|other)$/.exec(key)?.[1];
const englishKeys = Object.keys(en);

describe("interface language catalogs", () => {
  it.each(interfaceLanguages.filter((language) => language !== "en"))(
    "%s translates every English message with the same placeholders",
    (language) => {
      const catalog = catalogs[language] as Record<string, string>;
      const rules = new Intl.PluralRules(language);
      for (const key of englishKeys) {
        const base = pluralBase(key);
        if (base) {
          // Each plural form the language uses is present; English's _one is optional otherwise.
          const form = key.slice(base.length + 1) as Intl.LDMLPluralRule;
          const needed =
            form === "other" || rules.resolvedOptions().pluralCategories.includes(form);
          if (needed) expect(catalog[key], `${language} ${key}`).toBeTruthy();
          else continue;
        } else {
          expect(catalog[key], `${language} ${key}`).toBeTruthy();
        }
        expect(placeholders(catalog[key]), `${language} ${key}`).toEqual(
          placeholders(en[key as keyof typeof en]),
        );
      }
      for (const key of Object.keys(catalog)) {
        const base = pluralBase(key);
        expect(base ? `${base}_other` in en : key in en, `${language} has unknown ${key}`).toBe(
          true,
        );
      }
    },
  );

  it("names each language in itself, using Simplified Chinese", () => {
    expect(interfaceLanguages).toEqual(["en", "ja", "zh-CN", "ko", "pt-BR"]);
    expect(interfaceLanguageNames).toEqual({
      en: "English",
      ja: "日本語",
      "zh-CN": "简体中文",
      ko: "한국어",
      "pt-BR": "Português (Brasil)",
    });
  });

  it("falls back to English for a missing message", () => {
    const ja = catalogs.ja as Record<string, string | undefined>;
    const saved = ja["common.cancel"];
    delete ja["common.cancel"];
    try {
      expect(translatorFor("ja").t("common.cancel")).toBe(en["common.cancel"]);
      expect(translatorFor("ja").t("common.close")).toBe("閉じる");
    } finally {
      ja["common.cancel"] = saved;
    }
  });

  it("chooses plural forms and formats numbers and dates per language", () => {
    const tp = (language: InterfaceLanguage, count: number) =>
      translatorFor(language).tp("images.count", count);
    expect([tp("en", 1), tp("en", 0), tp("en", 1234)]).toEqual([
      "1 image",
      "0 images",
      "1,234 images",
    ]);
    // Brazilian interfaces read zero as plural.
    expect([tp("pt-BR", 1), tp("pt-BR", 0), tp("pt-BR", 1234)]).toEqual([
      "1 imagem",
      "0 imagens",
      "1.234 imagens",
    ]);
    expect(tp("ja", 1)).toBe("1枚の画像");
    expect(tp("ko", 3)).toBe("이미지 3개");
    expect(tp("zh-CN", 2)).toBe("2张图片");
    const day = new Date(2026, 9, 5);
    const options = { year: "numeric", month: "long", day: "numeric" } as const;
    expect(translatorFor("en").date(day, options)).toBe("October 5, 2026");
    expect(translatorFor("ja").date(day, options)).toBe("2026年10月5日");
    expect(translatorFor("pt-BR").date(day, options)).toBe("5 de outubro de 2026");
    // Brazilian counts use English suffixes, with localized decimal separators.
    expect(translatorFor("en").compact(12_345_678, 1)).toBe("12.3M");
    expect(translatorFor("pt-BR").compact(12_345_678, 1)).toBe("12,3M");
    expect(translatorFor("pt-BR").compact(1_234_567_890, 1)).toBe("1,2B");
    // Brazilian durations join each unit to its number.
    expect(translatorFor("pt-BR").t("duration.hoursMinutes", { hours: 8, minutes: 20 })).toBe(
      "8h20m",
    );
    expect(translatorFor("pt-BR").compact(12_345, 1)).toBe("12,3K");
    expect(translatorFor("pt-BR").compact(23_000, 0)).toBe("23K");
    expect(translatorFor("pt-BR").compact(219_000_000, 0)).toBe("219M");
    expect(translatorFor("pt-BR").compact(999, 0)).toBe("999");
    // Language names start capitalized even where the language writes them in lowercase.
    expect(translatorFor("pt-BR").languageName("ja")).toBe("Japonês");
  });

  it("joins Japanese and Chinese counts and Latin names without extra spaces", () => {
    for (const language of ["ja", "zh-CN"] as const) {
      const translator = translatorFor(language);
      const cjk = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]";
      for (const [key, value] of Object.entries(catalogs[language])) {
        expect(value, `${language} ${key}`).not.toMatch(new RegExp(`${cjk} | ${cjk}`, "u"));
      }
      const books = translator.tp("librarySummary.books", 1);
      const characters = translator.t("librarySummary.characters", {
        count: translator.compact(94_000, 1),
      });
      expect(books).toBe(language === "ja" ? "1冊" : "1本书");
      expect(characters).toBe("9.4万字");
      expect(translator.t("settings.description")).toContain(
        language === "ja" ? "てKomoriを" : "让Komori适合",
      );
    }
    // Korean uses word spacing, but count suffixes and grammatical particles stay attached.
    expect(translatorFor("ko").tp("librarySummary.books", 1)).toBe("책 1권");
    expect(translatorFor("ko").t("settings.description")).toContain("Komori를");
  });

  it("formats a values placeholder in the language", () => {
    expect(translatorFor("pt-BR").t("search.tooLong", { count: 1200 })).toBe(
      "Use no máximo 1.200 caracteres.",
    );
    expect(i18n().language).toBe("en");
  });

  it("keeps hints to one clause and drops those their label already says", () => {
    const hints = [
      "autoscroll.hint",
      "librarySettings.cardSizeHint",
      "dictionaryPage.emptyDescription",
      "statistics.dailyHint",
      "ankiSettings.duplicatesHint",
      "reader.escapeAgain",
      "library.removeDescription",
      "library.bulkDescription_other",
    ];
    for (const language of interfaceLanguages) {
      const catalog = catalogs[language] as Record<string, string>;
      for (const key of hints) {
        // One sentence: no sentence break before the closing stop.
        expect(catalog[key].replace(/[.。]$/, ""), `${language} ${key}`).not.toMatch(
          /[.。?？](\s|$)|[.?] /,
        );
      }
      for (const key of [
        "startup.launchAtStartupHint",
        "startup.restoreLastBookHint",
        "startup.rememberWindowSizeHint",
        "fonts.available",
        "series.metadataHint",
      ])
        expect(catalog[key], `${language} ${key}`).toBeUndefined();
    }
  });

  it("never names Yomitan in interface text", () => {
    for (const language of interfaceLanguages)
      for (const [key, text] of Object.entries(catalogs[language]))
        expect(text, `${language} ${key}`).not.toMatch(/yomitan/i);
  });
});

describe("interface language preference", () => {
  it("keeps English by default and rejects anything but a listed language", () => {
    expect(defaultAppearance.interfaceLanguage).toBe("en");
    for (const language of interfaceLanguages)
      expect(normalizeAppearancePreferences({ interfaceLanguage: language })).toEqual({
        interfaceLanguage: language,
      });
    for (const invalid of ["zh-TW", "fr", "JA", "", null, 1, {}])
      expect(normalizeAppearancePreferences({ interfaceLanguage: invalid })).toEqual({});
  });

  it("restores the saved language before anything renders, without saving", async () => {
    let finish!: (value: Partial<AppearancePreferences>) => void;
    const save = vi.fn(async () => {});
    render(
      <AppearanceProvider
        store={{ load: () => new Promise((resolve) => (finish = resolve)), save }}
      >
        <AppThemeSettings />
      </AppearanceProvider>,
    );
    expect(screen.queryByLabelText(en["appearance.language"])).not.toBeInTheDocument();
    await act(async () => finish({ interfaceLanguage: "ko" }));
    expect(screen.getByLabelText(catalogs.ko["appearance.language"]!)).toHaveValue("ko");
    expect(document.documentElement.lang).toBe("ko");
    expect(i18n().language).toBe("ko");
    expect(save).not.toHaveBeenCalled();
  });

  it("switches the interface at once from Settings and saves the choice", async () => {
    const user = userEvent.setup();
    let saved: Partial<AppearancePreferences> = {};
    const save = vi.fn(async (value: AppearancePreferences) => {
      saved = value;
    });
    render(
      <AppearanceProvider store={{ load: async () => saved, save }}>
        <AppThemeSettings />
      </AppearanceProvider>,
    );
    const select = await screen.findByLabelText("Application language");
    expect(select).toHaveValue("en");
    expect(document.documentElement.lang).toBe("en");
    for (const language of ["ja", "zh-CN", "ko", "pt-BR", "en"] as const) {
      await user.selectOptions(
        screen.getByRole("combobox", {
          name: translatorFor(i18n().language).t("appearance.language"),
        }),
        language,
      );
      const label = translatorFor(language).t("appearance.language");
      expect(screen.getByLabelText(label)).toHaveValue(language);
      expect(
        screen.getByRole("heading", { name: translatorFor(language).t("appearance.title") }),
      ).toBeInTheDocument();
      expect(document.documentElement.lang).toBe(language);
      await waitFor(() => expect(saved.interfaceLanguage).toBe(language));
    }
  });

  it("changes the Reader's language in place, keeping the open book", async () => {
    const mount = vi.fn(async (...args: Parameters<ReturnType<ReaderRendererFactory>["mount"]>) => {
      args[6]?.({ unit: "characters", current: 25, total: 100, chapter: { current: 3, total: 9 } });
      return "ready" as const;
    });
    const dispose = vi.fn();
    const setPresentation = vi.fn(async () => {});
    const factory: ReaderRendererFactory = () => ({
      mount,
      setPresentation,
      advancePage: vi.fn(async () => {}),
      retreatPage: vi.fn(async () => {}),
      dispose,
    });
    function Switch({ language }: { language: InterfaceLanguage }) {
      const { setInterfaceLanguage } = useAppearance();
      return <button onClick={() => setInterfaceLanguage(language)}>{`to ${language}`}</button>;
    }
    function Status() {
      return <span data-testid="status">{useI18n().t("readerStatus.ready")}</span>;
    }
    render(
      <MemoryRouter>
        <AppearanceProvider store={{ load: async () => ({}), save: vi.fn(async () => {}) }}>
          <Switch language="ja" />
          <Status />
          <ReaderShell rendererFactory={factory} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await screen.findAllByText("Reader ready");
    expect(screen.getByRole("button", { name: "Reader appearance" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "to ja" }));
    expect(
      screen.getByRole("button", { name: catalogs.ja["sidebar.readerAppearance"]! }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent(catalogs.ja["readerStatus.ready"]!);
    expect(mount).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(setPresentation).not.toHaveBeenCalled();
  });
});
