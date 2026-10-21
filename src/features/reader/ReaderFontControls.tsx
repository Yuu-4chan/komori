import { CaretUpDownIcon, PlusIcon } from "@phosphor-icons/react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../../components/ui/IconButton";
import { Select } from "../../components/ui/Select";
import { ChoiceCheck } from "../../components/ui/SelectionBox";
import { useI18n, type MessageKey } from "../../i18n/i18n";
import { useAppearance } from "../appearance/AppearanceProvider";
import {
  fontChoiceKey,
  fontChoiceLabel,
  googleFonts,
  presetCategories,
  presetFontLabel,
  presetFonts,
  validFontFamily,
  type FontCategory,
  type ReaderFontChoice,
  type UploadedFont,
} from "./fontChoices";
import { checkSystemFont, listSystemFonts, useReaderFonts } from "./readerFonts";
import { ReaderFontManager } from "./ReaderFontManager";
import { availableFontWeights, resolveFontWeight } from "./fontWeights";

interface FontOption {
  key: string;
  label: string;
  section: MessageKey;
  choice: ReaderFontChoice;
}

/** Generic families and the included Inter need nothing installed. */
const alwaysUsable = ["serif", "sans-serif", "inter"];

/**
 * An editable font menu: Komori's presets, included and downloaded Google Fonts, uploaded fonts
 * and installed families, with "+" opening the font manager.
 */
export function FontPicker({
  label,
  category,
  value,
  onChange,
}: {
  label: string;
  /** Which presets and Google Fonts this menu offers, and which the "+" dialog opens on. */
  category: FontCategory;
  value: ReaderFontChoice;
  onChange: (font: ReaderFontChoice) => void;
}) {
  const { fonts } = useReaderFonts();
  const { t } = useI18n();
  const uploads = fonts.filter((f) => f.source === "uploaded") as UploadedFont[];
  const chosenLabel = fontChoiceLabel(value, uploads);
  const chosenKey = fontChoiceKey(value);
  const [draft, setDraft] = useState(chosenLabel);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [manager, setManager] = useState(false);
  const [active, setActive] = useState(0);
  const navigated = useRef(false);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [installedError, setInstalledError] = useState(false);
  const [status, setStatus] = useState<MessageKey | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const labelId = useId();
  useEffect(() => setDraft(chosenLabel), [chosenLabel]);
  useEffect(() => {
    let current = true;
    if (
      value.source === "system" ||
      (value.source === "preset" && !["serif", "sans-serif", "inter"].includes(value.id))
    ) {
      const family =
        value.source === "system"
          ? value.family
          : presetFonts.find((f) => f.value === value.id)!.label;
      setStatus("fonts.checking");
      void checkSystemFont(family)
        .then((result) => {
          if (current) setStatus(result.available ? null : "fonts.notInstalled");
        })
        .catch(() => {
          if (current) setStatus("fonts.checkFailed");
        });
    } else setStatus(null);
    return () => {
      current = false;
    };
  }, [value]);
  // Read as the menu mounts, so the menu opens on the installed fonts alone.
  useEffect(() => {
    if (installed) return;
    let current = true;
    void listSystemFonts().then(
      (families) => {
        if (current) setInstalled(families);
      },
      () => {
        if (current) setInstalledError(true);
      },
    );
    return () => {
      current = false;
    };
  }, [installed]);
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (f: FontOption) => !needle || f.label.toLowerCase().includes(needle);
    const chosen = (choice: ReaderFontChoice) => fontChoiceKey(choice) === chosenKey;
    const usable = (id: string) => fonts.some((f) => (f.familyId ?? f.id) === id && f.available);
    const installedNames = new Set((installed ?? []).map((family) => family.toLowerCase()));
    // Only fonts that show as themselves: installed presets, unless the same Google font is
    // available, and the Google Fonts that are included or downloaded. The chosen font stays.
    const presetIds = [...presetCategories[category]];
    if (value.source === "preset" && !presetIds.includes(value.id)) presetIds.unshift(value.id);
    const presets: FontOption[] = presetIds
      .map((id) => presetFonts.find((f) => f.value === id)!)
      .filter(
        (f) =>
          chosen({ source: "preset", id: f.value }) ||
          alwaysUsable.includes(f.value) ||
          (!usable(f.value) && (!installed || installedNames.has(f.label.toLowerCase()))),
      )
      .map((f) => ({
        key: `preset:${f.value}`,
        label: presetFontLabel(f.value),
        section: "fonts.sectionKomori",
        choice: { source: "preset", id: f.value },
      }));
    const google: FontOption[] = googleFonts
      .filter(
        (f) => (f.category === category && usable(f.id)) || chosen({ source: "google", id: f.id }),
      )
      .map((f) => ({
        key: `google:${f.id}`,
        label: f.family,
        section: "fonts.sectionGoogle",
        choice: { source: "google", id: f.id },
      }));
    const uploaded: FontOption[] = fonts
      .filter((f) => f.source === "uploaded")
      .map((f) => ({
        key: `uploaded:${f.id}`,
        label: `${f.family} · ${f.weight}${f.style === "italic" ? " · " + t("fonts.italic") : ""}`,
        section: "fonts.sectionUploaded",
        choice: { source: "uploaded", id: f.id },
      }));
    // A family the sections above already offer is not listed again.
    const offered = new Set([...presets, ...google].map((o) => o.label.toLowerCase()));
    const families = (installed ?? []).filter((family) => !offered.has(family.toLowerCase()));
    if (value.source === "system" && !families.includes(value.family))
      families.unshift(value.family);
    const system: FontOption[] = families.map((family) => ({
      key: `system:${family}`,
      label: family,
      section: "fonts.sectionSystem",
      choice: { source: "system", family },
    }));
    return [...presets, ...google, ...uploaded, ...system.filter(matches).slice(0, 150)].filter(
      matches,
    );
  }, [category, chosenKey, fonts, installed, query, value, t]);
  function close(refocus = false) {
    setOpen(false);
    if (refocus) inputRef.current?.focus();
  }
  function show() {
    navigated.current = true;
    setRect(controlRef.current?.getBoundingClientRect() ?? null);
    setQuery("");
    setOpen(true);
  }
  function choose(option: FontOption) {
    onChange(option.choice);
    setDraft(
      option.choice.source === "uploaded" ? fontChoiceLabel(option.choice, uploads) : option.label,
    );
    close(true);
  }
  function commit() {
    if (draft === chosenLabel) return;
    const family = draft.trim();
    const exact = options.find((o) => o.label.toLowerCase() === family.toLowerCase());
    if (exact) {
      onChange(exact.choice);
      setDraft(fontChoiceLabel(exact.choice, uploads));
      return;
    }
    if (!validFontFamily(family)) {
      setDraft(chosenLabel);
      setStatus("fonts.invalidName");
      return;
    }
    onChange({ source: "system", family });
    setDraft(family);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(chosenLabel);
      close();
    } else if (event.key === "Tab") {
      commit();
      close();
    } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      navigated.current = true;
      event.preventDefault();
      if (!open) show();
      else
        setActive((index) =>
          Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))),
        );
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && navigated.current && options[active]) choose(options[active]);
      else {
        commit();
        close();
      }
    }
  }
  useEffect(
    () =>
      setActive(
        Math.max(
          0,
          options.findIndex((o) => o.key === chosenKey),
        ),
      ),
    [open, chosenKey],
  ); // oxlint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setActive(0), [query]);
  useLayoutEffect(() => {
    if (open)
      panelRef.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (
        !controlRef.current?.contains(event.target as Node) &&
        !panelRef.current?.contains(event.target as Node)
      )
        close();
    };
    const scrolled = (event: Event) => {
      if (!panelRef.current?.contains(event.target as Node)) close();
    };
    const hide = () => close();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, [open]);
  const unavailable =
    value.source === "google"
      ? !fonts.some((f) => (f.familyId ?? f.id) === value.id && f.available)
      : value.source === "uploaded" && !fonts.some((f) => f.id === value.id && f.available);
  const below = rect ? window.innerHeight - rect.bottom - 12 : 0;
  const above = rect ? rect.top - 12 : 0;
  const flip = below < 260 && above > below;
  const panelStyle: CSSProperties | undefined = rect
    ? {
        left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 272) - 8)),
        width: Math.max(rect.width, 272),
        maxHeight: Math.min(400, flip ? above : below),
        ...(flip ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      }
    : undefined;
  let previous: MessageKey | null = null;
  return (
    <div className="reader-font-field">
      <div className="select-field">
        <div className="select-field__label">
          <label id={labelId} htmlFor={`${listId}-field`}>
            {label}
          </label>
        </div>
        <div className="font-picker__controls">
          <div className="font-picker__input-control" ref={controlRef}>
            <input
              id={`${listId}-field`}
              ref={inputRef}
              role="combobox"
              aria-labelledby={labelId}
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
              value={draft}
              spellCheck={false}
              onChange={(event) => {
                navigated.current = false;
                setDraft(event.target.value);
                setQuery(event.target.value);
                setRect(controlRef.current?.getBoundingClientRect() ?? null);
                setOpen(true);
              }}
              onBlur={(event) => {
                if (
                  !panelRef.current?.contains(event.relatedTarget) &&
                  !controlRef.current?.contains(event.relatedTarget)
                ) {
                  commit();
                  close();
                }
              }}
              onKeyDown={onKeyDown}
            />
            <button
              type="button"
              aria-label={t("fonts.choose", { name: label })}
              aria-expanded={open}
              aria-haspopup="listbox"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (open) close();
                else show();
                inputRef.current?.focus();
              }}
            >
              <CaretUpDownIcon aria-hidden="true" weight="bold" />
            </button>
          </div>
          <IconButton
            label={t("fonts.manage", { name: label })}
            compact
            quiet
            onClick={() => {
              close();
              setManager(true);
            }}
          >
            <PlusIcon aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <small role="status">
        {unavailable ? t("fonts.notDownloaded", { name: chosenLabel }) : status && t(status)}
      </small>
      {open && rect
        ? createPortal(
            <div
              ref={panelRef}
              className="font-picker app-listbox"
              style={panelStyle}
              onMouseDown={(event) => event.preventDefault()}
              data-placement={flip ? "above" : "below"}
            >
              <div className="font-picker__list" id={listId} role="listbox" aria-label={label}>
                {options.map((option, index) => {
                  const heading =
                    previous !== option.section ? (
                      <div className="floating-menu__section-label" role="presentation">
                        {t(option.section)}
                      </div>
                    ) : null;
                  previous = option.section;
                  return (
                    <div key={option.key} role="presentation">
                      {heading}
                      <div
                        id={`${listId}-${index}`}
                        className="app-listbox__option font-picker__option"
                        role="option"
                        aria-selected={option.key === chosenKey}
                        data-active={index === active || undefined}
                        data-index={index}
                        onPointerMove={() => setActive(index)}
                        onClick={() => choose(option)}
                      >
                        <ChoiceCheck checked={option.key === chosenKey} />
                        <span className="font-picker__text">{option.label}</span>
                      </div>
                    </div>
                  );
                })}
                {!options.length && <p className="font-picker__note">{t("fonts.typeName")}</p>}
                {installed === null && (
                  <p className="font-picker__note">
                    {t(installedError ? "fonts.listFailed" : "fonts.finding")}
                  </p>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
      {manager && <ReaderFontManager category={category} onClose={() => setManager(false)} />}
    </div>
  );
}

export function ReaderFontControls() {
  const prefs = useAppearance();
  const { t } = useI18n();
  const { fonts } = useReaderFonts();
  const weight = (
    choice: ReaderFontChoice,
    requested: number,
    label: string,
    onChange: (weight: number) => void,
  ) => {
    const available = availableFontWeights(choice, fonts);
    return (
      <Select
        label={label}
        value={available.length ? String(resolveFontWeight(requested, available)) : ""}
        options={
          available.length
            ? available.map((w) => ({ value: String(w), label: String(w) }))
            : [{ value: "", label: "—" }]
        }
        disabled={!available.length}
        onChange={(value) => onChange(Number(value))}
      />
    );
  };
  return (
    <>
      <FontPicker
        label={t("fonts.western")}
        category="western"
        value={prefs.readerWesternFont}
        onChange={prefs.setReaderWesternFont}
      />
      {weight(
        prefs.readerWesternFont,
        prefs.readerWesternFontWeight,
        t("fonts.westernWeight"),
        prefs.setReaderWesternFontWeight,
      )}
      <FontPicker
        label={t("fonts.asian")}
        category="asian"
        value={prefs.readerAsianFont}
        onChange={prefs.setReaderAsianFont}
      />
      {weight(
        prefs.readerAsianFont,
        prefs.readerAsianFontWeight,
        t("fonts.asianWeight"),
        prefs.setReaderAsianFontWeight,
      )}
    </>
  );
}
