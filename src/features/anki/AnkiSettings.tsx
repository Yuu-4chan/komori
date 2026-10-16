import { ToggleSetting } from "../../components/ui/ToggleSetting";
import {
  CardsIcon,
  CaretDownIcon,
  CaretUpDownIcon,
  CheckIcon,
  CircleNotchIcon,
  FloppyDiskIcon,
  PencilSimpleIcon,
  PlugsConnectedIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { listDictionaries, type DictionarySummary } from "../dictionary/dictionaryApi";
import { dictionariesChanged } from "../dictionary/sourcePolicy";
import lapisLicense from "../../../src-tauri/vendor/lapis/LICENSE.txt?raw";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { IconButton } from "../../components/ui/IconButton";
import { i18n, useI18n, type MessageKey } from "../../i18n/i18n";
import {
  ankiError,
  createLapis,
  discoverAnki,
  defaultDuplicateScope,
  loadAnki,
  lowercaseAnkiTags,
  saveAnki,
  type AnkiDiscovery,
  type AnkiPreferences,
} from "./ankiApi";
import { checkNote, pendingRequests, type PendingRequest } from "./ankiApi";
import {
  configurationProblem,
  currentMapping,
  lapisDefaults,
  placeholders,
  tagProblem,
  validTemplate,
} from "./templates";

/** A status written when shown, so it follows the interface language. */
type Message = () => string;
const say =
  (key: MessageKey, values?: Record<string, string | number>): Message =>
  () =>
    i18n().t(key, values);

export function AnkiSettings() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<AnkiPreferences | null>(null);
  const [discovery, setDiscovery] = useState<AnkiDiscovery | null>(null);
  const [connection, setConnection] = useState<
    "checking" | "connected" | "disconnected" | "unchecked"
  >("checking");
  const [dictionaries, setDictionaries] = useState<DictionarySummary[]>([]);
  const [dictionaryFailed, setDictionaryFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [saveMessage, setSaveMessage] = useState<Message>(() => () => "");
  const saveStatusId = useId();
  const fieldId = useId();
  const [message, setMessage] = useState<Message>(() => say("ankiSettings.loading"));
  const [offer, setOffer] = useState(false);
  const [declined, setDeclined] = useState(false);
  const revision = useRef(0);
  const operation = useRef(false);
  useEffect(() => {
    operation.current = false;
    const id = ++revision.current;
    loadAnki().then(
      (value) => {
        if (revision.current === id) {
          setPrefs(lowercaseAnkiTags(value));
          void test(value);
        }
      },
      (error) => {
        if (revision.current === id) {
          setConnection("disconnected");
          setMessage(() => () => ankiError(error));
        }
      },
    );
    return () => {
      revision.current++;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const reload = () =>
      listDictionaries().then(
        (items) => {
          if (active) {
            setDictionaries(items.filter((d) => d.hasDefinitions || d.hasFrequency));
            setDictionaryFailed(false);
          }
        },
        () => {
          if (active) setDictionaryFailed(true);
        },
      );
    void reload();
    window.addEventListener(dictionariesChanged, reload);
    return () => {
      active = false;
      window.removeEventListener(dictionariesChanged, reload);
    };
  }, []);
  function update(next: AnkiPreferences, invalidate = false) {
    if (operation.current) return;
    revision.current++;
    setPrefs(next);
    setSaveState("idle");
    setSaveMessage(() => () => "");
    if (invalidate) {
      setDiscovery(null);
      setConnection("unchecked");
      setMessage(() => say("ankiSettings.testToContinueChoices"));
      setDeclined(false);
    }
  }
  async function test(next: AnkiPreferences) {
    if (operation.current) return;
    operation.current = true;
    const id = ++revision.current;
    setBusy(true);
    setConnection("checking");
    setDiscovery(null);
    // The connection pill says it is checking, then connected; only what it cannot say is shown.
    setMessage(() => () => "");
    try {
      const data = await discoverAnki(next);
      if (revision.current !== id) return;
      setDiscovery(data);
      setConnection("connected");
      setMessage(() =>
        data.decks.length && data.models.length ? () => "" : say("ankiSettings.connectedEmpty"),
      );
    } catch (error) {
      if (revision.current === id) {
        setConnection("disconnected");
        setMessage(() => () => ankiError(error));
      }
    } finally {
      if (revision.current === id) {
        operation.current = false;
        setBusy(false);
      }
    }
  }
  async function persist() {
    if (!prefs || !discovery || configurationProblem(prefs, discovery) || operation.current) return;
    operation.current = true;
    const id = ++revision.current;
    setBusy(true);
    setSaveState("saving");
    setSaveMessage(() => say("ankiSettings.saving"));
    try {
      await saveAnki(prefs);
      if (id === revision.current) {
        setSaveState("saved");
        setSaveMessage(() => say("ankiSettings.saved"));
      }
    } catch (error) {
      if (id === revision.current) {
        setSaveState("failed");
        setSaveMessage(() => () => `${i18n().t("ankiSettings.saveFailed")} ${ankiError(error)}`);
      }
    } finally {
      if (id === revision.current) {
        operation.current = false;
        setBusy(false);
      }
    }
  }
  async function acceptLapis() {
    if (!prefs || operation.current) return;
    operation.current = true;
    const id = ++revision.current;
    setBusy(true);
    try {
      const outcome = await createLapis(prefs);
      if (id !== revision.current) return;
      setOffer(false);
      const data = await discoverAnki(prefs);
      if (id !== revision.current) return;
      setDiscovery(data);
      setMessage(() =>
        say(outcome === "uncertain" ? "ankiSettings.lapisUncertain" : "ankiSettings.lapisReady"),
      );
    } catch (error) {
      if (id === revision.current) {
        setOffer(false);
        setDiscovery(null);
        setMessage(() => () => `${ankiError(error)} ${i18n().t("ankiSettings.lapisRetry")}`);
      }
    } finally {
      if (id === revision.current) {
        operation.current = false;
        setBusy(false);
      }
    }
  }
  if (!prefs)
    return (
      <Card>
        <h2>{t("settings.anki")}</h2>
        <p role="status">{message()}</p>
        <Button
          onClick={() => {
            const id = ++revision.current;
            loadAnki().then(
              (value) => {
                if (id === revision.current) {
                  setPrefs(lowercaseAnkiTags(value));
                  setMessage(() => say("ankiSettings.testToContinue"));
                }
              },
              (error) => {
                if (id === revision.current) setMessage(() => () => ankiError(error));
              },
            );
          }}
        >
          {t("ankiSettings.retryLoading")}
        </Button>
      </Card>
    );
  const mapping = prefs.mappings[prefs.model];
  const problem = discovery
    ? configurationProblem(prefs, discovery)
    : t("ankiSettings.testBeforeSaving");
  // A deck or note type not chosen yet only keeps Save disabled; the problem text is for a
  // saved one Anki no longer has, or for anything wrong once both are chosen.
  const shownProblem = discovery && (!prefs.deck || !prefs.model) ? null : problem;
  const options = (items: string[], saved: string) => [
    { value: "", label: t("ankiSettings.choose") },
    ...(!items.includes(saved) && saved
      ? [{ value: saved, label: t("ankiSettings.unavailable", { name: saved }) }]
      : []),
    ...items.map((value) => ({ value, label: value })),
  ];
  return (
    <div className="settings-popup anki-settings">
      <InterruptedRequests />

      <Card className="settings-card settings-card--wide">
        <div className="anki-heading">
          <div className="settings-card__heading">
            <span className="settings-card__icon">
              <PlugsConnectedIcon aria-hidden="true" weight="duotone" />
            </span>
            <div>
              <h2>{t("ankiSettings.connectionTitle")}</h2>
              <p>{t("ankiSettings.connectionDescription")}</p>
            </div>
          </div>
          <span className={`anki-connection anki-connection--${connection}`} role="status">
            {t(
              connection === "checking"
                ? "ankiSettings.checking"
                : connection === "connected"
                  ? "ankiSettings.connected"
                  : connection === "disconnected"
                    ? "ankiSettings.disconnected"
                    : "ankiSettings.unchecked",
            )}
          </span>
        </div>
        <div className="settings-list">
          <div className="settings-field">
            <div className="text-field">
              <label className="text-field__label" htmlFor={`${fieldId}-port`}>
                {t("ankiSettings.port")}
              </label>
              <input
                id={`${fieldId}-port`}
                className="text-field__input"
                type="number"
                min="1"
                max="65535"
                spellCheck={false}
                value={prefs.port || ""}
                disabled={busy}
                onChange={(event) => update({ ...prefs, port: Number(event.target.value) }, true)}
              />
            </div>
            <p className="settings-field__hint">{t("ankiSettings.portHint")}</p>
          </div>
          <div className="settings-field">
            <div className="text-field">
              <label className="text-field__label" htmlFor={`${fieldId}-key`}>
                {t("ankiSettings.key")}
              </label>
              <input
                id={`${fieldId}-key`}
                className="text-field__input"
                type="password"
                maxLength={256}
                autoComplete="off"
                spellCheck={false}
                value={prefs.key}
                disabled={busy}
                onChange={(event) => update({ ...prefs, key: event.target.value }, true)}
              />
            </div>
            <p className="settings-field__hint">{t("ankiSettings.keyHint")}</p>
          </div>
          <div className="settings-row">
            <div>
              <strong>{t("ankiSettings.test")}</strong>
              <span>{t("ankiSettings.testHint")}</span>
            </div>
            <Button
              tone="secondary"
              disabled={
                busy || !Number.isInteger(prefs.port) || prefs.port < 1 || prefs.port > 65535
              }
              onClick={() => void test(prefs)}
            >
              {connection === "checking" ? t("ankiSettings.testingButton") : t("ankiSettings.test")}
            </Button>
          </div>
        </div>
        <p className={message() ? "anki-status" : "visually-hidden"} role="status">
          {message()}
        </p>
        <details className="settings-disclosure">
          <summary>
            <CaretDownIcon aria-hidden="true" weight="bold" />
            {t("ankiSettings.lapisSource")}
          </summary>
          <div className="settings-disclosure__body">
            <p>{t("ankiSettings.lapisCredits")}</p>
            <pre>{lapisLicense}</pre>
          </div>
        </details>
      </Card>
      {discovery && (
        <Card className="settings-card settings-card--wide">
          <div className="settings-card__heading">
            <span className="settings-card__icon">
              <CardsIcon aria-hidden="true" weight="duotone" />
            </span>
            <div>
              <h2>{t("ankiSettings.cardTitle")}</h2>
              <p>{t("ankiSettings.cardDescription")}</p>
            </div>
          </div>
          <fieldset disabled={busy} className="anki-controls">
            <div className="settings-list">
              <div className="settings-field">
                <Select
                  label={t("ankiSettings.deck")}
                  value={prefs.deck}
                  options={options(discovery.decks, prefs.deck)}
                  onChange={(deck) =>
                    update({ ...prefs, deck, deckId: discovery.deckIds[deck] ?? null })
                  }
                />
                <p className="settings-field__hint">{t("ankiSettings.deckHint")}</p>
              </div>
              {discovery.decks.includes(prefs.deck) &&
                prefs.deckId !== discovery.deckIds[prefs.deck] && (
                  <div className="settings-row">
                    <div>
                      <strong>{t("ankiSettings.deckChanged")}</strong>
                      <span>{t("ankiSettings.deckChangedHint", { deck: prefs.deck })}</span>
                    </div>
                    <Button
                      onClick={() => update({ ...prefs, deckId: discovery.deckIds[prefs.deck] })}
                    >
                      {t("ankiSettings.acceptDeck")}
                    </Button>
                  </div>
                )}
              <div className="settings-field">
                <Select
                  label={t("ankiSettings.model")}
                  value={prefs.model}
                  options={options(discovery.models, prefs.model)}
                  onChange={(model) => {
                    const next = { ...prefs, model };
                    update(next, true);
                    void test(next);
                  }}
                />
                <p className="settings-field__hint">{t("ankiSettings.modelHint")}</p>
              </div>
            </div>
            {discovery.lapis === "missing" && !declined && (
              <div>
                <p>{t("ankiSettings.lapisMissing")}</p>
                <Button onClick={() => setOffer(true)}>
                  {t("ankiSettings.createLapisEllipsis")}
                </Button>{" "}
                <Button tone="secondary" onClick={() => setDeclined(true)}>
                  {t("ankiSettings.useAnother")}
                </Button>
              </div>
            )}
            {discovery.lapis === "incompatible" && <p>{t("ankiSettings.lapisIncompatible")}</p>}
            {discovery.fields.length > 0 && (
              <div className="anki-section-heading">
                <div>
                  <h3>{t("ankiSettings.fieldContents")}</h3>
                  <p className="settings-note">{t("ankiSettings.fieldContentsHint")}</p>
                </div>
                {(!mapping ||
                  mapping.modelId !== discovery.modelIds[prefs.model] ||
                  JSON.stringify(mapping.fields) !== JSON.stringify(discovery.fields)) && (
                  <Button
                    onClick={() =>
                      update({
                        ...prefs,
                        mappings: {
                          ...prefs.mappings,
                          [prefs.model]: currentMapping(
                            discovery.fields,
                            mapping,
                            discovery.modelIds[prefs.model],
                          ),
                        },
                      })
                    }
                  >
                    {t("ankiSettings.acceptFields")}
                  </Button>
                )}
                {prefs.model === "Lapis" && discovery.lapis === "compatible" && (
                  <Button
                    tone="secondary"
                    onClick={() =>
                      update({
                        ...prefs,
                        mappings: {
                          ...prefs.mappings,
                          Lapis: {
                            ...lapisDefaults(discovery.fields, discovery.modelIds.Lapis),
                            ...(mapping?.tags ? { tags: mapping.tags } : {}),
                            ...(mapping?.tagDictionaries
                              ? { tagDictionaries: mapping.tagDictionaries }
                              : {}),
                          },
                        },
                      })
                    }
                  >
                    {t("ankiSettings.applyLapis")}
                  </Button>
                )}
              </div>
            )}
            {mapping && (
              <div className="anki-mappings">
                {dictionaryFailed && <p role="status">{t("ankiSettings.dictionariesFailed")}</p>}
                {mapping.fields.map((field) => (
                  <TemplateField
                    key={field}
                    field={field}
                    value={mapping.templates[field] ?? ""}
                    dictionaries={dictionaries.filter((d) => d.hasDefinitions)}
                    onChange={(value) =>
                      update({
                        ...prefs,
                        mappings: {
                          ...prefs.mappings,
                          [prefs.model]: {
                            ...mapping,
                            templates: { ...mapping.templates, [field]: value },
                          },
                        },
                      })
                    }
                  />
                ))}
                <TagsField
                  key={prefs.model}
                  tags={mapping.tags ?? ["komori"]}
                  selected={mapping.tagDictionaries ?? []}
                  dictionaries={dictionaries}
                  onSelect={(tagDictionaries) =>
                    update({
                      ...prefs,
                      mappings: {
                        ...prefs.mappings,
                        [prefs.model]: { ...mapping, tagDictionaries },
                      },
                    })
                  }
                  onChange={(tags) =>
                    update({
                      ...prefs,
                      mappings: { ...prefs.mappings, [prefs.model]: { ...mapping, tags } },
                    })
                  }
                />
              </div>
            )}
            <div className="anki-duplicate-settings">
              <h3>{t("ankiSettings.duplicates")}</h3>
              <div className="settings-list">
                <div className="settings-field">
                  <Select
                    label={t("ankiSettings.duplicatePolicy")}
                    value={prefs.duplicatePolicy ?? "prevent"}
                    options={[
                      { value: "prevent", label: t("ankiSettings.prevent") },
                      { value: "overwrite", label: t("ankiSettings.overwrite") },
                      { value: "allow", label: t("ankiSettings.allow") },
                    ]}
                    onChange={(duplicatePolicy) => update({ ...prefs, duplicatePolicy })}
                  />
                </div>
                <div className="settings-field">
                  <Select
                    label={t("ankiSettings.duplicateScope")}
                    value={prefs.duplicateScope ?? defaultDuplicateScope}
                    options={[
                      { value: "deck", label: t("ankiSettings.scopeDeck") },
                      { value: "collection", label: t("ankiSettings.scopeCollection") },
                    ]}
                    onChange={(duplicateScope) => update({ ...prefs, duplicateScope })}
                  />
                </div>
                {(prefs.duplicateScope ?? defaultDuplicateScope) === "deck" && (
                  <ToggleSetting
                    label={t("ankiSettings.children")}
                    description={t("ankiSettings.childrenHint")}
                    checked={prefs.checkChildren ?? false}
                    disabled={busy}
                    onChange={(checkChildren) => update({ ...prefs, checkChildren })}
                  />
                )}
              </div>
              <p className="settings-note">{t("ankiSettings.duplicatesHint")}</p>
            </div>
          </fieldset>
          <div
            className="anki-save-bar"
            data-state={shownProblem ? "invalid" : saveState}
            aria-busy={saveState === "saving"}
          >
            <p
              id={saveStatusId}
              className={!shownProblem && saveState !== "failed" ? "visually-hidden" : undefined}
              role={saveState === "failed" && !shownProblem ? "alert" : "status"}
            >
              {shownProblem ?? saveMessage()}
            </p>
            <Button
              disabled={busy || !!problem}
              aria-describedby={saveStatusId}
              icon={
                saveState === "saving" ? (
                  <CircleNotchIcon aria-hidden="true" />
                ) : saveState === "saved" ? (
                  <CheckIcon aria-hidden="true" />
                ) : (
                  <FloppyDiskIcon aria-hidden="true" />
                )
              }
              onClick={() => void persist()}
            >
              {saveState === "saving" ? t("ankiSettings.savingButton") : t("ankiSettings.save")}
            </Button>
          </div>
        </Card>
      )}
      <ConfirmDialog
        open={offer}
        title={t("ankiSettings.createLapisTitle")}
        description={t("ankiSettings.createLapisDescription")}
        dialogRole="dialog"
        confirmTone="primary"
        confirmLabel={t("ankiSettings.createLapis")}
        busy={busy}
        onCancel={() => {
          setOffer(false);
          setDeclined(true);
        }}
        onConfirm={() => void acceptLapis()}
      >
        <p>
          <a href="https://github.com/donkuri/lapis/tree/f4eb29bd4129ae1dde068c64cf6557b7603462dc">
            {t("ankiSettings.upstream")}
          </a>{" "}
          ·{" "}
          <a href="https://github.com/donkuri/lapis/blob/f4eb29bd4129ae1dde068c64cf6557b7603462dc/LICENSE">
            {t("ankiSettings.license")}
          </a>
          . {t("ankiSettings.pinned", { commit: "f4eb29b" })}
        </p>
      </ConfirmDialog>
    </div>
  );
}

const contentLabels: Record<(typeof placeholders)[number], MessageKey> = {
  expression: "ankiContent.expression",
  reading: "ankiContent.reading",
  expressionFurigana: "ankiContent.expressionFurigana",
  definition: "ankiContent.definition",
  glossary: "ankiContent.glossary",
  source: "ankiContent.source",
  frequency: "ankiContent.frequency",
  frequencyHarmonic: "ankiContent.frequencyHarmonic",
  frequencyAverage: "ankiContent.frequencyAverage",
  pitch: "ankiContent.pitch",
  sentence: "ankiContent.sentence",
  bookTitle: "ankiContent.bookTitle",
  picture: "ankiContent.picture",
  selectionText: "ankiContent.selectionText",
  audio: "ankiContent.audio",
};
function TemplateField({
  field,
  value,
  dictionaries,
  onChange,
}: {
  field: string;
  value: string;
  dictionaries: DictionarySummary[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const { t } = useI18n();
  const [writing, setWriting] = useState(false);
  const choices = [
    { value: "custom", label: t("ankiSettings.custom") },
    { value: "", label: t("ankiSettings.empty") },
    ...placeholders.map((p) => ({ value: `{{${p}}}`, label: t(contentLabels[p]) })),
    ...dictionaries.map((d) => ({
      value: `{{dictionary:${d.id}}}`,
      label: d.title,
    })),
  ];
  if (/^\{\{dictionary:\d+\}\}$/.test(value) && !choices.some((c) => c.value === value))
    choices.push({ value, label: t("ankiSettings.unavailableDictionary") });
  const selected = writing ? "custom" : choices.some((c) => c.value === value) ? value : "custom";
  return (
    <div className={`anki-mapping-row${value ? "" : " anki-mapping-row--empty"}`}>
      <span aria-hidden="true" className="anki-mapping-row__field" title={field}>
        {field}
      </span>
      <span className="select-control">
        <select
          aria-label={t("ankiSettings.contentFor", { field })}
          value={selected}
          onChange={(event) => {
            const choice = event.target.value;
            setWriting(choice === "custom");
            if (choice !== "custom") onChange(choice);
          }}
        >
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <CaretUpDownIcon aria-hidden="true" weight="bold" />
      </span>
      <IconButton
        className="anki-mapping-row__edit"
        label={t("ankiSettings.editTemplate", { field })}
        aria-expanded={writing}
        onClick={() => setWriting(!writing)}
      >
        <PencilSimpleIcon aria-hidden="true" size={16} />
      </IconButton>
      <div
        className="anki-field anki-template-editor"
        hidden={!writing && choices.some((c) => c.value === value)}
      >
        <label htmlFor={id}>{t("ankiSettings.template", { field })}</label>
        <textarea
          id={id}
          rows={2}
          maxLength={4096}
          value={value}
          aria-invalid={!validTemplate(value)}
          onChange={(event) => {
            setWriting(true);
            onChange(event.target.value);
          }}
        />
      </div>
      {!validTemplate(value) && <small>{t("ankiSettings.templateInvalid")}</small>}
    </div>
  );
}
function TagsField({
  tags,
  selected,
  dictionaries,
  onChange,
  onSelect,
}: {
  tags: string[];
  selected: number[];
  dictionaries: DictionarySummary[];
  onChange: (tags: string[]) => void;
  onSelect: (selected: number[]) => void;
}) {
  const [draft, setDraft] = useState(tags.join(" ").toLowerCase());
  const id = useId();
  const { t } = useI18n();
  return (
    <div className="anki-mapping-row anki-field anki-tags">
      <label className="anki-mapping-row__field" htmlFor={id}>
        {t("ankiSettings.tags")}
      </label>
      <input
        id={id}
        aria-describedby={`${id}-help`}
        aria-invalid={!!tagProblem(tags)}
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          const value = event.target.value.toLowerCase();
          setDraft(value);
          onChange([...new Set(value.split(/\s+/u).filter(Boolean))]);
        }}
      />
      <div className="anki-tag-options">
        <small id={`${id}-help`}>{t("ankiSettings.tagsHint")}</small>
        <Select
          label={t("ankiSettings.addDictionaryTag")}
          value=""
          options={[
            { value: "", label: t("ankiSettings.chooseDictionary") },
            ...dictionaries
              .filter((d) => selected.length < 32 && !selected.includes(d.id))
              .map((d) => ({
                value: String(d.id),
                label: t(d.hasFrequency ? "ankiSettings.tagValues" : "ankiSettings.tagName", {
                  title: d.title,
                }),
              })),
          ]}
          onChange={(value) => {
            if (value && selected.length < 32) onSelect([...selected, Number(value)]);
          }}
        />
        {selected.length > 0 && (
          <ul className="anki-dictionary-tags">
            {selected.map((dictionaryId) => {
              const dictionary = dictionaries.find((d) => d.id === dictionaryId);
              const title =
                dictionary?.title ??
                t("ankiSettings.unavailableDictionaryId", { id: dictionaryId });
              return (
                <li key={dictionaryId}>
                  <Button
                    tone="secondary"
                    aria-label={t("ankiSettings.removeTag", { title })}
                    title={title}
                    onClick={() => onSelect(selected.filter((id) => id !== dictionaryId))}
                  >
                    {title} ×
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <small>{t("ankiSettings.dictionaryTagsHint")}</small>
      </div>
    </div>
  );
}
function InterruptedRequests() {
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [message, setMessage] = useState<Message>(() => () => "");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const { t } = useI18n();
  const checking = useRef(false);
  useEffect(() => {
    active.current = true;
    pendingRequests().then(
      (result) => {
        if (active.current) setRequests(result);
      },
      () => {
        if (active.current) setMessage(() => say("ankiSettings.requestsFailed"));
      },
    );
    return () => {
      active.current = false;
    };
  }, []);
  async function check(request: PendingRequest) {
    if (checking.current) return;
    checking.current = true;
    setBusy(true);
    try {
      const result = await checkNote(request.requestId);
      if (!active.current) return;
      if (result.status === "created" || result.status === "updated") {
        setRequests((current) => current.filter((r) => r.requestId !== request.requestId));
        setMessage(() => say("ankiSettings.confirmed", { id: String(result.id) }));
      } else setMessage(() => say("ankiSettings.stillUncertain"));
    } catch (error) {
      if (active.current) setMessage(() => () => ankiError(error));
    } finally {
      checking.current = false;
      if (active.current) setBusy(false);
    }
  }
  if (!requests.length && !message()) return null;
  return (
    <Card className="settings-card settings-card--wide">
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <WarningCircleIcon aria-hidden="true" weight="duotone" />
        </span>
        <div>
          <h2>{t("ankiSettings.requestsTitle")}</h2>
          <p>{t("ankiSettings.requestsDescription")}</p>
        </div>
      </div>
      {requests.length > 0 && (
        <div className="settings-list">
          {requests.map((request) => (
            <div className="settings-row" key={request.requestId}>
              <div>
                <strong>
                  {request.model} · {request.expression}
                </strong>
                <span>
                  {t("ankiSettings.requestTag", { tag: `komori_request_${request.requestId}` })}
                </span>
              </div>
              <Button disabled={busy} tone="secondary" onClick={() => void check(request)}>
                {t("ankiSettings.checkOutcome", { expression: request.expression })}
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="settings-note" role="status">
        {message()}
      </p>
    </Card>
  );
}
